import 'server-only';
import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import net from 'net';
import { getAllowedRootsConfigPath, getCTXRoot } from '@/lib/config';
import { claimAttachments, MAX_FILE_BYTES, saveAttachment, type Attachment } from './attachments';

// send_file (D 2026-10-28; CTRL Flow 2026-10-26): an agent puts a file into the conversation it is answering: pictures, PDFs, Excel/Word/
// PowerPoint and text files, the same kinds a person can attach. The file is stored like an attachment of the person the run is for (their
// own, encrypted) and shown under the agent's answer. From `content` (text it wrote), a public `url`, or a `path` on this server inside the
// agents' folders (CTX_ROOT, the agents' workspace /srv/fleet-work, the browser's screenshots, Settings › Allowed roots).

const g = globalThis as unknown as { __aiSentFiles?: Map<number, Attachment[]> };
const sent = (g.__aiSentFiles ??= new Map());
/** The files sent in a conversation since the last call (the chat route puts them on the answer). */
export function takeSentFiles(threadId: number): Attachment[] {
  const f = sent.get(threadId) ?? [];
  sent.delete(threadId);
  return f;
}

const EXT_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' };
const typeOf = (name: string, given = '') => given.split(';')[0].trim() || EXT_TYPE[name.split('.').pop()?.toLowerCase() ?? ''] || 'text/plain';

function roots(): string[] {
  let extra: string[] = [];
  try { extra = (JSON.parse(fs.readFileSync(getAllowedRootsConfigPath(), 'utf-8')).additional_roots ?? []) as string[]; } catch { /* none */ }
  return [getCTXRoot(), '/srv/fleet-work', '/tmp/agent-browser', ...extra].map((r) => { try { return fs.realpathSync(r); } catch { return ''; } }).filter(Boolean);
}

/** True for loopback, private, link-local and other non-public addresses (no fetching the box's own services). */
export function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || (v.startsWith('::ffff:') && privateIp(v.slice(7)));
}

async function fetchPublic(url: string): Promise<{ bytes: Buffer; type: string; name: string }> {
  let u = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) links.');
    const ips = await dns.lookup(u.hostname, { all: true });
    if (!ips.length || ips.some((x) => privateIp(x.address))) throw new Error('That link points inside a private network.');
    const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { u = new URL(res.headers.get('location')!, u); continue; }
    if (!res.ok) throw new Error(`The link answered ${res.status}.`);
    if (Number(res.headers.get('content-length') || 0) > MAX_FILE_BYTES) throw new Error('That file is over 10 MB.');
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, type: res.headers.get('content-type') ?? '', name: decodeURIComponent(u.pathname.split('/').pop() || 'file') };
  }
  throw new Error('Too many redirects.');
}

export async function sendFile(run: { userId: number; threadId: number }, a: { name?: string; content?: string; url?: string; path?: string; type?: string }): Promise<string> {
  let f: { bytes: Buffer; type: string; name: string };
  if (a.content !== undefined) {
    if (!a.name) throw new Error('Give the file a name with its extension, e.g. report.csv.');
    f = { bytes: Buffer.from(a.content, 'utf8'), type: typeOf(a.name, a.type), name: a.name };
  } else if (a.url) {
    f = await fetchPublic(a.url);
  } else if (a.path) {
    const real = fs.realpathSync(a.path);
    if (!roots().some((r) => real === r || real.startsWith(r + path.sep))) throw new Error('That path is outside the agents\' folders.');
    if (fs.statSync(real).size > MAX_FILE_BYTES) throw new Error('That file is over 10 MB.');
    f = { bytes: fs.readFileSync(real), type: '', name: path.basename(real) };
  } else throw new Error('Give content (with a name), a url or a path.');
  const name = a.name || f.name;
  const att = saveAttachment(run.userId, { name, type: typeOf(name, a.type || f.type), bytes: f.bytes });
  claimAttachments(run.userId, run.threadId, [att.id]);
  sent.set(run.threadId, [...(sent.get(run.threadId) ?? []), att].slice(0, 10));
  return `Sent ${att.name} (${Math.max(1, Math.round(att.size / 1024))} KB) into the conversation; it shows under your answer.`;
}
