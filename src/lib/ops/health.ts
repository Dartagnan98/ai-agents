// Health report (P5, D 2026-10-09) behind GET /api/health. Public, so it carries states and ages only: no hosts, URLs, paths or errors.
import fs from 'fs';
import path from 'path';

export type PgState = 'ok' | 'slow' | 'down' | 'off';
export type HealthReport = {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  uptimeSec: number;
  checkedAt: string;
  checks: {
    sqlite: { state: 'ok' | 'down'; ms: number };
    postgres: { state: PgState; ms: number | null };
    routinesLease: { state: 'held' | 'expired' | 'none' | 'unknown'; lastRenewedSecAgo: number | null };
    disk: { state: 'ok' | 'low' | 'critical' | 'unknown'; freeGb: number | null; freePct: number | null };
    sync: { source: string; lastOkMinAgo: number }[] | null;
  };
};

export type HealthDeps = {
  sqlitePing: () => void;
  pgConfigured: () => boolean;
  pgPing: () => Promise<unknown>;
  leaseUntil: () => number | null | undefined; // undefined = table missing
  diskStat: () => { free: number; total: number } | null;
  syncRows: () => Promise<{ source: string; sec: number }[]>;
};

export const PG_TIMEOUT_MS = 2000;
export const PG_SLOW_MS = 500;
const ROUTINE_LEASE_MS = 90_000; // lib/ai/routine-scheduler.ts LEASE_MS

let versionCache: string | null = null;
export function appVersion(env: NodeJS.ProcessEnv = process.env): string {
  if (versionCache) return versionCache;
  const fromEnv = env.APP_VERSION || env.GIT_SHA || env.SOURCE_VERSION;
  let v = fromEnv ? fromEnv.slice(0, 40) : '';
  if (!v) { try { v = fs.readFileSync(path.join(process.cwd(), '.deploy-id'), 'utf8').trim().slice(0, 40); } catch { v = ''; } }
  return (versionCache = v || 'dev');
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CTRLOS_DATA_DIR || env.CTX_ROOT || process.cwd();
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export async function pgCheck(deps: Pick<HealthDeps, 'pgConfigured' | 'pgPing'>): Promise<{ state: PgState; ms: number | null }> {
  if (!deps.pgConfigured()) return { state: 'off', ms: null };
  const t = Date.now();
  try {
    await withTimeout(deps.pgPing(), PG_TIMEOUT_MS);
    const ms = Date.now() - t;
    return { state: ms > PG_SLOW_MS ? 'slow' : 'ok', ms };
  } catch {
    return { state: 'down', ms: null };
  }
}

export async function collectHealth(deps: HealthDeps, now = Date.now()): Promise<HealthReport> {
  let sqlite: HealthReport['checks']['sqlite'];
  const t = Date.now();
  try { deps.sqlitePing(); sqlite = { state: 'ok', ms: Date.now() - t }; } catch { sqlite = { state: 'down', ms: Date.now() - t }; }

  const postgres = await pgCheck(deps);

  let routinesLease: HealthReport['checks']['routinesLease'] = { state: 'unknown', lastRenewedSecAgo: null };
  if (sqlite.state === 'ok') {
    try {
      const until = deps.leaseUntil();
      if (until === undefined || until === null) routinesLease = { state: 'none', lastRenewedSecAgo: null };
      else routinesLease = { state: until > now ? 'held' : 'expired', lastRenewedSecAgo: Math.max(0, Math.round((now - (until - ROUTINE_LEASE_MS)) / 1000)) };
    } catch { /* stays unknown */ }
  }

  let disk: HealthReport['checks']['disk'] = { state: 'unknown', freeGb: null, freePct: null };
  try {
    const s = deps.diskStat();
    if (s && s.total > 0) {
      const freeGb = Math.round((s.free / 1e9) * 10) / 10;
      const freePct = Math.round((s.free / s.total) * 1000) / 10;
      disk = { state: freePct < 5 || freeGb < 2 ? 'critical' : freePct < 10 || freeGb < 10 ? 'low' : 'ok', freeGb, freePct };
    }
  } catch { /* stays unknown */ }

  let sync: HealthReport['checks']['sync'] = null;
  if (postgres.state === 'ok' || postgres.state === 'slow') {
    try {
      const rows = await withTimeout(deps.syncRows(), PG_TIMEOUT_MS);
      sync = rows.map((r) => ({ source: String(r.source).slice(0, 40), lastOkMinAgo: Math.round(Number(r.sec) / 60) }));
    } catch { sync = null; }
  }

  const down = sqlite.state === 'down' || postgres.state === 'down' || disk.state === 'critical';
  const degraded = postgres.state === 'slow' || disk.state === 'low';
  return {
    status: down ? 'down' : degraded ? 'degraded' : 'ok',
    version: appVersion(),
    uptimeSec: Math.round(process.uptime()),
    checkedAt: new Date(now).toISOString(),
    checks: { sqlite, postgres, routinesLease, disk, sync },
  };
}

// ─── the real dependencies (loaded lazily so tests and the edge runtime never touch sqlite/pg) ───
export async function defaultHealthDeps(): Promise<HealthDeps> {
  const { opsDb } = await import('./context');
  const { db: appDb } = await import('@/lib/db');
  return {
    sqlitePing: () => { opsDb().prepare('SELECT 1').get(); },
    pgConfigured: () => false, // no Postgres in this app
    pgPing: async () => undefined,
    leaseUntil: () => {
      const d = appDb; // the routine lease lives in the agency's own SQLite (lib/ai/routine-scheduler.ts), not the ops file
      const has = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_leases'").get();
      if (!has) return undefined;
      return (d.prepare("SELECT until FROM ai_leases WHERE name = 'routines'").get() as { until: number } | undefined)?.until ?? null;
    },
    diskStat: () => {
      const s = fs.statfsSync(dataDir());
      return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
    },
    syncRows: async () => [],
  };
}
