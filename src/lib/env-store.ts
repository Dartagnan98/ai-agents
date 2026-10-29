import crypto from 'crypto';
import fs from 'fs';
import { writeFileAtomic } from '@/lib/org-files';

// Encryption at rest for the install's env files (D, 2026-10-10: "it needs to be encrypted"; runbook docs/SECRETS_ENCRYPTION.md).
// Off (FLEET_SECRETS_ENC unset): the plain file, read and written exactly as before. On (FLEET_SECRETS_ENC=1): the file's whole text
// sealed as ONE blob in <file>.enc, so every reader still parses the same NAME=value text (comments, order, quoting kept).
//   <file>.enc = "fenv1:<iv>:<tag>:<data>\n", base64url, AES-256-GCM, 12-byte iv, AAD "ctrl-fleet-env:v1".
//   Key: 32 random bytes, base64 (or 64 hex) on one line in FLEET_SECRETS_KEY_FILE (default /etc/ctrl-fleet/secrets.key, root 0400).
//   A dedicated key, NOT AUTH_SECRET / TOKEN_ENCRYPTION_KEY: data and key are separate files. Python twin: fleet-sync/fleet_secrets.py.
// Rollout rule: on, reads take <file>.enc when it exists (else the plain file); writes seal <file>.enc and, while the plain file still
// exists, rewrite it too, so readers not switched yet see the same keys. Shredding the plain file ends the mirror.

export const ENC_PREFIX = 'fenv1';
export const ENC_SUFFIX = '.enc';
const AAD = Buffer.from('ctrl-fleet-env:v1');
const DEFAULT_KEY_FILE = '/etc/ctrl-os/secrets.key'; // install.sh makes it; the agency's box sets FLEET_SECRETS_KEY_FILE

export const envStoreEnabled = (): boolean => process.env.FLEET_SECRETS_ENC === '1';
export const keyFilePath = (): string => process.env.FLEET_SECRETS_KEY_FILE || DEFAULT_KEY_FILE;
export const encPath = (plainPath: string): string => (plainPath.endsWith(ENC_SUFFIX) ? plainPath : plainPath + ENC_SUFFIX);

/** The 32-byte key from its text form: base64 / base64url, or 64 hex characters. */
export function parseKey(text: string): Buffer {
  const t = text.trim();
  const k = /^[0-9a-fA-F]{64}$/.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (k.length !== 32) throw new Error('FLEET_SECRETS_KEY_FILE does not hold a 32-byte key.');
  return k;
}

let cached: { file: string; mtimeMs: number; key: Buffer } | null = null;
function loadKey(): Buffer {
  const file = keyFilePath();
  const st = fs.statSync(file);
  if (cached && cached.file === file && cached.mtimeMs === st.mtimeMs) return cached.key;
  const key = parseKey(fs.readFileSync(file, 'utf8'));
  cached = { file, mtimeMs: st.mtimeMs, key };
  return key;
}

export function sealEnvText(text: string, key: Buffer = loadKey()): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(AAD);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [ENC_PREFIX, iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join(':') + '\n';
}

export function unsealEnvText(blob: string, key: Buffer = loadKey()): string {
  const [v, iv, tag, data, extra] = blob.trim().split(':');
  if (v !== ENC_PREFIX || !iv || !tag || data === undefined || extra !== undefined) throw new Error('Not an encrypted env file.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/** The env file's text. Throws like fs.readFileSync (ENOENT) when there is nothing to read, so callers keep their try/catch. */
export function readEnvStore(plainPath: string): string {
  if (!envStoreEnabled()) return fs.readFileSync(plainPath, 'utf-8');
  const enc = encPath(plainPath);
  if (fs.existsSync(enc)) return unsealEnvText(fs.readFileSync(enc, 'utf-8'));
  return fs.readFileSync(plainPath, 'utf-8'); // not encrypted yet (rollout step 1)
}

/** Replaces the env file's text atomically (temp file + rename, 0600). On: seals <file>.enc, and mirrors the plain file while it exists. */
export function writeEnvStore(plainPath: string, text: string): void {
  if (!envStoreEnabled()) { writeFileAtomic(plainPath, text, 0o600); return; }
  const sealed = sealEnvText(text);
  writeFileAtomic(encPath(plainPath), sealed, 0o600);
  if (plainPath !== encPath(plainPath) && fs.existsSync(plainPath)) writeFileAtomic(plainPath, text, 0o600);
}
