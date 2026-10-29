import 'server-only';
import crypto from 'crypto';

// Secrets at rest (D, 2026-10-09: AI connections): AES-256-GCM with a key from TOKEN_ENCRYPTION_KEY, else derived from AUTH_SECRET.
// Output: "v1:<iv>:<tag>:<data>" in base64url. Losing the key loses what was sealed with it (the connection just needs reconnecting).
function key(): Buffer {
  const k = process.env.TOKEN_ENCRYPTION_KEY || process.env.AUTH_SECRET;
  if (!k) throw new Error('No TOKEN_ENCRYPTION_KEY or AUTH_SECRET set: secrets cannot be stored.');
  return crypto.createHash('sha256').update(`ctrlos:${k}`).digest();
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}

export function unseal(sealed: string): string {
  const [v, iv, tag, data] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable secret.');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}
