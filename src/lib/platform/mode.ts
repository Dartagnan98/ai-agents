import path from 'path';
import { legacyDbPath } from '../db-schema';

// Multi-agency switch and data dir (D, 2026-10-09, docs/MULTI_TENANT.md). Unset CTRLOS_MULTI_TENANT = one agency, today's files.

export const isMultiTenant = (env: NodeJS.ProcessEnv = process.env): boolean => env.CTRLOS_MULTI_TENANT === '1';

/** Where platform.db and tenants/ live: CTRLOS_DATA_DIR, else the folder that holds today's app SQLite. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = (env.CTRLOS_DATA_DIR ?? '').trim();
  return d ? path.resolve(d) : path.dirname(legacyDbPath(env));
}

/** Thrown when multi-agency code needs the current agency and none can be told (no session cookie, no runWithTenant). Fails closed:
 *  nothing ever falls back to another agency's data. */
export class NoTenantError extends Error {
  constructor(msg = 'No agency for this request (sign in again).') { super(msg); this.name = 'NoTenantError'; }
}
