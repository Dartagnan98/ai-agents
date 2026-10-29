import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { CTX_ROOT } from '../config';
import { legacyDbPath } from '../db-schema';
const BUSINESS_ID = /^(loc|agc)_[0-9A-Za-z]{20}$/; // an agency id as stored
import { derivedBusinessId, randomBase62 } from '../location-id';
import { plainTyped } from '../login-user';
import { dataDir } from './mode';

// The platform database (D, 2026-10-09, docs/PLATFORM.md decision 3): one SQLite `platform.db` in CTRLOS_DATA_DIR for what spans
// agencies: agencies, global users (one login, many agencies), memberships (role + business grants per agency), an audit log and the
// sign-in rate limit. Everything else stays in each agency's own SQLite (lib/platform/tenant-db.ts). Only multi-agency mode opens it.

export type MemberRole = 'owner' | 'admin' | 'manager' | 'client' | 'user';
export interface Agency { id: string; name: string; slug: string; status: string; plan: string; createdAt: number; legacy: boolean }
export interface PlatformUser { id: string; email: string | null; username: string | null; name: string; passwordHash: string; createdAt: number }
export interface Membership { userId: string; agencyId: string; role: MemberRole; ai: string[]; businesses: Record<string, string[]>; full: boolean; localUserId: number; createdAt: number }
export interface AgencyPaths { dir: string; dbPath: string; businessesPath: string }

const G = globalThis as typeof globalThis & { __ctrlosPlatform?: Map<string, Database.Database>; __ctrlosBootstrapped?: Set<string> };
const opened = (G.__ctrlosPlatform ??= new Map());
const bootstrapped = (G.__ctrlosBootstrapped ??= new Set());

export const platformDbPath = (env: NodeJS.ProcessEnv = process.env) => path.join(dataDir(env), 'platform.db');
/** the agency's businesses.json, where it is today. */
export const legacyBusinessesFile = () => path.join(CTX_ROOT, 'config', 'businesses.json');

/** The files of one agency. the agency (legacy) keeps today's paths (no data move); every other agency lives in tenants/<agc_id>/. */
export function agencyPaths(a: Pick<Agency, 'id' | 'legacy'>): AgencyPaths {
  if (a.legacy) { const businessesPath = legacyBusinessesFile(); return { dir: path.dirname(businessesPath), dbPath: legacyDbPath(), businessesPath }; }
  if (!/^agc_[0-9A-Za-z]{20}$/.test(a.id)) throw new Error('Bad agency id.');
  const dir = path.join(dataDir(), 'tenants', a.id);
  return { dir, dbPath: path.join(dir, 'app.db'), businessesPath: path.join(dir, 'businesses.json') };
}

function schema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agencies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', plan TEXT NOT NULL DEFAULT 'free', legacy INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE COLLATE NOCASE, username TEXT UNIQUE COLLATE NOCASE, name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, origin TEXT,
      totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_recovery TEXT -- reserved for P3 two-step login
    );
    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, agency_id TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'user', ai TEXT NOT NULL DEFAULT '[]', businesses TEXT NOT NULL DEFAULT '{}', full INTEGER NOT NULL DEFAULT 0,
      local_user_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, agency_id), UNIQUE (agency_id, local_user_id)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, who TEXT, agency_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS rate_limits (ip TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, reset_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_memberships_agency ON memberships(agency_id);
  `);
}

/** The platform database, opened once per data dir. The first open runs the the agency bootstrap (idempotent). */
export function platformDb(): Database.Database {
  const file = platformDbPath();
  let db = opened.get(file);
  if (!db) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file, { timeout: 10000 });
    db.pragma('busy_timeout = 10000');
    try { db.pragma('journal_mode = WAL'); } catch { /* another worker switched it */ }
    db.pragma('foreign_keys = ON');
    schema(db);
    opened.set(file, db);
  }
  if (!bootstrapped.has(file)) {
    bootstrapped.add(file);
    try { bootstrapLegacy(db); } catch (e) { bootstrapped.delete(file); throw e; }
  }
  return db;
}

/** Tests: forget open handles so a fresh temp dir starts clean. */
export function closePlatformForTests() {
  for (const d of opened.values()) { try { d.close(); } catch { /* closed */ } }
  opened.clear(); bootstrapped.clear();
}

export function audit(action: string, who: string | null, agencyId: string | null, detail = '', db = platformDb()) {
  db.prepare('INSERT INTO audit (at, who, agency_id, action, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), who, agencyId, action, detail.slice(0, 500));
}
export function auditLog(limit = 100) {
  return platformDb().prepare('SELECT at, who, agency_id AS agencyId, action, detail FROM audit ORDER BY id DESC LIMIT ?').all(limit) as { at: number; who: string | null; agencyId: string | null; action: string; detail: string }[];
}

type AgencyRow = { id: string; name: string; slug: string; status: string; plan: string; created_at: number; legacy: number };
const agencyOf = (r: AgencyRow): Agency => ({ id: r.id, name: r.name, slug: r.slug, status: r.status, plan: r.plan, createdAt: r.created_at, legacy: r.legacy === 1 });
/** One prepared statement per database and SQL (2026-10-13 audit: preparing it on every call was seconds of a year-long Leads page). */
const stmts = new WeakMap<Database.Database, Map<string, Database.Statement>>();
function stmt(sql: string): Database.Statement {
  const db = platformDb();
  let m = stmts.get(db);
  if (!m) stmts.set(db, m = new Map());
  let s = m.get(sql);
  if (!s) m.set(sql, s = db.prepare(sql));
  return s;
}
export function getAgency(id: string): Agency | null {
  const r = stmt('SELECT * FROM agencies WHERE id = ?').get(id) as AgencyRow | undefined;
  return r ? agencyOf(r) : null;
}
export const listAgencies = (): Agency[] => (platformDb().prepare('SELECT * FROM agencies ORDER BY created_at').all() as AgencyRow[]).map(agencyOf);

type UserRow = { id: string; email: string | null; username: string | null; name: string; password_hash: string; created_at: number };
const userOf = (r: UserRow): PlatformUser => ({ id: r.id, email: r.email, username: r.username, name: r.name, passwordHash: r.password_hash, createdAt: r.created_at });
export function getPlatformUser(id: string): PlatformUser | null {
  const r = platformDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return r ? userOf(r) : null;
}
/** The login for a typed email or username: exact first, then ignoring case (the same forgiveness as lib/login-user.ts). */
export function findPlatformUser(typed: string): PlatformUser | null {
  const t = plainTyped(typed);
  if (!t) return null;
  const db = platformDb();
  const r = (db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').all(t, t) as UserRow[]);
  return r.length === 1 ? userOf(r[0]) : null;
}

type MemberRow = { user_id: string; agency_id: string; role: string; ai: string; businesses: string; full: number; local_user_id: number; created_at: number };
const json = <T>(s: string, d: T): T => { try { const v = JSON.parse(s) as T; return v ?? d; } catch { return d; } };
const roleOf = (r: string): MemberRole => (r === 'owner' || r === 'admin' || r === 'manager' || r === 'client' ? r : 'user');
const memberOf = (r: MemberRow): Membership => ({ userId: r.user_id, agencyId: r.agency_id, role: roleOf(r.role), ai: json<string[]>(r.ai, []), businesses: json<Record<string, string[]>>(r.businesses, {}),
  full: r.full === 1, localUserId: r.local_user_id, createdAt: r.created_at });

export function getMembership(userId: string, agencyId: string): Membership | null {
  const r = platformDb().prepare('SELECT * FROM memberships WHERE user_id = ? AND agency_id = ?').get(userId, agencyId) as MemberRow | undefined;
  return r ? memberOf(r) : null;
}
export function membershipByLocal(agencyId: string, localUserId: number): Membership | null {
  const r = platformDb().prepare('SELECT * FROM memberships WHERE agency_id = ? AND local_user_id = ?').get(agencyId, localUserId) as MemberRow | undefined;
  return r ? memberOf(r) : null;
}
/** The agencies a login belongs to (active ones), oldest membership first: the first is the default. */
export function agenciesOfUser(userId: string): (Agency & { role: MemberRole })[] {
  const rows = platformDb().prepare(`SELECT a.*, m.role AS mrole FROM memberships m JOIN agencies a ON a.id = m.agency_id
    WHERE m.user_id = ? AND a.status = 'active' ORDER BY m.created_at, a.created_at`).all(userId) as (AgencyRow & { mrole: string })[];
  return rows.map((r) => ({ ...agencyOf(r), role: roleOf(r.mrole) }));
}

export function setMembershipGrant(agencyId: string, localUserId: number, g: { role: MemberRole; ai: string[]; businesses: Record<string, string[]>; full?: boolean }) {
  platformDb().prepare('UPDATE memberships SET role = ?, ai = ?, businesses = ?, full = ? WHERE agency_id = ? AND local_user_id = ?')
    .run(g.role, JSON.stringify(g.ai), JSON.stringify(g.businesses), g.full ? 1 : 0, agencyId, localUserId);
}

export const newUserId = () => `usr_${randomBase62(20)}`;
export const newAgencyId = () => `agc_${randomBase62(20)}`;

export function slugFor(name: string, db = platformDb()): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'agency';
  let slug = base;
  for (let i = 2; db.prepare('SELECT 1 FROM agencies WHERE slug = ?').get(slug); i++) slug = `${base}-${i}`;
  return slug;
}

// ─── the agency bootstrap (D, 2026-10-09): the install's own agency becomes the first tenant on its current files, and today's logins and
// grants are copied into platform users + memberships. Runs on every multi-agency boot and only adds or refreshes: the old tables are
// read, never changed (rollback = unset CTRLOS_MULTI_TENANT). Users made in single mode later are picked up on the next boot. ───

interface LegacyAgency { id: string; name: string }
export function legacyAgencyFromFile(file = legacyBusinessesFile()): LegacyAgency | null {
  let raw: { businesses?: unknown };
  try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { businesses?: unknown }; } catch { return null; }
  const list = Array.isArray(raw?.businesses) ? (raw.businesses as Record<string, unknown>[]) : [];
  const a = list.find((b) => b && b.module === 'agency' && typeof b.key === 'string');
  if (!a) return null;
  const id = typeof a.id === 'string' && BUSINESS_ID.test(a.id) && a.id.startsWith('agc_') ? a.id : derivedBusinessId(String(a.key), 'agency');
  return { id, name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : String(a.key) };
}

function bootstrapLegacy(db: Database.Database) {
  const agency = legacyAgencyFromFile();
  if (!agency) return; // no agency business yet: nothing to make a tenant of
  const now = Date.now();
  if (!db.prepare('SELECT 1 FROM agencies WHERE id = ?').get(agency.id)) {
    db.prepare("INSERT INTO agencies (id, name, slug, created_at, status, plan, legacy) VALUES (?, ?, ?, ?, 'active', 'legacy', 1)")
      .run(agency.id, agency.name, slugFor(agency.name, db), now);
    audit('agency.bootstrap', 'system', agency.id, 'the install agency on its current files', db);
  }
  const file = legacyDbPath();
  if (!fs.existsSync(file)) return;
  const old = new Database(file, { readonly: true, fileMustExist: true, timeout: 10000 });
  try {
    const has = (t: string) => !!old.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has('users')) return;
    const users = old.prepare('SELECT id, username, password_hash FROM users ORDER BY id').all() as { id: number; username: string; password_hash: string }[];
    const grants = new Map((has('user_access') ? old.prepare('SELECT user_id, full, role, ai, businesses FROM user_access').all() as { user_id: number; full: number; role: string | null; ai: string; businesses: string }[] : []).map((g) => [g.user_id, g]));
    let supportId: number | null = null;
    if (has('support_access')) supportId = (old.prepare('SELECT user_id FROM support_access WHERE id = 1').get() as { user_id: number | null } | undefined)?.user_id ?? null;
    const ownerId = users[0]?.id ?? null;
    const sync = db.transaction(() => {
      const seen = new Set<number>();
      for (const u of users) {
        if (u.id === supportId) continue; // the support login is per agency and never signs in with a password
        seen.add(u.id);
        const g = grants.get(u.id);
        // the first login is the owner (lib/user-access.ts ownerId); a missing access row = legacy full admin, as getGrant reads it
        const role: MemberRole = u.id === ownerId ? 'owner' : g ? roleOf(g.role ?? 'user') : 'admin';
        const full = u.id !== ownerId && (!g || g.full === 1);
        const ai = g ? g.ai : '[]', businesses = g ? g.businesses : '{}';
        const m = db.prepare('SELECT user_id FROM memberships WHERE agency_id = ? AND local_user_id = ?').get(agency.id, u.id) as { user_id: string } | undefined;
        if (m) {
          db.prepare('UPDATE memberships SET role = ?, ai = ?, businesses = ?, full = ? WHERE agency_id = ? AND local_user_id = ?').run(role, ai, businesses, full ? 1 : 0, agency.id, u.id);
          db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(u.password_hash, m.user_id);
          continue;
        }
        if (db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(u.username, u.username)) {
          audit('bootstrap.skip', 'system', agency.id, `login "${u.username}" (local ${u.id}): the name is taken on the platform`, db);
          continue;
        }
        const id = newUserId();
        db.prepare('INSERT INTO users (id, email, username, name, password_hash, created_at, origin) VALUES (?, NULL, ?, ?, ?, ?, ?)')
          .run(id, u.username, u.username, u.password_hash, now, `legacy:${agency.id}:${u.id}`);
        db.prepare('INSERT INTO memberships (user_id, agency_id, role, ai, businesses, full, local_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, agency.id, role, ai, businesses, full ? 1 : 0, u.id, now);
        audit('bootstrap.user', 'system', agency.id, `login "${u.username}" (local ${u.id}) as ${role}`, db);
      }
      // a login removed in single mode loses its membership here (its platform user goes when it has no agency left)
      for (const r of db.prepare('SELECT user_id, local_user_id FROM memberships WHERE agency_id = ?').all(agency.id) as { user_id: string; local_user_id: number }[]) {
        if (seen.has(r.local_user_id)) continue;
        db.prepare('DELETE FROM memberships WHERE agency_id = ? AND local_user_id = ?').run(agency.id, r.local_user_id);
        if (!db.prepare('SELECT 1 FROM memberships WHERE user_id = ?').get(r.user_id)) db.prepare('DELETE FROM users WHERE id = ?').run(r.user_id);
        audit('bootstrap.remove', 'system', agency.id, `local ${r.local_user_id} is gone from the install`, db);
      }
    });
    sync();
  } finally { old.close(); }
}
