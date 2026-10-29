// Security (H8): SQLite-backed rate limiter — survives server restarts.
// Fails closed if db is unavailable (denying is safer than allowing unlimited attempts).
import { db as appDb } from '@/lib/db';
import { isMultiTenant } from '@/lib/platform/mode';
import { platformDb } from '@/lib/platform/db';

// multi-agency mode (D, 2026-10-09): sign-in happens before any agency is known, so the limit lives in platform.db
const store = () => (isMultiTenant() ? platformDb() : appDb);

const MAX = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/** `max` attempts per 15 minutes for one key (an address, or `login:<id>` for one person). */
export function checkRateLimit(ip: string, max = MAX): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();

  try {
    const db = store();
    // Prune expired entries opportunistically
    db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(now);

    const row = db.prepare('SELECT count, reset_at FROM rate_limits WHERE ip = ?').get(ip) as
      | { count: number; reset_at: number }
      | undefined;

    if (!row) {
      db.prepare('INSERT INTO rate_limits (ip, count, reset_at) VALUES (?, 1, ?)').run(
        ip,
        now + WINDOW_MS,
      );
      return { allowed: true };
    }

    if (row.count >= max) {
      return { allowed: false, retryAfter: Math.ceil((row.reset_at - now) / 1000) };
    }

    db.prepare('UPDATE rate_limits SET count = count + 1 WHERE ip = ?').run(ip);
    return { allowed: true };
  } catch (err) {
    // Security (H8): Fail closed if DB is unavailable — denying is safer than allowing unlimited attempts.
    console.error('[rate-limit] DB error, failing closed (denying request):', err);
    return { allowed: false, retryAfter: 60 };
  }
}

export function resetRateLimit(ip: string): void {
  try {
    const db = store();
    db.prepare('DELETE FROM rate_limits WHERE ip = ?').run(ip);
  } catch (err) {
    console.error('[rate-limit] DB error on reset:', err);
  }
}
