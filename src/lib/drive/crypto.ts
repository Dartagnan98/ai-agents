import crypto from 'crypto';
import { Transform, type TransformCallback } from 'stream';

// Drive encryption at rest (D, 2026-10-10: "they upload whatever, it's encrypted"). Every stored object is ciphertext: the disk and the
// object store (R2, Hetzner) never see a plaintext byte. AES-256-GCM in independent chunks so a 200 MB video streams in and out without
// sitting in memory. Pure (no app imports) so the tests can run it directly. Format, docs/DRIVE.md "Encryption":
//
//   header (27 bytes) = "CTDR" | format u8 (1) | key version u16 BE | chunk size u32 BE | file nonce (16 random bytes)
//   then frames       = IV (12 random bytes) | ciphertext | GCM tag (16)
//
// Every frame but the last holds exactly `chunk size` plaintext bytes; the last holds 0 .. chunk size - 1 (so a file whose size is a
// multiple of the chunk ends with an empty frame). Each frame's additional data is header | frame index u64 BE | final flag u8, which
// binds a frame to its file (the nonce), its place (no reordering) and the end (cutting frames off fails: the new last frame was not
// sealed as final). Keys: HKDF-SHA256 from the install's master secret with the agency id in the info, so one agency's key never opens
// another agency's file.

export const MAGIC = Buffer.from('CTDR');
export const FORMAT = 1;
export const HEADER_LEN = 27;
export const IV_LEN = 12;
export const TAG_LEN = 16;
export const FRAME_OVERHEAD = IV_LEN + TAG_LEN;
export const DEFAULT_CHUNK = 1024 * 1024; // 1 MiB

/** The master secret: DRIVE_ENCRYPTION_KEY, else TOKEN_ENCRYPTION_KEY, else AUTH_SECRET (lib/secret-crypto.ts order, Drive first). An older
 *  key version is read from DRIVE_ENCRYPTION_KEY_V<n> (key rotation, docs/DRIVE.md). */
export function masterSecret(version: number, env: NodeJS.ProcessEnv = process.env): string {
  if (version !== currentKeyVersion(env)) {
    const old = env[`DRIVE_ENCRYPTION_KEY_V${version}`];
    if (!old) throw new Error(`Drive key version ${version} is not configured (DRIVE_ENCRYPTION_KEY_V${version}).`);
    return old;
  }
  const k = env.DRIVE_ENCRYPTION_KEY || env.TOKEN_ENCRYPTION_KEY || env.AUTH_SECRET;
  if (!k) throw new Error('No DRIVE_ENCRYPTION_KEY, TOKEN_ENCRYPTION_KEY or AUTH_SECRET set: files cannot be encrypted.');
  return k;
}

/** The key version new files are sealed with: DRIVE_KEY_VERSION (1..65535), default 1. */
export function currentKeyVersion(env: NodeJS.ProcessEnv = process.env): number {
  const n = Math.floor(Number(env.DRIVE_KEY_VERSION || 1));
  return n >= 1 && n <= 65535 ? n : 1;
}

/** The agency's data key for one key version. */
export function agencyKey(agencyId: string, version: number, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (!agencyId) throw new Error('No agency for the Drive key.');
  return Buffer.from(crypto.hkdfSync('sha256', masterSecret(version, env), 'ctrlos-drive v1', `agency:${agencyId}|key:${version}`, 32));
}

export type KeyFor = (version: number) => Buffer;
export const keysFor = (agencyId: string, env: NodeJS.ProcessEnv = process.env): KeyFor => (v) => agencyKey(agencyId, v, env);

/** Stored size for a plaintext size (the upload path checks quota and Content-Length with it). */
export function encryptedSize(plainBytes: number, chunk = DEFAULT_CHUNK): number {
  const full = Math.floor(plainBytes / chunk);
  return HEADER_LEN + (full + 1) * FRAME_OVERHEAD + plainBytes;
}

function header(keyVersion: number, chunk: number, nonce = crypto.randomBytes(16)): Buffer {
  const h = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(h, 0); h.writeUInt8(FORMAT, 4); h.writeUInt16BE(keyVersion, 5); h.writeUInt32BE(chunk, 7); nonce.copy(h, 11);
  return h;
}
function aad(head: Buffer, index: number, final: boolean): Buffer {
  const a = Buffer.alloc(HEADER_LEN + 9);
  head.copy(a, 0); a.writeBigUInt64BE(BigInt(index), HEADER_LEN); a.writeUInt8(final ? 1 : 0, HEADER_LEN + 8);
  return a;
}
function seal(key: Buffer, head: Buffer, index: number, final: boolean, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(head, index, final));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, body, c.getAuthTag()]);
}
function open(key: Buffer, head: Buffer, index: number, final: boolean, frame: Buffer): Buffer {
  if (frame.length < FRAME_OVERHEAD) throw new Error('Drive file is cut short.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, frame.subarray(0, IV_LEN));
  d.setAAD(aad(head, index, final));
  d.setAuthTag(frame.subarray(frame.length - TAG_LEN));
  return Buffer.concat([d.update(frame.subarray(IV_LEN, frame.length - TAG_LEN)), d.final()]);
}

/** Plaintext in, stored bytes out. `stats()` after 'end' = plaintext bytes and sha256 (hex). */
export class EncryptStream extends Transform {
  private head: Buffer; private pending: Buffer[] = []; private pendingLen = 0; private index = 0;
  private hash = crypto.createHash('sha256'); private bytes = 0; private digest = '';
  constructor(private key: Buffer, readonly keyVersion: number, private chunk = DEFAULT_CHUNK) {
    super();
    if (key.length !== 32) throw new Error('Drive key must be 32 bytes.');
    this.head = header(keyVersion, chunk);
    this.push(this.head);
  }
  _transform(data: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.hash.update(data); this.bytes += data.length;
    this.pending.push(data); this.pendingLen += data.length;
    if (this.pendingLen >= this.chunk) {
      let buf = Buffer.concat(this.pending);
      while (buf.length >= this.chunk) { this.push(seal(this.key, this.head, this.index++, false, buf.subarray(0, this.chunk))); buf = buf.subarray(this.chunk); }
      this.pending = buf.length ? [Buffer.from(buf)] : []; this.pendingLen = buf.length;
    }
    cb();
  }
  _flush(cb: TransformCallback) {
    this.push(seal(this.key, this.head, this.index++, true, Buffer.concat(this.pending)));
    this.pending = []; this.digest = this.hash.digest('hex');
    cb();
  }
  stats() { return { bytes: this.bytes, sha256: this.digest }; }
}

/** Stored bytes in, plaintext out; any changed, moved, swapped or missing frame fails the stream with an error. */
export class DecryptStream extends Transform {
  private head: Buffer | null = null; private key: Buffer | null = null; private frame = 0; private buf: Buffer = Buffer.alloc(0); private index = 0;
  constructor(private keyFor: KeyFor) { super(); }
  private parseHeader(): boolean {
    if (this.buf.length < HEADER_LEN) return false;
    const h = this.buf.subarray(0, HEADER_LEN);
    if (!h.subarray(0, 4).equals(MAGIC) || h.readUInt8(4) !== FORMAT) throw new Error('Not a Drive file (bad header).');
    const chunk = h.readUInt32BE(7);
    if (chunk < 1024 || chunk > 64 * 1024 * 1024) throw new Error('Drive file has a bad chunk size.');
    this.head = Buffer.from(h); this.key = this.keyFor(h.readUInt16BE(5)); this.frame = chunk + FRAME_OVERHEAD;
    this.buf = this.buf.subarray(HEADER_LEN);
    return true;
  }
  _transform(data: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    try {
      this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
      if (!this.head && !this.parseHeader()) return cb();
      // a full-size frame is never the last one (the last holds less than a chunk), so it can be opened at once
      while (this.buf.length >= this.frame) {
        this.push(open(this.key!, this.head!, this.index++, false, this.buf.subarray(0, this.frame)));
        this.buf = this.buf.subarray(this.frame);
      }
      if (this.buf.length && this.buf.byteOffset > 0) this.buf = Buffer.from(this.buf);
      cb();
    } catch (e) { cb(e as Error); }
  }
  _flush(cb: TransformCallback) {
    try {
      if (!this.head) throw new Error('Drive file is cut short.');
      this.push(open(this.key!, this.head, this.index++, true, this.buf));
      cb();
    } catch (e) { cb(e as Error); }
  }
}

/** Whole-buffer helpers (small files, notes, tests). */
export function encryptBuffer(plain: Buffer, key: Buffer, keyVersion = 1, chunk = DEFAULT_CHUNK): Buffer {
  const head = header(keyVersion, chunk);
  const out = [head];
  let i = 0, off = 0;
  for (; plain.length - off >= chunk; off += chunk) out.push(seal(key, head, i++, false, plain.subarray(off, off + chunk)));
  out.push(seal(key, head, i, true, plain.subarray(off)));
  return Buffer.concat(out);
}
export function decryptBuffer(stored: Buffer, keyFor: KeyFor): Buffer {
  if (stored.length < HEADER_LEN || !stored.subarray(0, 4).equals(MAGIC) || stored.readUInt8(4) !== FORMAT) throw new Error('Not a Drive file (bad header).');
  const head = stored.subarray(0, HEADER_LEN), key = keyFor(head.readUInt16BE(5)), frame = head.readUInt32BE(7) + FRAME_OVERHEAD;
  const out: Buffer[] = [];
  let off = HEADER_LEN, i = 0;
  for (; stored.length - off >= frame; off += frame) out.push(open(key, head, i++, false, stored.subarray(off, off + frame)));
  out.push(open(key, head, i, true, stored.subarray(off)));
  return Buffer.concat(out);
}
