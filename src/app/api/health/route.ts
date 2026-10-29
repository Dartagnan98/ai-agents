// GET /api/health (P5, D 2026-10-09): public status for uptime checks. 200 when ok or degraded, 503 when down.
// No secrets: states, ages and the app version only (lib/ops/health.ts).
import { collectHealth, defaultHealthDeps, type HealthReport } from '@/lib/ops/health';
import { isMultiTenant } from '@/lib/platform/mode';
import { listAgencies } from '@/lib/platform/db';
import { runWithTenant } from '@/lib/platform/context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// a short cache so a burst of checks (or someone hammering a public URL) costs one round of probes
let last: { at: number; report: HealthReport } | null = null;
const CACHE_MS = 5000;

export async function GET() {
  if (!last || Date.now() - last.at > CACHE_MS) {
    // multi-agency mode: Postgres, the routine lease and sync are the install agency's (the agency's), as the background jobs run (instrumentation.ts)
    const legacy = isMultiTenant() ? listAgencies().find((a) => a.legacy)?.id : undefined;
    const check = async () => collectHealth(await defaultHealthDeps());
    last = { at: Date.now(), report: legacy ? await runWithTenant(legacy, check) : await check() };
  }
  return Response.json(last.report, {
    status: last.report.status === 'down' ? 503 : 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
