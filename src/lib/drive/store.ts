import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';

// Drive metadata (D, 2026-10-10: "a drive with a storage limit", "folders per business"). In the agency's own SQLite (`db` = the current
// agency's database), so agency B never lists agency A's folders or files. The bytes live in lib/drive/storage.ts, encrypted.
//  - drive_folders: a tree. One root per business (kind 'business', business_key) made on first look, one agency root 'General', then
//    any folders people add ('folder'), and 'Client uploads' folders the upload links fill ('uploads').
//  - drive_files: name, plaintext size and sha256, type, the storage key, encryption format + key version + chunk size, who uploaded
//    (a login id, or a label like "Client upload: Dana"), `fresh` = a client upload nobody has opened the folder for yet.
//  - drive_usage: bytes used (plaintext sizes; kept in step on every upload and delete) and an optional per-agency limit override.
//  - drive_reservations: bytes an upload in flight holds, so two uploads cannot both squeeze under the limit (ignored after an hour).

export type FolderKind = 'general' | 'business' | 'folder' | 'uploads';
export interface Folder { id: number; parent_id: number | null; name: string; kind: FolderKind; business_key: string | null; created_at: string }
export interface DriveFile {
  id: number; folder_id: number; name: string; size: number; stored_size: number; type: string; object_id: string; storage_key: string; sha256: string;
  enc_format: number; key_version: number; chunk: number; uploaded_by: number | null; uploader: string; source: string; fresh: number; created_at: string;
}

const ready = schemaOnce();
export function ensureDrive() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS drive_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER REFERENCES drive_folders(id) ON DELETE CASCADE, name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'folder', business_key TEXT, created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_drive_folders_parent ON drive_folders (parent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_drive_folders_root ON drive_folders (kind, business_key) WHERE kind IN ('general', 'business');
    CREATE TABLE IF NOT EXISTS drive_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, folder_id INTEGER NOT NULL REFERENCES drive_folders(id), name TEXT NOT NULL,
      size INTEGER NOT NULL, stored_size INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'application/octet-stream',
      object_id TEXT NOT NULL UNIQUE, storage_key TEXT NOT NULL, sha256 TEXT NOT NULL,
      enc_format INTEGER NOT NULL, key_version INTEGER NOT NULL, chunk INTEGER NOT NULL,
      uploaded_by INTEGER, uploader TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'app', fresh INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_drive_files_folder ON drive_files (folder_id, name);
    CREATE TABLE IF NOT EXISTS drive_usage (id INTEGER PRIMARY KEY CHECK (id = 1), used_bytes INTEGER NOT NULL DEFAULT 0, limit_override INTEGER);
    INSERT OR IGNORE INTO drive_usage (id) VALUES (1);
    CREATE TABLE IF NOT EXISTS drive_reservations (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, at INTEGER NOT NULL);`);
  ready.mark();
}

// ── names ──
/** A file or folder name as saved: no slashes or control characters, trimmed, at most 160 characters. Empty = refused. */
export function cleanName(raw: unknown): string {
  return String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+$/, '').slice(0, 160);
}

// ── folders ──
export const getFolder = (id: number): Folder | undefined => { ensureDrive(); return db.prepare('SELECT * FROM drive_folders WHERE id = ?').get(id) as Folder | undefined; };

/** The General root, made the first time they are needed. */
export function ensureRoots(): void {
  ensureDrive();
  const add = db.prepare(`INSERT OR IGNORE INTO drive_folders (parent_id, name, kind, business_key) VALUES (NULL, ?, ?, ?)`);
  db.transaction(() => {
    if (!db.prepare(`SELECT 1 FROM drive_folders WHERE kind = 'general'`).get()) add.run('General', 'general', null);
  })();
}
export function rootOfBusiness(key: string): Folder | undefined {
  ensureRoots();
  return db.prepare(`SELECT * FROM drive_folders WHERE kind = 'business' AND business_key = ?`).get(key) as Folder | undefined;
}
export const roots = (): Folder[] => { ensureRoots(); return db.prepare('SELECT * FROM drive_folders WHERE parent_id IS NULL ORDER BY kind = \'business\', name COLLATE NOCASE').all() as Folder[]; };

/** The root a folder sits under (access follows the root: General or one business). */
export function rootOf(folderId: number): Folder | undefined {
  ensureDrive();
  let f = getFolder(folderId);
  for (let i = 0; f && f.parent_id !== null && i < 64; i++) f = getFolder(f.parent_id);
  return f && f.parent_id === null ? f : undefined;
}
export const childFolders = (parentId: number): Folder[] => { ensureDrive(); return db.prepare('SELECT * FROM drive_folders WHERE parent_id = ? ORDER BY name COLLATE NOCASE').all(parentId) as Folder[]; };
export const allFolders = (): Folder[] => { ensureRoots(); return db.prepare('SELECT * FROM drive_folders ORDER BY name COLLATE NOCASE').all() as Folder[]; };

/** A child folder by name, made when missing (Client uploads, a dated upload folder). */
export function childNamed(parentId: number, name: string, kind: FolderKind = 'folder', by: number | null = null): Folder {
  ensureDrive();
  const hit = db.prepare('SELECT * FROM drive_folders WHERE parent_id = ? AND name = ? COLLATE NOCASE').get(parentId, name) as Folder | undefined;
  if (hit) return hit;
  const r = db.prepare('INSERT INTO drive_folders (parent_id, name, kind, created_by) VALUES (?, ?, ?, ?)').run(parentId, name, kind, by);
  return getFolder(Number(r.lastInsertRowid))!;
}

export function createFolder(parentId: number, rawName: string, by: number | null): Folder {
  const name = cleanName(rawName);
  if (!name) throw new Error('Give the folder a name.');
  if (!getFolder(parentId)) throw new Error('That folder is gone.');
  if (db.prepare('SELECT 1 FROM drive_folders WHERE parent_id = ? AND name = ? COLLATE NOCASE').get(parentId, name)) throw new Error('A folder with that name is already there.');
  const r = db.prepare('INSERT INTO drive_folders (parent_id, name, kind, created_by) VALUES (?, ?, ?, ?)').run(parentId, name, 'folder', by);
  return getFolder(Number(r.lastInsertRowid))!;
}
export function renameFolder(id: number, rawName: string): void {
  const f = getFolder(id), name = cleanName(rawName);
  if (!f) throw new Error('That folder is gone.');
  if (f.parent_id === null) throw new Error('A business folder takes its name from the business.');
  if (!name) throw new Error('Give the folder a name.');
  db.prepare('UPDATE drive_folders SET name = ? WHERE id = ?').run(name, id);
}
/** Moves a folder under another one of the same root (never into itself or its own subfolders). */
export function moveFolder(id: number, toId: number): void {
  const f = getFolder(id), to = getFolder(toId);
  if (!f || !to) throw new Error('That folder is gone.');
  if (f.parent_id === null) throw new Error('Top folders cannot move.');
  for (let c: Folder | undefined = to, i = 0; c && i < 64; c = c.parent_id === null ? undefined : getFolder(c.parent_id), i++) if (c.id === id) throw new Error('A folder cannot go inside itself.');
  db.prepare('UPDATE drive_folders SET parent_id = ? WHERE id = ?').run(toId, id);
}
/** Every folder id under (and including) a folder. */
export function subtreeIds(id: number): number[] {
  ensureDrive();
  return (db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT f.id FROM drive_folders f JOIN t ON f.parent_id = t.id) SELECT id FROM t`).all(id) as { id: number }[]).map((r) => r.id);
}

// ── files ──
export const getFile = (id: number): DriveFile | undefined => { ensureDrive(); return db.prepare('SELECT * FROM drive_files WHERE id = ?').get(id) as DriveFile | undefined; };
export const filesIn = (folderId: number): DriveFile[] => { ensureDrive(); return db.prepare('SELECT * FROM drive_files WHERE folder_id = ? ORDER BY name COLLATE NOCASE').all(folderId) as DriveFile[]; };
export function filesUnder(folderId: number): DriveFile[] {
  const ids = subtreeIds(folderId);
  return db.prepare(`SELECT * FROM drive_files WHERE folder_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as DriveFile[];
}
/** A name not used yet in the folder: "brief.pdf", then "brief (2).pdf". */
export function freeName(folderId: number, name: string): string {
  ensureDrive();
  const taken = new Set((db.prepare('SELECT lower(name) n FROM drive_files WHERE folder_id = ?').all(folderId) as { n: string }[]).map((r) => r.n));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10_000; i++) { const n = `${stem} (${i})${ext}`; if (!taken.has(n.toLowerCase())) return n; }
  return `${stem} (${Date.now()})${ext}`;
}
export type NewFile = Omit<DriveFile, 'id' | 'created_at'>;
export function insertFile(f: NewFile): DriveFile {
  ensureDrive();
  const r = db.prepare(`INSERT INTO drive_files (folder_id, name, size, stored_size, type, object_id, storage_key, sha256, enc_format, key_version, chunk, uploaded_by, uploader, source, fresh)
      VALUES (@folder_id, @name, @size, @stored_size, @type, @object_id, @storage_key, @sha256, @enc_format, @key_version, @chunk, @uploaded_by, @uploader, @source, @fresh)`).run(f);
  return getFile(Number(r.lastInsertRowid))!;
}
export function renameFile(id: number, rawName: string): void {
  const name = cleanName(rawName);
  if (!name) throw new Error('Give the file a name.');
  if (!db.prepare('UPDATE drive_files SET name = ? WHERE id = ?').run(name, id).changes) throw new Error('That file is gone.');
}
export function moveFile(id: number, toId: number): void {
  if (!getFolder(toId)) throw new Error('That folder is gone.');
  if (!db.prepare('UPDATE drive_files SET folder_id = ? WHERE id = ?').run(toId, id).changes) throw new Error('That file is gone.');
}
/** Drops the file rows and gives their bytes back to the usage counter (one transaction). The caller removes the objects. */
export function dropFiles(ids: number[]): void {
  if (!ids.length) return;
  ensureDrive();
  db.transaction(() => {
    for (const id of ids) {
      const f = getFile(id);
      if (!f) continue;
      db.prepare('DELETE FROM drive_files WHERE id = ?').run(id);
      db.prepare('UPDATE drive_usage SET used_bytes = max(0, used_bytes - ?) WHERE id = 1').run(f.size);
    }
  })();
}
export function dropFolder(id: number): void {
  const f = getFolder(id);
  if (!f) return;
  if (f.parent_id === null) throw new Error('Top folders cannot be deleted.');
  const ids = subtreeIds(id);
  db.transaction(() => { for (const fid of ids.reverse()) db.prepare('DELETE FROM drive_folders WHERE id = ?').run(fid); })();
}
/** Name search over the folders this viewer may open (`rootIds`). */
export function searchFiles(q: string, rootIds: number[], limit = 100): (DriveFile & { root_id: number })[] {
  ensureDrive();
  const term = q.trim().toLowerCase();
  if (!term || !rootIds.length) return [];
  const rows = db.prepare(`SELECT * FROM drive_files WHERE instr(lower(name), ?) > 0 ORDER BY created_at DESC LIMIT 500`).all(term) as DriveFile[];
  const out: (DriveFile & { root_id: number })[] = [];
  const allowed = new Set(rootIds), rootCache = new Map<number, number | undefined>();
  for (const f of rows) {
    if (!rootCache.has(f.folder_id)) rootCache.set(f.folder_id, rootOf(f.folder_id)?.id);
    const r = rootCache.get(f.folder_id);
    if (r !== undefined && allowed.has(r)) out.push({ ...f, root_id: r });
    if (out.length >= limit) break;
  }
  return out;
}
/** Client uploads nobody has looked at yet, per root folder (the "New uploads" badge). */
export function freshByRoot(): Map<number, number> {
  ensureDrive();
  const out = new Map<number, number>();
  for (const r of db.prepare('SELECT folder_id, count(*) n FROM drive_files WHERE fresh = 1 GROUP BY folder_id').all() as { folder_id: number; n: number }[]) {
    const root = rootOf(r.folder_id);
    if (root) out.set(root.id, (out.get(root.id) ?? 0) + r.n);
  }
  return out;
}
export const markSeen = (folderIds: number[]) => {
  if (!folderIds.length) return;
  ensureDrive();
  db.prepare(`UPDATE drive_files SET fresh = 0 WHERE fresh = 1 AND folder_id IN (${folderIds.map(() => '?').join(',')})`).run(...folderIds);
};
/** Bytes per root folder (per-business usage in the folder list). */
export function bytesByRoot(): Map<number, number> {
  ensureDrive();
  const out = new Map<number, number>();
  for (const r of db.prepare('SELECT folder_id, sum(size) b FROM drive_files GROUP BY folder_id').all() as { folder_id: number; b: number }[]) {
    const root = rootOf(r.folder_id);
    if (root) out.set(root.id, (out.get(root.id) ?? 0) + r.b);
  }
  return out;
}

// ── usage and the limit ──
const RESERVE_TTL = 3600_000;
export interface Usage { used: number; reserved: number; limit: number | null; override: number | null }
export function usageRow(now = Date.now()): { used: number; reserved: number; override: number | null } {
  ensureDrive();
  const u = db.prepare('SELECT used_bytes, limit_override FROM drive_usage WHERE id = 1').get() as { used_bytes: number; limit_override: number | null };
  const r = db.prepare('SELECT coalesce(sum(bytes), 0) b FROM drive_reservations WHERE at > ?').get(now - RESERVE_TTL) as { b: number };
  return { used: u.used_bytes, reserved: r.b, override: u.limit_override };
}
export class QuotaError extends Error {
  constructor(msg: string) { super(msg); this.name = 'QuotaError'; }
}
/** Holds `bytes` for an upload in flight, or throws QuotaError when it would go over `limit` (null = no cap). Checked before any byte
 *  is written. */
export function reserve(id: string, bytes: number, limit: number | null, now = Date.now()): void {
  ensureDrive();
  db.transaction(() => {
    db.prepare('DELETE FROM drive_reservations WHERE at <= ?').run(now - RESERVE_TTL);
    const u = usageRow(now);
    if (limit !== null && u.used + u.reserved + bytes > limit) throw new QuotaError('The Drive is full: this upload would go over the storage limit.');
    db.prepare('INSERT INTO drive_reservations (id, bytes, at) VALUES (?, ?, ?)').run(id, bytes, now);
  }).immediate();
}
export const release = (id: string) => { ensureDrive(); db.prepare('DELETE FROM drive_reservations WHERE id = ?').run(id); };
/** Turns a reservation into used bytes and saves the file row, in one transaction. */
export function commitFile(reservationId: string, f: NewFile): DriveFile {
  ensureDrive();
  return db.transaction(() => {
    db.prepare('DELETE FROM drive_reservations WHERE id = ?').run(reservationId);
    db.prepare('UPDATE drive_usage SET used_bytes = used_bytes + ? WHERE id = 1').run(f.size);
    return insertFile(f);
  })();
}
export function setLimitOverride(bytes: number | null): void {
  ensureDrive();
  db.prepare('UPDATE drive_usage SET limit_override = ? WHERE id = 1').run(bytes);
}
/** Recount used bytes from the rows (repair). */
export function recountUsage(): number {
  ensureDrive();
  const b = (db.prepare('SELECT coalesce(sum(size), 0) b FROM drive_files').get() as { b: number }).b;
  db.prepare('UPDATE drive_usage SET used_bytes = ? WHERE id = 1').run(b);
  return b;
}
