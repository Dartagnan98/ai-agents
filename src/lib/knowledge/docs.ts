import 'server-only';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';

// Intelligence per agency (D, 2026-10-10: "port the Intelligence pages so every agency gets its own"). Knowledge documents and wiki
// notes live in the agency's own SQLite (`db` = the current agency's database), so agency B never reads agency A's rows. Search is
// SQLite FTS5 (porter stemming); no embeddings, because no agency has its own embedding key yet.
export type Space = 'knowledge' | 'wiki';
export const SPACES: Space[] = ['knowledge', 'wiki'];
export const isSpace = (v: unknown): v is Space => v === 'knowledge' || v === 'wiki';

export interface Doc {
  id: number; space: Space; folder: string; title: string; body: string; source: 'paste' | 'upload'; file_name: string;
  created_by: number | null; updated_by: number | null; created_at: string; updated_at: string;
}
export type DocRow = Omit<Doc, 'body'> & { size: number; preview: string };
export interface DocInput { space: Space; title: string; body: string; folder?: string; source?: 'paste' | 'upload'; file_name?: string }
export interface Hit { id: number; space: Space; folder: string; title: string; snippet: string; updated_at: string }

export const MAX_BODY = 500_000; // characters per document
const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS kb_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, space TEXT NOT NULL DEFAULT 'knowledge', folder TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'paste', file_name TEXT NOT NULL DEFAULT '',
      created_by INTEGER, updated_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_kb_docs_space ON kb_docs (space, folder, title);
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_docs_fts USING fts5(title, body, content='kb_docs', content_rowid='id', tokenize='porter unicode61');
    CREATE TRIGGER IF NOT EXISTS kb_docs_ai AFTER INSERT ON kb_docs BEGIN
      INSERT INTO kb_docs_fts (rowid, title, body) VALUES (new.id, new.title, new.body); END;
    CREATE TRIGGER IF NOT EXISTS kb_docs_ad AFTER DELETE ON kb_docs BEGIN
      INSERT INTO kb_docs_fts (kb_docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); END;
    CREATE TRIGGER IF NOT EXISTS kb_docs_au AFTER UPDATE ON kb_docs BEGIN
      INSERT INTO kb_docs_fts (kb_docs_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO kb_docs_fts (rowid, title, body) VALUES (new.id, new.title, new.body); END;`);
  ready.mark();
}

/** Clean an input; a string is the reason it was refused. */
export function cleanDoc(b: Record<string, unknown>): DocInput | string {
  if (!isSpace(b.space)) return 'Unknown space.';
  const title = String(b.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!title) return 'Give it a title.';
  const body = String(b.body ?? '').replace(/\r\n/g, '\n');
  if (!body.trim()) return 'It has no text.';
  if (body.length > MAX_BODY) return `Too long: keep a document under ${MAX_BODY.toLocaleString('en-US')} characters (split it in parts).`;
  const folder = String(b.folder ?? '').replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  const file_name = String(b.file_name ?? '').trim().slice(0, 160);
  return { space: b.space, title, body, folder, source: b.source === 'upload' ? 'upload' : 'paste', file_name };
}

/** One space's documents, folder then title; no bodies (a preview line instead). */
export function listDocs(space: Space): DocRow[] {
  ensure();
  return db.prepare(`SELECT id, space, folder, title, source, file_name, created_by, updated_by, created_at, updated_at, length(body) AS size,
      substr(body, 1, 400) AS preview FROM kb_docs WHERE space = ? ORDER BY folder COLLATE NOCASE, title COLLATE NOCASE`).all(space) as DocRow[];
}

export function getDoc(id: number): Doc | undefined {
  ensure();
  return db.prepare('SELECT * FROM kb_docs WHERE id = ?').get(id) as Doc | undefined;
}

export function countDocs(): Record<Space, number> {
  ensure();
  const out: Record<Space, number> = { knowledge: 0, wiki: 0 };
  for (const r of db.prepare('SELECT space, count(*) AS n FROM kb_docs GROUP BY space').all() as { space: string; n: number }[]) if (isSpace(r.space)) out[r.space] = r.n;
  return out;
}

export function saveDoc(userId: number | null, d: DocInput, id?: number): Doc {
  ensure();
  if (id !== undefined) {
    const r = db.prepare(`UPDATE kb_docs SET title = ?, body = ?, folder = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE id = ? AND space = ?`).run(d.title, d.body, d.folder ?? '', userId, id, d.space);
    if (!r.changes) throw new Error('That document is gone.');
    return getDoc(id)!;
  }
  const r = db.prepare(`INSERT INTO kb_docs (space, folder, title, body, source, file_name, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(d.space, d.folder ?? '', d.title, d.body, d.source ?? 'paste', d.file_name ?? '', userId, userId);
  return getDoc(Number(r.lastInsertRowid))!;
}

export function deleteDoc(id: number): boolean {
  ensure();
  return db.prepare('DELETE FROM kb_docs WHERE id = ?').run(id).changes > 0;
}

/** Words of a search as an FTS5 query: each word a quoted prefix, all of them required. Empty = nothing to search. */
export function ftsQuery(q: string): string {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.slice(0, 12).map((w) => `"${w}"*`).join(' ');
}

/** Ranked search over this agency's documents (one space or both). Snippets mark matches with [[ and ]]. */
export function searchDocs(q: string, opts: { space?: Space; limit?: number } = {}): Hit[] {
  ensure();
  const match = ftsQuery(q);
  if (!match) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  return db.prepare(`SELECT d.id, d.space, d.folder, d.title, d.updated_at, snippet(kb_docs_fts, 1, '[[', ']]', '...', 24) AS snippet
      FROM kb_docs_fts JOIN kb_docs d ON d.id = kb_docs_fts.rowid
      WHERE kb_docs_fts MATCH ? ${opts.space ? 'AND d.space = ?' : ''} ORDER BY bm25(kb_docs_fts, 4.0, 1.0) LIMIT ?`)
    .all(...[match, ...(opts.space ? [opts.space] : []), limit]) as Hit[];
}
