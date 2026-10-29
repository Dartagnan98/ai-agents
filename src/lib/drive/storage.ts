import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { Readable } from 'stream';
import { presign } from './sigv4';

// Drive object storage (D, 2026-10-10). Two backends behind one small interface; both only ever hold ciphertext (lib/drive/crypto.ts):
//  - S3-compatible object storage (Cloudflare R2, Hetzner Object Storage, MinIO, AWS) when DRIVE_S3_ENDPOINT, DRIVE_S3_BUCKET,
//    DRIVE_S3_ACCESS_KEY_ID and DRIVE_S3_SECRET_ACCESS_KEY are set (DRIVE_S3_REGION, default 'auto' for R2). Path-style URLs.
//  - otherwise local disk under the agency's data dir (<dir>/drive), so it works in dev and on one box.
// Every key is agencies/<agency id>/...: two agencies can never write the same object, even in one bucket.

export interface DriveStorage {
  kind: 'local' | 's3';
  /** Stores the file at `src` (already encrypted) under `key`; the local backend moves it, S3 streams it up. */
  putFile(key: string, src: string, size: number): Promise<void>;
  get(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

const AGENCY_PART = /^(agc_[0-9A-Za-z]{20}|[A-Za-z0-9_-]{1,64})$/;
/** True for a key this module would make: agencies/<agency>/<kind>/<name>, nothing that climbs out. */
export function validKey(key: string): boolean {
  const parts = key.split('/');
  return parts.length === 4 && parts[0] === 'agencies' && AGENCY_PART.test(parts[1]) && /^[a-z]+$/.test(parts[2]) && /^[0-9A-Za-z_-][0-9A-Za-z._-]{0,120}$/.test(parts[3]);
}
/** The storage key of one Drive file of one agency. */
export function fileKey(agencyId: string, objectId: string): string {
  const key = `agencies/${agencyId}/files/${objectId}.ctd`;
  if (!validKey(key)) throw new Error('Bad Drive key.');
  return key;
}
/** The agency a key belongs to (isolation checks). */
export const keyAgency = (key: string): string | null => (validKey(key) ? key.split('/')[1] : null);

export interface S3Config { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string }
export function s3Config(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = (env.DRIVE_S3_ENDPOINT ?? '').trim().replace(/\/+$/, ''), bucket = (env.DRIVE_S3_BUCKET ?? '').trim();
  const accessKeyId = (env.DRIVE_S3_ACCESS_KEY_ID ?? '').trim(), secretAccessKey = (env.DRIVE_S3_SECRET_ACCESS_KEY ?? '').trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint: /^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`, bucket, accessKeyId, secretAccessKey, region: (env.DRIVE_S3_REGION ?? '').trim() || 'auto' };
}

export function localStorage(root: string): DriveStorage {
  const file = (key: string) => {
    if (!validKey(key)) throw new Error('Bad Drive key.');
    const p = path.join(root, ...key.split('/'));
    if (!p.startsWith(path.resolve(root) + path.sep)) throw new Error('Bad Drive key.');
    return p;
  };
  return {
    kind: 'local',
    async putFile(key, src) {
      const dest = file(key);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      try { await fs.promises.rename(src, dest); } // same disk: the temp file lives under the same drive dir
      catch { await fs.promises.copyFile(src, dest); await fs.promises.rm(src, { force: true }); }
    },
    async get(key) {
      const p = file(key);
      await fs.promises.access(p);
      return fs.createReadStream(p, { highWaterMark: 256 * 1024 });
    },
    async remove(key) { await fs.promises.rm(file(key), { force: true }); },
  };
}

function send(method: 'PUT' | 'GET' | 'DELETE', url: string, body?: { src: string; size: number }): Promise<http.IncomingMessage> {
  const u = new URL(url);
  const lib = u.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers: body ? { 'content-length': String(body.size), 'content-type': 'application/octet-stream' } : {}, timeout: 120_000 }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Drive storage ${method} timed out.`)));
    if (body) fs.createReadStream(body.src).on('error', (e) => req.destroy(e)).pipe(req);
    else req.end();
  });
}
async function drain(res: http.IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of res) { if (parts.length < 16) parts.push(c as Buffer); }
  return Buffer.concat(parts).toString('utf8').slice(0, 300);
}

export function s3Storage(c: S3Config): DriveStorage {
  const url = (method: 'PUT' | 'GET' | 'DELETE', key: string) => {
    if (!validKey(key)) throw new Error('Bad Drive key.');
    return presign({ method, url: `${c.endpoint}/${c.bucket}/${key}`, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, expires: 900 });
  };
  return {
    kind: 's3',
    async putFile(key, src, size) {
      const res = await send('PUT', url('PUT', key), { src, size });
      const text = await drain(res);
      await fs.promises.rm(src, { force: true });
      if ((res.statusCode ?? 0) >= 300) throw new Error(`Object storage refused the upload (${res.statusCode}): ${text}`);
    },
    async get(key) {
      const res = await send('GET', url('GET', key));
      if ((res.statusCode ?? 0) >= 300) { const t = await drain(res); throw new Error(`Object storage: ${res.statusCode} ${t}`); }
      return res;
    },
    async remove(key) {
      const res = await send('DELETE', url('DELETE', key));
      const t = await drain(res);
      if ((res.statusCode ?? 0) >= 300 && res.statusCode !== 404) throw new Error(`Object storage refused the delete (${res.statusCode}): ${t}`);
    },
  };
}

/** The backend for this install: S3 when configured, else local disk under `localRoot`. */
export function driveStorage(localRoot: string, env: NodeJS.ProcessEnv = process.env): DriveStorage {
  const c = s3Config(env);
  return c ? s3Storage(c) : localStorage(localRoot);
}
