import 'server-only';
import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { randomBase62 } from '@/lib/location-id';
import { agencyKey, currentKeyVersion, decryptBuffer, encryptBuffer, keysFor } from '@/lib/drive/crypto';
import { driveAgencyId, driveDir } from '@/lib/drive/service';
import { schemaOnce } from '@/lib/schema-once';
import { officeKind, officeText } from './office';

// Files and pictures in the agents chats (D, 2026-10-23: "no way to add attachments and pictures ... no drag and drop", CTRL Flow's).
// The composer uploads each file here first (paperclip, paste or drop); the message then names their ids. Bytes are kept encrypted with
// the agency's Drive key beside its Drive folder; a row says who uploaded it and, once sent, which conversation it belongs to. Only the
// person who uploaded it reads it back. Pictures reach the model as images, PDFs as documents, text files as text, and Excel, Word
// and PowerPoint files (2026-10-23) as their text (each sheet as CSV), while the original stays downloadable.
// Big files (D, 2026-10-27: a 4.8M-character export was cut at 120k): text up to INLINE_CHARS goes in the prompt whole; a longer one
// goes in as its start plus a note, and the agent reads the rest with the read_file / search_file tools (fileText below).
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 10;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // one request, all files together
const INLINE_CHARS = 60_000;
const PREVIEW_CHARS = 15_000;
const IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const OFFICE_TYPE = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } as const;
const TEXT_EXT = /\.(txt|csv|tsv|md|json|log|xml|html?|ya?ml)$/i;

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'office';
export interface Attachment { id: string; name: string; type: string; size: number; kind: AttachmentKind }
/** What a runner gets: images and PDFs as base64, text files as their text. */
export type RunAttachment = { kind: 'image' | 'pdf'; name: string; mediaType: string; data: string } | { kind: 'text'; name: string; text: string };

const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_attachments (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, thread_id INTEGER, name TEXT NOT NULL,
    type TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ai_attachments_user ON ai_attachments (user_id, created_at)');
  ready.mark();
}
const dir = () => path.join(path.dirname(driveDir()), 'ai-attachments');
const fileOf = (id: string) => path.join(dir(), `${id}.bin`);

/** What kind a file is, from its type or name; null = not taken. */
export function kindOf(type: string, name: string): AttachmentKind | null {
  if (IMAGE.has(type)) return 'image';
  if (officeKind(name)) return 'office'; // Excel, Word, PowerPoint: kept as sent, read as text (lib/ai/office.ts)
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
  if (type.startsWith('text/') || type === 'application/json' || TEXT_EXT.test(name)) return 'text';
  return null;
}

export function saveAttachment(userId: number, f: { name: string; type: string; bytes: Buffer }): Attachment {
  ensure();
  const name = (f.name || 'file').replace(/[\\/\0]/g, '_').slice(0, 160), kind = kindOf(f.type, name);
  if (!kind && /\.(xls|doc|ppt)$/i.test(name)) throw new Error(`${name} is an old Office format: save it as .${name.split('.').pop()!.toLowerCase()}x and add it again.`);
  if (!kind) throw new Error(`${name}: add pictures (PNG, JPG, GIF, WebP), PDFs, Excel, Word, PowerPoint or text files (TXT, CSV, MD, JSON).`);
  if (!f.bytes.length) throw new Error(`${name} is empty.`);
  if (f.bytes.length > MAX_FILE_BYTES) throw new Error(`${name} is over 10 MB.`);
  const id = randomBase62(20), v = currentKeyVersion();
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(fileOf(id), encryptBuffer(f.bytes, agencyKey(driveAgencyId(), v), v), { mode: 0o600 });
  const type = kind === 'pdf' ? 'application/pdf' : kind === 'text' ? 'text/plain' : kind === 'office' ? OFFICE_TYPE[officeKind(name)!] : f.type;
  db.prepare('INSERT INTO ai_attachments (id, user_id, name, type, size, kind) VALUES (?, ?, ?, ?, ?, ?)').run(id, userId, name, type, f.bytes.length, kind);
  return { id, name, type, size: f.bytes.length, kind };
}

type Row = Attachment & { user_id: number; thread_id: number | null };
const row = (id: string) => (db.prepare('SELECT * FROM ai_attachments WHERE id = ?').get(id) as Row | undefined);

/** The files a message names: this person's own, not yet in another conversation; now tied to this one. Unknown ids are dropped. */
export function claimAttachments(userId: number, threadId: number, ids: unknown): Attachment[] {
  ensure();
  if (!Array.isArray(ids)) return [];
  const out: Attachment[] = [];
  for (const id of ids.slice(0, MAX_FILES)) {
    if (typeof id !== 'string' || !/^[0-9A-Za-z]{20}$/.test(id)) continue;
    const r = row(id);
    if (!r || r.user_id !== userId || (r.thread_id !== null && r.thread_id !== threadId)) continue;
    db.prepare('UPDATE ai_attachments SET thread_id = ? WHERE id = ?').run(threadId, id);
    out.push({ id: r.id, name: r.name, type: r.type, size: r.size, kind: r.kind });
  }
  return out;
}

/** The file for its uploader only; null otherwise (or gone). */
export function readAttachment(userId: number, id: string): { meta: Attachment; bytes: Buffer } | null {
  ensure();
  if (!/^[0-9A-Za-z]{20}$/.test(id)) return null;
  const r = row(id);
  if (!r || r.user_id !== userId) return null;
  try {
    return { meta: { id: r.id, name: r.name, type: r.type, size: r.size, kind: r.kind }, bytes: decryptBuffer(fs.readFileSync(fileOf(id)), keysFor(driveAgencyId())) };
  } catch { return null; }
}

/** The text of a text, Excel, Word or PowerPoint file (each sheet as CSV), kept a few minutes so paging through it stays fast. */
const g = globalThis as unknown as { __aiFileText?: Map<string, { text: string; at: number }> };
const textCache = (g.__aiFileText ??= new Map());
function textOf(f: Attachment, bytes: Buffer): string {
  const hit = textCache.get(f.id);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.text;
  let t: string;
  if (f.kind === 'office') {
    try { t = officeText(officeKind(f.name) ?? 'docx', bytes) || '[no text in this file]'; } catch { t = '[this file could not be read: it may be damaged or password protected]'; }
  } else t = bytes.toString('utf8');
  for (const [k, v] of textCache) if (Date.now() - v.at > 10 * 60_000) textCache.delete(k);
  if (textCache.size > 20) textCache.delete(textCache.keys().next().value!);
  textCache.set(f.id, { text: t, at: Date.now() });
  return t;
}

/** The files in one conversation that this person sent (what read_file / search_file may open). */
export function threadAttachments(userId: number, threadId: number): Attachment[] {
  ensure();
  return (db.prepare("SELECT id, name, type, size, kind FROM ai_attachments WHERE user_id = ? AND thread_id = ? AND kind IN ('text', 'office') ORDER BY created_at")
    .all(userId, threadId) as Attachment[]);
}

/** A conversation file's full text, by id or by name; null when it is not one of this person's files in this conversation. */
export function fileText(userId: number, threadId: number, idOrName: string): { meta: Attachment; text: string } | null {
  const want = idOrName.trim().toLowerCase();
  const f = threadAttachments(userId, threadId).find((a) => a.id.toLowerCase() === want || a.name.toLowerCase() === want);
  const r = f && readAttachment(userId, f.id);
  return r ? { meta: r.meta, text: textOf(r.meta, r.bytes) } : null;
}

/** The files as the model gets them. */
export function forRunner(userId: number, files: Attachment[]): RunAttachment[] {
  const out: RunAttachment[] = [];
  for (const f of files) {
    const r = readAttachment(userId, f.id);
    if (!r) continue;
    if (f.kind === 'office' || f.kind === 'text') {
      const t = textOf(f, r.bytes);
      const lines = t.split('\n').length;
      out.push({ kind: 'text', name: f.name, text: t.length <= INLINE_CHARS ? t
        : `[This file is long: ${t.length.toLocaleString('en-US')} characters, ${lines.toLocaleString('en-US')} lines. Only its start is shown here. `
          + `Read the rest with read_file (file "${f.id}", from_line, lines) and find things in it with search_file (file "${f.id}", query). `
          + 'Go through the whole file before answering anything that needs all of it.]\n\n'
          + `${t.slice(0, PREVIEW_CHARS)}\n[… preview ends at character ${PREVIEW_CHARS.toLocaleString('en-US')}: use read_file for the rest]` });
    } else out.push({ kind: f.kind, name: f.name, mediaType: f.type, data: r.bytes.toString('base64') });
  }
  return out;
}

/** read_file: lines from_line (1-based) on, at most `lines` lines and 40,000 characters. */
export function readFileLines(text: string, fromLine: number, lines: number): string {
  const all = text.split('\n'), from = Math.max(1, Math.floor(fromLine) || 1), want = Math.min(2000, Math.max(1, Math.floor(lines) || 400));
  if (from > all.length) return `The file has ${all.length} lines; from_line ${from} is past the end.`;
  const out: string[] = [];
  let size = 0, i = from - 1;
  for (; i < all.length && out.length < want; i++) {
    const l = all[i].length > 40_000 ? `${all[i].slice(0, 40_000)} [line cut]` : all[i];
    if (size + l.length > 40_000 && out.length) break;
    out.push(`${i + 1}\t${l}`); size += l.length + 8;
  }
  return `Lines ${from}-${i} of ${all.length}${i < all.length ? ` (next: from_line ${i + 1})` : ' (end of file)'}\n${out.join('\n')}`;
}

/** search_file: the lines that contain every word of the query (any case), with their line numbers. */
export function searchFileLines(text: string, query: string, max = 100): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 'Pass what to look for.';
  const all = text.split('\n'), hits: string[] = [];
  let count = 0;
  for (let i = 0; i < all.length; i++) {
    const low = all[i].toLowerCase();
    if (!words.every((w) => low.includes(w))) continue;
    if (++count <= max) hits.push(`${i + 1}\t${all[i].length > 400 ? `${all[i].slice(0, 400)} …` : all[i]}`);
  }
  return count ? `${count} matching line${count === 1 ? '' : 's'}${count > max ? ` (first ${max} shown)` : ''}:\n${hits.join('\n')}` : `No line contains "${query}".`;
}

/** The text files' contents folded into the prompt (every runner reads text). */
export function withTextFiles(prompt: string, files: RunAttachment[]): string {
  const t = files.filter((f): f is Extract<RunAttachment, { kind: 'text' }> => f.kind === 'text');
  return t.length ? `${prompt}\n\n${t.map((f) => `=== Attached file: ${f.name} ===\n${f.text}\n=== End of ${f.name} ===`).join('\n\n')}` : prompt;
}
