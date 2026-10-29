// AI Agents - SQLite database singleton
// Read cache for JSON/JSONL files on disk. WAL mode for concurrent reads.

import type Database from 'better-sqlite3';
import { createDatabase, legacyDbPath } from './db-schema';
import { MULTI_TENANT_AT_BOOT, tenantDatabase } from './platform/tenant-db';

const DB_PATH = legacyDbPath();

// globalThis singleton survives Next.js hot reload
const globalForDb = globalThis as unknown as {
  __ctrlos_db: Database.Database | undefined;
};

// Multi-agency mode (CTRLOS_MULTI_TENANT=1, D 2026-10-09): `db` is a stand-in that hands every call to the current agency's own
// database (lib/platform/tenant-db.ts). Unset = the one install database exactly as before.
function singleDb(): Database.Database {
  const d = globalForDb.__ctrlos_db ?? createDatabase(DB_PATH);
  if (process.env.NODE_ENV !== 'production') globalForDb.__ctrlos_db = d;
  return d;
}

function tenantProxy(): Database.Database {
  return new Proxy({} as Database.Database, {
    get(_t, prop) {
      const d = tenantDatabase();
      const v = Reflect.get(d, prop, d) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
    },
    set(_t, prop, value) { return Reflect.set(tenantDatabase(), prop, value); },
    has(_t, prop) { return Reflect.has(tenantDatabase(), prop); },
  });
}

export const db: Database.Database = MULTI_TENANT_AT_BOOT ? tenantProxy() : singleDb();

/** Re-export for explicit initialization (idempotent - db is created on import) */
export function initializeDb(): Database.Database {
  return db;
}

/** Check if the database connection is healthy */
export function isDatabaseReady(): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

/** Get row counts for all tables (useful for diagnostics) */
export function getTableCounts(): Record<string, number> {
  const tables = [
    'tasks',
    'approvals',
    'events',
    'heartbeats',
    'cost_entries',
    'users',
    'messages',
    'sync_meta',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as {
      count: number;
    };
    counts[table] = row.count;
  }
  return counts;
}

export default db;
