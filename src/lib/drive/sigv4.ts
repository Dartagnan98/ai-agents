import crypto from 'crypto';

// AWS Signature Version 4, query-string form (presigned URLs), for the Drive's S3-compatible backend (D, 2026-10-10). Small on purpose:
// no SDK in the app. One signer covers PUT, GET and DELETE: the payload is UNSIGNED-PAYLOAD (allowed for presigned S3 requests), only
// `host` is signed. Works with Cloudflare R2 (region 'auto'), Hetzner Object Storage, MinIO and AWS. Tested against AWS's published
// presigned GET example (lib/drive/__tests__/sigv4.test.ts).

export interface Presign {
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  url: string; // https://host/bucket/key (path style) or https://bucket.host/key
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  expires?: number; // seconds, 1..604800 (default 900)
  now?: Date;
  service?: string; // default s3
}

/** RFC 3986 encoding as SigV4 wants it (A-Z a-z 0-9 - _ . ~ stay). */
export const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (k: Buffer | string, s: string) => crypto.createHmac('sha256', k).update(s, 'utf8').digest();

/** The key path as stored ("agencies/agc_x/files/ab/cd.bin") made into a canonical URI: each segment encoded, slashes kept. */
export const canonicalPath = (pathname: string) => pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/');

export function presign(p: Presign): string {
  const u = new URL(p.url);
  const now = p.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20130524T000000Z
  const day = amzDate.slice(0, 8);
  const service = p.service ?? 's3';
  const scope = `${day}/${p.region}/${service}/aws4_request`;
  const expires = Math.min(Math.max(Math.floor(p.expires ?? 900), 1), 604800);
  const q: [string, string][] = [...u.searchParams.entries()];
  q.push(['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'], ['X-Amz-Credential', `${p.accessKeyId}/${scope}`], ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)], ['X-Amz-SignedHeaders', 'host']);
  const query = q.map(([k, v]) => [enc(k), enc(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const path = canonicalPath(u.pathname || '/');
  const canonical = [p.method, path, query, `host:${u.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${p.secretAccessKey}`, day), p.region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  return `${u.protocol}//${u.host}${path}?${query}&X-Amz-Signature=${signature}`;
}
