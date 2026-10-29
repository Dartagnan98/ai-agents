import 'server-only';
import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { privateIp } from './send-file';
import { getCTXRoot } from '@/lib/config';
import { agencyIdNow } from '@/lib/slack/app';

// Saved keys for agents (D 2026-10-28; vault): the keys an owner or admin hands the agents with save_key, one
// 600 file per agency, by NAME only. the agency's own sealed contract keys (fleet-run) are never in it. list_secrets shows names; http_request puts {{secret:NAME}} into a request's headers, body or URL path/query (never the
// host) and returns the answer with every key value scrubbed (tools.ts guard). The first time a key goes to a host it waits for an approve
// card (table ai_secret_hosts remembers the yes); a run that read outside text always asks.

export const VAULT_FILE = () => path.join(getCTXRoot(), 'vault', agencyIdNow(), 'agent-vault.env');
const FILES = () => [VAULT_FILE()];

/** NAME -> { value, file }; the first file that has a name wins. */
export function savedKeys(): Map<string, { value: string; file: string }> {
  const out = new Map<string, { value: string; file: string }>();
  for (const f of FILES()) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m || out.has(m[1])) continue;
      const v = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (v) out.set(m[1], { value: v, file: f });
    }
  }
  return out;
}
/** Saves (or replaces) NAME in the vault file. Returns the last 4 characters for the reply; the value itself is never echoed. */
export function saveKey(name: string, value: string): string {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new Error('Key names are CAPITALS_WITH_UNDERSCORES, e.g. CALENDLY_TOKEN.');
  const v = value.trim();
  if (!v || /[\r\n]/.test(v)) throw new Error('The key value is empty or has a line break.');
  const f = VAULT_FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  let lines: string[] = [];
  try { lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith(`${name}=`)); } catch { /* first key */ }
  fs.writeFileSync(f, [...lines, `${name}=${v}`].join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(f, 0o600);
  return v.slice(-4);
}

/** Every key value, for the output guard. */
export const savedKeyValues = (): Record<string, string> => Object.fromEntries([...savedKeys()].map(([k, v]) => [`SAVED_${k}`, v.value]));

export function listSecrets(q = ''): string {
  const rows = [...savedKeys()].filter(([k]) => !q || k.toLowerCase().includes(q.toLowerCase()));
  return rows.length ? rows.map(([k]) => k).join('\n') + '\n\nUse one in http_request as {{secret:NAME}}.' : 'No saved keys yet. An owner or admin can send you one and ask you to save it (save_key).';
}

const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_secret_hosts (name TEXT NOT NULL, host TEXT NOT NULL, approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), PRIMARY KEY (name, host))`);
  ready.mark();
}
export function approveHost(name: string, host: string) { ensure(); db.prepare('INSERT OR IGNORE INTO ai_secret_hosts (name, host) VALUES (?, ?)').run(name, host.toLowerCase()); }
const hostOk = (name: string, host: string) => { ensure(); return !!db.prepare('SELECT 1 FROM ai_secret_hosts WHERE name = ? AND host = ?').get(name, host.toLowerCase()); };

export type HttpReq = { method?: string; url: string; headers?: Record<string, string>; body?: string };
const SECRET_RE = /\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g;
export const secretsIn = (r: HttpReq): string[] => [...new Set([r.url, r.body ?? '', ...Object.entries(r.headers ?? {}).flat()].flatMap((s) => [...String(s).matchAll(SECRET_RE)].map((m) => m[1])))];

/** Checks a request: its host, the keys it names exist, a key is never in the host. Returns the host. */
export function checkRequest(r: HttpReq): string {
  const u = new URL(r.url.replace(SECRET_RE, 'x'));
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) requests.');
  if (/\{\{secret:/.test(r.url.split('/').slice(0, 3).join('/'))) throw new Error('A key can never go in the host name.');
  const keys = savedKeys();
  for (const n of secretsIn(r)) if (!keys.has(n)) throw new Error(`No saved key ${n}. See list_secrets.`);
  return u.hostname.toLowerCase();
}
/** The keys this request names that were never approved for its host. */
export const unapproved = (r: HttpReq): string[] => { const host = checkRequest(r); return secretsIn(r).filter((n) => !hostOk(n, host)); };

/** Sends it (keys filled in). The answer's status and body (first 12,000 characters); the caller scrubs key values. */
export async function sendRequest(r: HttpReq): Promise<string> {
  const host = checkRequest(r);
  const ips = await dns.lookup(host, { all: true });
  if (!ips.length || ips.some((x) => privateIp(x.address))) throw new Error('That host is inside a private network.');
  const keys = savedKeys(), fill = (s: string) => s.replace(SECRET_RE, (_, n: string) => keys.get(n)!.value);
  const method = (r.method || 'GET').toUpperCase();
  const res = await fetch(fill(r.url), {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k, fill(String(v))])),
    ...(r.body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body: fill(r.body) } : {}),
  });
  const text = await res.text().catch(() => '');
  return `HTTP ${res.status}\n${text.length > 12_000 ? `${text.slice(0, 12_000)}\n[cut at 12,000 characters]` : text}`;
}
