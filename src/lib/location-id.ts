import crypto from 'crypto';

// Permanent account ids, like GoHighLevel's location and agency ids (D, 2026-10-09: "a unique location ID for the business and
// agency, so when we sell this they can join in support"). 'loc_' + 20 base62 for a business, 'agc_' + 20 for the agency.
// Made once and never changed: the first id is derived from the business key with an HMAC of the install secret, so the three app
// copies compute the same id even before one of them writes it back to businesses.json; after that the saved id wins forever.

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The install secret ids derive from. AUTH_SECRET is the same in every app copy of one install. */
export function installSecret(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTH_SECRET || env.NEXTAUTH_SECRET || 'ctrl-os-install';
}

/** `n` base62 characters from bytes, without modulo bias (rejection sampling on each byte). */
function base62From(next: () => Buffer, n: number): string {
  let out = '';
  while (out.length < n) {
    for (const byte of next()) {
      if (byte < 248) out += B62[byte % 62]; // 248 = 4 * 62: bytes above it would favour the first characters
      if (out.length === n) break;
    }
  }
  return out;
}

export function randomBase62(n: number): string {
  return base62From(() => crypto.randomBytes(Math.max(16, n * 2)), n);
}

export const idPrefix = (module: string) => (module === 'agency' ? 'agc' : 'loc');

/** The id a business gets the first time it is seen: the same in every app copy of the install. */
export function derivedBusinessId(key: string, module: string, secret = installSecret()): string {
  let counter = 0;
  const next = () => crypto.createHmac('sha256', secret).update(`ctrl-os business id v1:${key}:${counter++}`).digest();
  return `${idPrefix(module)}_${base62From(next, 20)}`;
}

