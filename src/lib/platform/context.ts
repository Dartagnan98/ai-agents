import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { installSecret } from '../location-id';
import { isMultiTenant } from './mode';
import { getAgency, getMembership } from './db';

// Which agency this code runs for (D, 2026-10-09, docs/MULTI_TENANT.md). Synchronous on purpose: `db` and getBusinesses() are sync
// and called everywhere. Two sources, checked in order:
//  1. runWithTenant(agencyId, fn): background work (routines, sync, scripts, the support sign-in) sets it explicitly. A child process
//     the app starts for one agency gets CTRLOS_CHILD_TENANT instead (outside any request only).
//  2. The request's `ctrlos_agency` cookie, read from Next's request store. The value is signed with AUTH_SECRET and names the agency
//     and the login it was issued to (`agc.principal.sig`); it counts only while that login is still a member of an active agency.
//     The session itself is checked against the principal in lib/user-access.ts (sessionUserId), so a cookie left by another login
//     in the same browser opens nothing. Only /api/platform/agency issues it, after checking the membership.
// Nothing else: no cookie and no runWithTenant = no agency (NoTenantError at the first db call), never a fallback.

export const TENANT_COOKIE = 'ctrlos_agency';
export interface TenantContext { agencyId: string; principal: string | null; source: 'als' | 'cookie' }

const G = globalThis as typeof globalThis & { __ctrlosTenantAls?: AsyncLocalStorage<{ agencyId: string }> };
const als = (G.__ctrlosTenantAls ??= new AsyncLocalStorage<{ agencyId: string }>());

/** Runs fn (and everything it awaits) as agency `agencyId`. */
export function runWithTenant<T>(agencyId: string, fn: () => T): T {
  if (!/^agc_[0-9A-Za-z]{20}$/.test(agencyId)) throw new Error('Bad agency id.');
  return als.run({ agencyId }, fn);
}
export const tenantFromAls = (): string | null => als.getStore()?.agencyId ?? null;

const sig = (agencyId: string, principal: string, secret: string) =>
  crypto.createHmac('sha256', secret).update(`ctrlos-agency v1:${agencyId}:${principal}`).digest('base64url');

/** principal = a platform user id (usr_...) or `sup-<sid>` for a support session. */
export function signTenantCookie(agencyId: string, principal: string, secret = installSecret()): string {
  return `${agencyId}.${principal}.${sig(agencyId, principal, secret)}`;
}
export function readTenantCookie(value: string | undefined | null, secret = installSecret()): { agencyId: string; principal: string } | null {
  if (!value) return null;
  const m = /^(agc_[0-9A-Za-z]{20})\.(usr_[0-9A-Za-z]{20}|sup-[A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return null;
  const want = Buffer.from(sig(m[1], m[2], secret)), got = Buffer.from(m[3]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? { agencyId: m[1], principal: m[2] } : null;
}

/** Whether `principal` may act in `agencyId` right now: an active agency and (for a login) a live membership. A support principal
 *  is checked against its support session by sessionUserId / the jwt callback, in that agency's own database. */
export function principalAllowed(principal: string, agencyId: string): boolean {
  const a = getAgency(agencyId);
  if (!a || a.status !== 'active') return false;
  if (principal.startsWith('sup-')) return true;
  return !!getMembership(principal, agencyId);
}

type CookieJar = { get(name: string): { value: string } | undefined };
const perRequest = new WeakMap<object, TenantContext | null>();
function requestStore(): { cookies: CookieJar } | null {
  try {
    const s = workUnitAsyncStorage.getStore() as { type?: string; cookies?: CookieJar } | undefined;
    return s && s.type === 'request' && s.cookies ? (s as { cookies: CookieJar }) : null;
  } catch { return null; }
}

/** One cookie of the current request, read synchronously like the agency cookie (lib/view-as.ts); undefined outside a request. */
export function requestCookie(name: string): string | undefined {
  return requestStore()?.cookies.get(name)?.value;
}

/** The current agency, or null (single-agency mode never calls this for data; see tenantKey). */
export function tenantContextSync(): TenantContext | null {
  const a = tenantFromAls();
  if (a) return { agencyId: a, principal: null, source: 'als' };
  const store = requestStore();
  if (!store) {
    // a child process the app started for one agency (lib/metrics/run.ts sets it; never set it on the server itself)
    const child = process.env.CTRLOS_CHILD_TENANT;
    return child && /^agc_[0-9A-Za-z]{20}$/.test(child) ? { agencyId: child, principal: null, source: 'als' } : null;
  }
  if (perRequest.has(store)) return perRequest.get(store)!;
  const c = readTenantCookie(store.cookies.get(TENANT_COOKIE)?.value);
  const ctx: TenantContext | null = c && principalAllowed(c.principal, c.agencyId) ? { ...c, source: 'cookie' } : null;
  perRequest.set(store, ctx);
  return ctx;
}

/** A short key for per-agency caches and schema flags: '' in single-agency mode (keys stay exactly as before), else the agency id
 *  ('none' when there is none, which db calls refuse anyway). */
export function tenantKey(): string {
  if (!isMultiTenant()) return '';
  return tenantContextSync()?.agencyId ?? 'none';
}
/** Prefix for module-level cache keys: '' single-agency, `<agc>|` multi. */
export const tenantCachePrefix = (): string => { const k = tenantKey(); return k ? `${k}|` : ''; };
