import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { agencyKey, decryptBuffer, DecryptStream, encryptBuffer, encryptedSize, EncryptStream, HEADER_LEN, FRAME_OVERHEAD, keysFor } from '../crypto';
import { presign } from '../sigv4';
import { fileKey, keyAgency, localStorage, validKey } from '../storage';

// Drive encryption, signer and local storage (D, 2026-10-10). Pure: no app database, no network.
const env = { AUTH_SECRET: 'drive-test-secret' } as unknown as NodeJS.ProcessEnv;
const A = 'agc_AAAAAAAAAAAAAAAAAAAA', B = 'agc_BBBBBBBBBBBBBBBBBBBB';
const keyA = agencyKey(A, 1, env), keyB = agencyKey(B, 1, env);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlos-drive-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function streamEncrypt(plain: Buffer, key: Buffer, chunk: number) {
  const e = new EncryptStream(key, 1, chunk);
  const parts: Buffer[] = [];
  await pipeline(Readable.from([plain.subarray(0, 777), plain.subarray(777)]), e, async function* (src) { for await (const c of src) parts.push(c as Buffer); });
  return { stored: Buffer.concat(parts), stats: e.stats() };
}
async function streamDecrypt(stored: Buffer, agency: string) {
  const parts: Buffer[] = [];
  await pipeline(Readable.from([stored.subarray(0, 100), stored.subarray(100)]), new DecryptStream(keysFor(agency, env)), async function* (src) { for await (const c of src) parts.push(c as Buffer); });
  return Buffer.concat(parts);
}

describe('drive encryption', () => {
  it('round trips small, empty, exact-multiple and multi-chunk files (stream and buffer)', async () => {
    for (const size of [0, 5, 4096, 4096 * 3, 4096 * 3 + 17]) {
      const plain = crypto.randomBytes(size);
      const { stored, stats } = await streamEncrypt(plain, keyA, 4096);
      expect(stored.length).toBe(encryptedSize(size, 4096));
      expect(stats).toEqual({ bytes: size, sha256: crypto.createHash('sha256').update(plain).digest('hex') });
      expect((await streamDecrypt(stored, A)).equals(plain)).toBe(true);
      expect(decryptBuffer(encryptBuffer(plain, keyA, 1, 4096), keysFor(A, env)).equals(plain)).toBe(true);
    }
  });
  it('the plaintext never appears in the stored bytes', async () => {
    const plain = Buffer.from('SECRET-CLIENT-CONTRACT '.repeat(2000));
    const { stored } = await streamEncrypt(plain, keyA, 4096);
    expect(stored.includes(Buffer.from('SECRET-CLIENT'))).toBe(false);
    expect(stored.subarray(0, 4).toString()).toBe('CTDR');
  });
  it('a changed, swapped or cut-off chunk fails', async () => {
    const plain = crypto.randomBytes(4096 * 3 + 10);
    const { stored } = await streamEncrypt(plain, keyA, 4096);
    const flipped = Buffer.from(stored); flipped[HEADER_LEN + FRAME_OVERHEAD + 50] ^= 1;
    await expect(streamDecrypt(flipped, A)).rejects.toThrow();
    const frame = 4096 + FRAME_OVERHEAD;
    const swapped = Buffer.concat([stored.subarray(0, HEADER_LEN), stored.subarray(HEADER_LEN + frame, HEADER_LEN + 2 * frame), stored.subarray(HEADER_LEN, HEADER_LEN + frame), stored.subarray(HEADER_LEN + 2 * frame)]);
    await expect(streamDecrypt(swapped, A)).rejects.toThrow();
    const cut = stored.subarray(0, HEADER_LEN + 2 * frame); // drop the last frames: the new last one was not sealed as final
    await expect(streamDecrypt(cut, A)).rejects.toThrow();
    expect(() => decryptBuffer(cut, keysFor(A, env))).toThrow();
  });
  it("agency A's key cannot open agency B's file", async () => {
    const { stored } = await streamEncrypt(Buffer.from('agency b only'), keyB, 4096);
    await expect(streamDecrypt(stored, A)).rejects.toThrow();
    expect((await streamDecrypt(stored, B)).toString()).toBe('agency b only');
    expect(keyA.equals(keyB)).toBe(false);
    expect(agencyKey(A, 1, { DRIVE_ENCRYPTION_KEY: 'x', AUTH_SECRET: 'drive-test-secret' } as unknown as NodeJS.ProcessEnv).equals(keyA)).toBe(false);
  });
  it('an old key version needs its own env key', () => {
    const e2 = { AUTH_SECRET: 'new', DRIVE_KEY_VERSION: '2', DRIVE_ENCRYPTION_KEY_V1: 'drive-test-secret' } as unknown as NodeJS.ProcessEnv;
    const sealed = encryptBuffer(Buffer.from('v1 file'), keyA, 1);
    expect(decryptBuffer(sealed, keysFor(A, e2)).toString()).toBe('v1 file');
    expect(() => keysFor(A, { AUTH_SECRET: 'new', DRIVE_KEY_VERSION: '2' } as unknown as NodeJS.ProcessEnv)(1)).toThrow(/DRIVE_ENCRYPTION_KEY_V1/);
  });
});

describe('sigv4 presign', () => {
  it("matches AWS's published presigned GET example", () => {
    const url = presign({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', accessKeyId: 'AKIA' + 'IOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrX' + 'UtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', expires: 86400, now: new Date('2013-05-24T00:00:00Z') });
    expect(url).toBe('https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA' + 'IOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });
});

describe('storage keys and the local backend', () => {
  it('keys are always prefixed by the agency id and never climb out', () => {
    expect(fileKey(A, 'abc123')).toBe(`agencies/${A}/files/abc123.ctd`);
    expect(keyAgency(fileKey(B, 'x'))).toBe(B);
    for (const bad of ['agencies/../x/files/a', `agencies/${A}/files/../../etc`, `other/${A}/files/a`, `agencies/${A}/files/`, 'agencies/a b/files/x']) expect(validKey(bad)).toBe(false);
    expect(() => fileKey('../evil', 'x')).toThrow();
  });
  it('round trips a file through local disk', async () => {
    const s = localStorage(path.join(tmp, 'drive'));
    const src = path.join(tmp, 'up.tmp');
    fs.writeFileSync(src, 'ciphertext-bytes');
    const key = fileKey(A, 'f1');
    await s.putFile(key, src, 16);
    expect(fs.existsSync(src)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'drive', 'agencies', A, 'files', 'f1.ctd'))).toBe(true);
    const parts: Buffer[] = [];
    for await (const c of await s.get(key)) parts.push(c as Buffer);
    expect(Buffer.concat(parts).toString()).toBe('ciphertext-bytes');
    await s.remove(key);
    await expect(s.get(key)).rejects.toThrow();
  });
});
