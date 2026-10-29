import crypto from 'crypto';
import { installSecret } from '@/lib/location-id';
import { requestCookie, tenantKey } from '@/lib/platform/context';

// View as (D, 2026-10-28: "a view as user for every user so we can see what they see"). An owner picks a login in Settings › Users;
// this browser then gets that login's pages and numbers until they stop or it expires (2 hours). It is read-only: the middleware refuses
// every write while the cookie is set, so nothing done while looking changes anyone's data. The cookie is signed with the install
// secret and names the agency, the owner's own login and session, so it opens nothing for anyone else or in another agency.
// lib/user-access.ts sessionUserId applies it (after checking the real login is still an owner); /api/view-as sets and clears it.
export const VIEW_AS_COOKIE = 'ctrlos_viewas';
export const VIEW_AS_TTL_MS = 2 * 3600_000;

const sign = (body: string, secret = installSecret()) => crypto.createHmac('sha256', secret).update(`ctrlos-viewas v1:${tenantKey()}:${body}`).digest('base64url');

/** target / real = local login ids; principal = the real session's user id (usr_... on multi-agency installs). */
export function signViewAs(target: number, real: number, principal: string, now = Date.now()): string {
  const body = `${target}.${real}.${now + VIEW_AS_TTL_MS}.${Buffer.from(principal).toString('base64url')}`;
  return `${body}.${sign(body)}`;
}

export function readViewAs(value: string | undefined = requestCookie(VIEW_AS_COOKIE), now = Date.now()): { target: number; real: number; principal: string; exp: number } | null {
  const m = value ? /^(\d{1,9})\.(\d{1,9})\.(\d{13})\.([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{43})$/.exec(value) : null;
  if (!m) return null;
  const want = Buffer.from(sign(`${m[1]}.${m[2]}.${m[3]}.${m[4]}`)), got = Buffer.from(m[5]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const exp = Number(m[3]);
  if (exp <= now) return null;
  return { target: Number(m[1]), real: Number(m[2]), principal: Buffer.from(m[4], 'base64url').toString(), exp };
}
