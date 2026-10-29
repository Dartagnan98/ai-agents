import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { legacyDbPath } from '@/lib/db-schema';
import { isMultiTenant } from '@/lib/platform/mode';
import { currentAgencySync } from '@/lib/platform/tenant-db';
import { agencyPaths } from '@/lib/platform/db';
import { randomBase62 } from '@/lib/location-id';
import { currentKeyVersion, DecryptStream, DEFAULT_CHUNK, EncryptStream, encryptedSize, FORMAT, keysFor, agencyKey } from './crypto';
import { driveStorage, fileKey, keyAgency, type DriveStorage } from './storage';
import { commitFile, dropFiles, dropFolder, filesUnder, freeName, getFile, release, reserve, usageRow, QuotaError, cleanName, type DriveFile } from './store';

// Drive I/O for the current agency (D, 2026-10-10): where its bytes go, its key, its limit, and the encrypted upload/download streams.
// Uploads stream request -> size guard -> AES-GCM chunks -> a temp file under the agency's drive dir -> storage (moved on local disk,
// streamed to S3). Nothing is buffered whole, and the plaintext never touches disk.

export const GB = 1024 ** 3;
/** Largest single file: DRIVE_MAX_MB, default 200. */
export const maxFileBytes = (env: NodeJS.ProcessEnv = process.env) => { const n = Number(env.DRIVE_MAX_MB); return Math.floor((Number.isFinite(n) && n > 0 ? n : 200) * 1024 * 1024); };

/** The id that prefixes this agency's storage keys and names its key: its agc_ id, 'local' on a single install. */
export function driveAgencyId(): string {
  return isMultiTenant() ? currentAgencySync().id : 'local';
}
/** Local folder for this agency's Drive (objects when no S3 is set, and temp files while encrypting). */
export function driveDir(): string {
  if (isMultiTenant()) { const a = currentAgencySync(); if (!a.legacy) return path.join(agencyPaths(a).dir, 'drive'); }
  return path.join(path.dirname(legacyDbPath()), 'drive');
}
export const storage = (): DriveStorage => driveStorage(driveDir());

/** The agency's limit in bytes: its own override (platform console), else its plan's storageGb; null = no cap. */
export function limitBytes(): number | null {
  const u = usageRow();
  if (u.override !== null) return u.override;
  return null; // no storage cap: a local install uses its own disk
}
export interface UsageView { used: number; reserved: number; limit: number | null; pct: number | null; warn: boolean; full: boolean }
export function usage(): UsageView {
  const u = usageRow(), limit = limitBytes();
  const pct = limit === null ? null : limit === 0 ? 100 : Math.min(100, (u.used / limit) * 100);
  return { used: u.used, reserved: u.reserved, limit, pct, warn: pct !== null && pct >= 90, full: limit !== null && u.used >= limit };
}

// content types by extension (served on download; previews only for the safe ones below)
const TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', heic: 'image/heic', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', psd: 'image/vnd.adobe.photoshop', ai: 'application/postscript',
};
export const typeOf = (name: string) => TYPES[(name.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream';
/** Shown inline in the preview dialog; everything else downloads as an attachment. SVG and HTML never inline (scripts). */
export type PreviewKind = 'pdf' | 'image' | 'video' | 'audio' | 'text' | null;
export function previewKind(type: string): PreviewKind {
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/') && type !== 'image/svg+xml' && type !== 'image/heic' && type !== 'image/vnd.adobe.photoshop') return 'image';
  if (type === 'video/mp4' || type === 'video/webm' || type === 'video/quicktime') return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'text/plain' || type === 'text/markdown' || type === 'text/csv' || type === 'application/json') return 'text';
  return null;
}

/** Counts bytes and stops the upload once it passes what was declared (the quota was checked on the declared size). */
function sizeGuard(max: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _e, cb) { n += chunk.length; if (n > max) cb(new Error('The file is bigger than it said.')); else cb(null, chunk); },
  });
}

export interface Ingest {
  folderId: number; name: string; size: number; body: Readable; uploadedBy: number | null; uploader: string; source: 'app' | 'upload-link' | 'join'; fresh?: boolean;
}
/** Encrypts and stores one file, checking the limit (on the declared size) before a byte is written. Throws QuotaError when full. */
export async function ingest(f: Ingest): Promise<DriveFile> {
  const name = cleanName(f.name);
  if (!name) throw new Error('The file has no name.');
  if (!Number.isFinite(f.size) || f.size < 0) throw new Error('Send the file size (Content-Length).');
  const max = maxFileBytes();
  if (f.size > max) throw new Error(`Too big: files can be up to ${Math.round(max / 1024 / 1024)} MB.`);
  const agency = driveAgencyId();
  const resId = randomBase62(16);
  reserve(resId, f.size, limitBytes());
  const objectId = `${Date.now().toString(36)}${randomBase62(16)}`;
  const tmpDir = path.join(driveDir(), '.tmp');
  const tmp = path.join(tmpDir, `${objectId}.part`);
  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
    const keyVersion = currentKeyVersion();
    const enc = new EncryptStream(agencyKey(agency, keyVersion), keyVersion, DEFAULT_CHUNK);
    await pipeline(f.body, sizeGuard(f.size), enc, fs.createWriteStream(tmp, { mode: 0o600 }));
    const { bytes, sha256 } = enc.stats();
    if (bytes !== f.size) throw new Error('The upload was cut off. Try again.');
    const key = fileKey(agency, objectId);
    const stored = encryptedSize(bytes, DEFAULT_CHUNK);
    await storage().putFile(key, tmp, stored);
    return commitFile(resId, {
      folder_id: f.folderId, name: freeName(f.folderId, name), size: bytes, stored_size: stored, type: typeOf(name), object_id: objectId, storage_key: key, sha256,
      enc_format: FORMAT, key_version: keyVersion, chunk: DEFAULT_CHUNK, uploaded_by: f.uploadedBy, uploader: f.uploader.slice(0, 120), source: f.source, fresh: f.fresh ? 1 : 0,
    });
  } catch (e) {
    release(resId);
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
export const ingestText = (folderId: number, name: string, text: string, who: Omit<Ingest, 'folderId' | 'name' | 'size' | 'body'>) => {
  const buf = Buffer.from(text, 'utf8');
  return ingest({ ...who, folderId, name, size: buf.length, body: Readable.from([buf]) });
};

/** The decrypted bytes of one file, streamed. The key is this agency's: a row whose storage key names another agency is refused. */
export async function openFile(file: DriveFile): Promise<Readable> {
  const agency = driveAgencyId();
  if (keyAgency(file.storage_key) !== agency) throw new Error('That file is not in this agency.');
  const src = await storage().get(file.storage_key);
  const dec = new DecryptStream(keysFor(agency));
  src.on('error', (e) => dec.destroy(e));
  return src.pipe(dec);
}

/** Deletes files (objects first, then rows and usage). */
export async function deleteFiles(ids: number[]): Promise<void> {
  const s = storage(), agency = driveAgencyId();
  for (const id of ids) {
    const f = getFile(id);
    if (!f) continue;
    if (keyAgency(f.storage_key) !== agency) throw new Error('That file is not in this agency.');
    await s.remove(f.storage_key);
    dropFiles([id]);
  }
}
export async function deleteFolderTree(folderId: number): Promise<void> {
  await deleteFiles(filesUnder(folderId).map((f) => f.id));
  dropFolder(folderId);
}

export { QuotaError };
export const sha256Hex = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
export const fmtBytes = (n: number) => (n >= GB ? `${(n / GB).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
