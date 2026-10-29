import { isMultiTenant } from './mode';
import { audit, getAgency, membershipByLocal, newUserId, platformDb } from './db';
import { currentAgencySync, openTenantDatabase } from './tenant-db';

// Logins in multi-agency mode (D, 2026-10-09). Every agency keeps its own `users` rows (all its tables key on those integer ids), and
// each row is tied to one platform user by a membership. Sign-in checks the platform user; Settings › Users keeps both in step through
// these helpers (each is a no-op in single-agency mode).

/** Platform usernames are global (sign-in takes an email or a username): refuse one another login already has. */
export function assertPlatformUsernameFree(name: string): void {
  if (!isMultiTenant()) return;
  if (platformDb().prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(name.trim(), name.trim()))
    throw new Error('That username is taken. Pick another one.');
}

/** A login just made in this agency's Settings › Users: its platform user and an empty membership (role user, nothing open). */
export function linkLocalUser(localId: number): void {
  if (!isMultiTenant()) return;
  const agency = currentAgencySync();
  if (membershipByLocal(agency.id, localId)) return;
  const local = openTenantDatabase(agency).prepare('SELECT username, password_hash FROM users WHERE id = ?').get(localId) as { username: string; password_hash: string } | undefined;
  if (!local) throw new Error('User not found.');
  const db = platformDb();
  const id = newUserId(), now = Date.now();
  db.transaction(() => {
    db.prepare('INSERT INTO users (id, email, username, name, password_hash, created_at, origin) VALUES (?, NULL, ?, ?, ?, ?, ?)')
      .run(id, local.username, local.username, local.password_hash, now, `agency:${agency.id}:${localId}`);
    db.prepare("INSERT INTO memberships (user_id, agency_id, role, ai, businesses, full, local_user_id, created_at) VALUES (?, ?, 'user', '[]', '{}', 0, ?, ?)")
      .run(id, agency.id, localId, now);
  })();
  audit('user.add', null, agency.id, `login "${local.username}" (local ${localId})`);
}

/** A login removed from this agency: its membership goes, and its platform user when it has no agency left. */
export function unlinkLocalUser(localId: number): void {
  if (!isMultiTenant()) return;
  const agency = currentAgencySync();
  const m = membershipByLocal(agency.id, localId);
  if (!m) return;
  const db = platformDb();
  db.transaction(() => {
    db.prepare('DELETE FROM memberships WHERE agency_id = ? AND local_user_id = ?').run(agency.id, localId);
    if (!db.prepare('SELECT 1 FROM memberships WHERE user_id = ?').get(m.userId)) db.prepare('DELETE FROM users WHERE id = ?').run(m.userId);
  })();
  audit('user.remove', null, agency.id, `local ${localId}`);
}

/** A new password for a platform user: the platform row and the local row in every agency it belongs to (so the the agency bootstrap,
 *  which refreshes from the install's rows, never brings an old one back). */
export function setPlatformPassword(userId: string, hash: string): void {
  const db = platformDb();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  for (const m of db.prepare('SELECT agency_id, local_user_id FROM memberships WHERE user_id = ?').all(userId) as { agency_id: string; local_user_id: number }[]) {
    const a = getAgency(m.agency_id);
    if (a) openTenantDatabase(a).prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, m.local_user_id);
  }
}

/** Settings › Users set a password on a local row: carry it to the platform user (and its other agencies). */
export function localPasswordChanged(localId: number, hash: string): void {
  if (!isMultiTenant()) return;
  const m = membershipByLocal(currentAgencySync().id, localId);
  if (m) setPlatformPassword(m.userId, hash);
}
