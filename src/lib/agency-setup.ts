import crypto from 'crypto';
import { db } from './db';
import { schemaOnce } from './schema-once';

// First-run agency setup (D, 2026-10-07: "a set up when someone downloads this to set up the agency view"). One flag per install:
// 'pending' opens the setup page for everyone until the owner presses Go live; 'complete' never shows it again (Settings › Agency edits
// the same things later). Installs that already had logins before this code shipped are 'complete' from the first read (the migration
// below), so a running install like the agency never sees the setup. Not a server action: callers check who asks.

// made on first use, per agency database (it ran at import before; multi-agency mode has no agency at import, D 2026-10-09)
const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS install_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', at TEXT NOT NULL)`);
  ready.mark();
}

export type SetupState = 'pending' | 'complete';
const now = () => new Date().toISOString().slice(0, 19) + 'Z';

export const usersCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

export function getInstallValue(key: string): string | null {
  ensure();
  return (db.prepare('SELECT value FROM install_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}
export function setInstallValue(key: string, value: string, note = ''): void {
  ensure();
  db.prepare(`INSERT INTO install_state (key, value, note, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, note = excluded.note, at = excluded.at`).run(key, value, note, now());
}

/** The setup flag. First read on an install: an install with logins already is an existing one (complete, migrated); an empty one
 *  (no login yet) starts pending. The row is written once, so later logins never flip it. */
export function setupState(): SetupState {
  const v = getInstallValue('agency_setup');
  if (v === 'complete' || v === 'pending') return v;
  const existing = usersCount() > 0;
  db.prepare(`INSERT OR IGNORE INTO install_state (key, value, note, at) VALUES ('agency_setup', ?, ?, ?)`)
    .run(existing ? 'complete' : 'pending', existing ? 'migrated: install had logins before the agency setup existed' : 'new install', now());
  return getInstallValue('agency_setup') === 'complete' ? 'complete' : 'pending';
}
export const setupPending = () => setupState() === 'pending';

/** The one-time token the install script prints (FLEET_SETUP_TOKEN): whoever opens the empty install first must have it to make the
 *  owner. No token in the environment = a dev install, nothing to check. */
export function setupTokenOk(given: string | undefined | null): boolean {
  const want = (process.env.FLEET_SETUP_TOKEN ?? '').trim();
  if (!want) return true;
  const a = Buffer.from(String(given ?? '').trim()), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const setupTokenRequired = () => !!(process.env.FLEET_SETUP_TOKEN ?? '').trim();
