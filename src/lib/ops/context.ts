// Operations (P5, D 2026-10-09): where ops state lives. Kept in one tiny file so P2 (multi-tenant core) can rewire it in one place.
import type Database from 'better-sqlite3';
import { db } from '@/lib/db';
import { isMultiTenant } from '@/lib/platform/mode';
import { tenantContextSync } from '@/lib/platform/context';
import { platformDb } from '@/lib/platform/db';

/** The request's (or job's) agency id, 'default' in single-agency mode or when there is none. Ops code only uses it to tag alerts and
 *  rate-limit keys (P2, D 2026-10-09). */
export function currentTenantId(): string {
  if (!isMultiTenant()) return 'default';
  try { return tenantContextSync()?.agencyId ?? 'default'; } catch { return 'default'; }
}

/**
 * The SQLite that holds install-wide ops tables (ops_alerts, ops_rate_limits, ops_leases): the app database in single-agency mode, and
 * platform.db in multi-agency mode, so the health route, alerts and the background check work with no agency (P2, D 2026-10-09).
 */
export function opsDb(): Database.Database {
  return isMultiTenant() ? platformDb() : db;
}
