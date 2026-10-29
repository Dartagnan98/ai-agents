import { auth } from './auth';
import { OWNER_ACCESS, type AccessGrant, type AccessRole } from './access';
import { db } from './db';
import { isMultiTenant } from './platform/mode';
import { tenantContextSync } from './platform/context';
import { currentAgencySync } from './platform/tenant-db';
import { getMembership, membershipByLocal, setMembershipGrant } from './platform/db';
import { linkLocalUser, unlinkLocalUser } from './platform/users';
import { readViewAs } from './view-as';

interface AccessRow { full: number; role?: string; ai: string; businesses: string }
interface SessionLike { user?: { id?: string | null; name?: string | null; supportSid?: string | null; agency?: string | null } | null }

export function ownerId(): number | null {
  const row = db.prepare('SELECT MIN(id) as id FROM users').get() as { id: number | null } | undefined;
  return row?.id ?? null;
}

/** The login this request acts as: the signed-in one, or the login an owner is viewing as (lib/view-as.ts, read-only). */
export function sessionUserId(session: SessionLike | null): number | null {
  const real = realSessionUserId(session);
  if (real === null) return null;
  const v = readViewAs();
  if (!v || v.real !== real || v.target === real || v.principal !== String(session?.user?.id ?? '')) return real;
  if (getGrant(real).role !== 'owner' || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(v.target)) return real;
  return v.target;
}

/** The signed-in login itself, never a View as login (setting View as, the banner that says who is looking). */
export function realSessionUserId(session: SessionLike | null): number | null {
  if (isMultiTenant()) return tenantSessionUserId(session);
  return sessionLoginId(session);
}

/** Multi-agency mode (D, 2026-10-09): the session names a platform user (usr_...); the login it acts as is that user's row in the
 *  current agency (its membership). The agency comes from the signed cookie, which must have been issued to this same session, or from
 *  runWithTenant. A support session counts only in its own agency and while its support session is on. Anything else: no login. */
function tenantSessionUserId(session: SessionLike | null): number | null {
  const ctx = tenantContextSync();
  const u = session?.user;
  if (!ctx || !u) return null;
  const uid = u.id;
  if (typeof uid !== 'string' || !uid.startsWith('usr_')) return null;
  if (ctx.source === 'cookie' && ctx.principal !== uid) return null;
  const m = getMembership(uid, ctx.agencyId);
  if (!m || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(m.localUserId)) return null;
  return m.localUserId;
}

function sessionLoginId(session: SessionLike | null): number | null {
  const raw = session?.user?.id;
  const id = raw ? Number(raw) : NaN;
  if (Number.isInteger(id) && id > 0) return id;
  const name = session?.user?.name;
  if (!name) return null;
  const row = db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: number } | undefined;
  return row?.id ?? null;
}

/** True while an owner views as someone else (lib/view-as.ts): pages skip their own small writes (marking read). */
export async function viewingAs(): Promise<boolean> {
  const session = await auth();
  const real = realSessionUserId(session);
  return real !== null && sessionUserId(session) !== real;
}

export async function currentUserId(): Promise<number | null> {
  return sessionUserId(await auth());
}

function roleOf(raw: string | undefined): AccessRole {
  return raw === 'admin' || raw === 'owner' || raw === 'manager' || raw === 'client' ? raw : 'user';
}

function parseBusinesses(raw: string): Record<string, string[]> {
  const businesses: Record<string, string[]> = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value)) businesses[key] = value.filter((item): item is string => typeof item === 'string');
      }
    }
  } catch { /* a bad row grants nothing for businesses */ }
  return businesses;
}

function everyBusinessAdmin(): AccessGrant {
  return { role: 'admin', ai: [], businesses: {} };
}

function parseGrant(row: AccessRow): AccessGrant {
  return { role: roleOf(row.role), ai: parseStringList(row.ai), businesses: parseBusinesses(row.businesses) };
}

function parseStringList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** Owners see everything, new contracts included: the first account (it set the workspace up) and anyone made an owner in
 *  Settings › Users (D, 2026-10-02: three owners need every contract, all the time). A legacy full=1 row is an admin of
 *  every current business, with AI on. */
export function getGrant(userId: number): AccessGrant {
  if (userId === ownerId()) return { ...OWNER_ACCESS };
  // a login removed in Settings › Users keeps its signed cookie until it expires: it gets nothing (it read as an admin of every
  // business before, settings audit 2026-10-06, because a missing access row meant a legacy full login)
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return { role: 'user', ai: [], businesses: {} };
  // multi-agency mode: the grant is the login's membership in this agency (kept in step with user_access by saveGrant)
  const row = isMultiTenant() ? membershipRow(userId) : db.prepare('SELECT full, role, ai, businesses FROM user_access WHERE user_id = ?').get(userId) as AccessRow | undefined;
  if (isMultiTenant() && !row) return { role: 'user', ai: [], businesses: {} }; // no membership here: nothing open
  if (row?.role === 'owner') return { ...OWNER_ACCESS };
  if (!row || row.full) return everyBusinessAdmin();
  const grant = parseGrant(row);
  return grant;
}

function membershipRow(userId: number): AccessRow | undefined {
  const m = membershipByLocal(currentAgencySync().id, userId);
  return m ? { full: m.full ? 1 : 0, role: m.role, ai: JSON.stringify(m.ai), businesses: JSON.stringify(m.businesses) } : undefined;
}

export async function requireFullAccess(): Promise<number> {
  const id = await currentUserId();
  const role = id ? getGrant(id).role : null; // Settings is for the owner and admins (D, 2026-10-02)
  if (!id || (role !== 'owner' && role !== 'admin')) throw new Error('Only the owner or an admin can change settings.');
  return id;
}

/** Only an owner makes, changes or removes an owner, and nobody changes the first owner. Throws a plain reason. */
export function assertMayChange(actor: number, target: number, newRole?: AccessRole): void {
  if (target === ownerId()) throw new Error('The first owner cannot be changed here.');
  if (getGrant(actor).role !== 'owner' && (newRole === 'owner' || getGrant(target).role === 'owner')) throw new Error('Only an owner can make, change or remove an owner.');
}

export function saveGrant(userId: number, grant: AccessGrant): void {
  if (userId === ownerId()) return;
  const role: AccessRole = grant.role === 'owner' || grant.role === 'admin' || grant.role === 'manager' || grant.role === 'client' ? grant.role : 'user';
  db.prepare(`INSERT INTO user_access (user_id, full, role, ai, businesses) VALUES (?, 0, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET full = 0, role = excluded.role, ai = excluded.ai, businesses = excluded.businesses`)
    .run(userId, role, JSON.stringify(grant.ai), JSON.stringify(grant.businesses));
  if (isMultiTenant()) setMembershipGrant(currentAgencySync().id, userId, { role, ai: grant.ai, businesses: grant.businesses, full: false });
}

/** A new account starts as a user with nothing open. Access is granted from Settings > Users. */
export function grantEmpty(userId: number): void {
  if (userId === ownerId()) return;
  db.prepare(`INSERT INTO user_access (user_id, full, role, ai, businesses) VALUES (?, 0, 'user', '[]', '{}')
    ON CONFLICT(user_id) DO NOTHING`).run(userId);
  // multi-agency mode: the new login also gets its platform user + an empty membership; if that fails (name taken) the row goes
  if (isMultiTenant()) {
    try { linkLocalUser(userId); } catch (e) {
      db.prepare('DELETE FROM user_access WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      throw e;
    }
  }
}

export function deleteGrant(userId: number): void {
  db.prepare('DELETE FROM user_access WHERE user_id = ?').run(userId);
  if (isMultiTenant()) unlinkLocalUser(userId);
}
