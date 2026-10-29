import type Database from 'better-sqlite3';
import { createDatabase } from '../db-schema';
import { isMultiTenant, NoTenantError } from './mode';
import { tenantContextSync } from './context';
import { agencyPaths, getAgency, type Agency } from './db';

// Each agency's own SQLite (D, 2026-10-09, decision 3): data/tenants/<agc_id>/app.db, the agency on today's file. Opened once per process
// and kept (globalThis, so Next's separate module copies share the handles).

/** Read once when lib/db.ts loads: the env never changes while the app runs. */
export const MULTI_TENANT_AT_BOOT = isMultiTenant();

const G = globalThis as typeof globalThis & { __ctrlosTenantDbs?: Map<string, Database.Database> };
const handles = (G.__ctrlosTenantDbs ??= new Map());

export function openTenantDatabase(a: Pick<Agency, 'id' | 'legacy'>): Database.Database {
  const file = agencyPaths(a).dbPath;
  let d = handles.get(file);
  if (!d || !d.open) { d = createDatabase(file); handles.set(file, d); }
  return d;
}

/** Closes and forgets one agency's handle (a failed createAgency removes its dir). */
export function forgetTenantDatabase(a: Pick<Agency, 'id' | 'legacy'>) {
  const file = agencyPaths(a).dbPath, d = handles.get(file);
  if (d) { try { d.close(); } catch { /* closed */ } handles.delete(file); }
}

/** The agency this request or job runs for; throws NoTenantError when there is none or it is not active. */
export function currentAgencySync(): Agency {
  const c = tenantContextSync();
  if (!c) throw new NoTenantError();
  const a = getAgency(c.agencyId);
  if (!a || a.status !== 'active') throw new NoTenantError('This agency is not active.');
  return a;
}

export const tenantDatabase = (): Database.Database => openTenantDatabase(currentAgencySync());

/** Tests: close every agency database so temp dirs can go. */
export function closeTenantDatabasesForTests() {
  for (const d of handles.values()) { try { d.close(); } catch { /* closed */ } }
  handles.clear();
}
