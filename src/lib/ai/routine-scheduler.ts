import 'server-only';
import crypto from 'crypto';
import { acquireLease, dueRoutines, MAX_PARALLEL } from './routines';
import { runRoutine } from './routine-run';
import { nightlyMemory } from './memory-nightly';
import { isMultiTenant } from '@/lib/platform/mode';
import { runWithTenant } from '@/lib/platform/context';
import { listAgencies } from '@/lib/platform/db';

// The routine clock (D, 2026-10-09): every 30 s each app copy tries the 'routines' lease in SQLite; only the holder looks for due
// routines and fires them (prod runs 3 pm2 copies on one file). The lease lasts 90 s and the holder renews it every tick, so if that
// copy stops, another takes over within 90 s. Each run is also claimed row by row (routines.ts claimRun), so even two holders could
// not start the same run twice, and at most MAX_PARALLEL routine runs go at once. The 30 s timer itself is lib/ai/routine-clock.ts
// (started from instrumentation); it calls routineTick through app/api/ai/mcp on this same copy.
const LEASE_MS = 90_000;
const gh = globalThis as unknown as { __fleetRoutineHolder?: string };
const HOLDER = (gh.__fleetRoutineHolder ??= `${process.pid}-${crypto.randomBytes(4).toString('hex')}`);

let ticking = false;
/** One tick. Multi-agency mode (2026-10-10, Operations per agency): every active agency's routines, each inside its own agency (its own
 *  SQLite: lease, due list, MAX_PARALLEL); the tick carries no cookie, so without this no agency's routines ever fired. */
export async function routineTick(now = Date.now()): Promise<number[]> {
  if (ticking) return [];
  ticking = true;
  try {
    if (!isMultiTenant()) return tickOne(now);
    const fired: number[] = [];
    for (const a of listAgencies().filter((x) => x.status === 'active')) {
      try { fired.push(...runWithTenant(a.id, () => tickOne(now))); }
      catch (e) { console.warn(`[routines] tick for ${a.id} failed: ${String((e as Error)?.message ?? e)}`); }
    }
    return fired;
  } catch (e) {
    console.warn(`[routines] tick failed: ${String((e as Error)?.message ?? e)}`);
    return [];
  } finally { ticking = false; }
}

function tickOne(now: number): number[] {
  if (!acquireLease('routines', HOLDER, LEASE_MS, now)) return [];
  const fired: number[] = [];
  for (const r of dueRoutines(now).slice(0, MAX_PARALLEL)) {
    fired.push(r.id);
    // not awaited: a long run must not stop the clock; claimRun inside refuses a second start (the run keeps this agency's context)
    void runRoutine(r.id, 'schedule').then((o) => { if ('refused' in o) return; console.log(`[routines] ${r.name}: ${o.status}${o.delivered.length ? ` (sent: ${o.delivered.join(', ')})` : ''}`); })
      .catch((e) => console.warn(`[routines] ${r.name} failed: ${String((e as Error)?.message ?? e)}`));
  }
  // the AI task board (lib/ai/tasks.ts) and routine event triggers (lib/ai/triggers.ts) (D, 2026-10-28)
  void import('./tasks').then((m) => m.runDueTasks(HOLDER)).catch((e) => console.warn(`[tasks] ${String((e as Error)?.message ?? e)}`));
  void import('./triggers').then((m) => m.triggersTick(now)).catch((e) => console.warn(`[triggers] ${String((e as Error)?.message ?? e)}`));
  // agent tests (lib/ai/evals.ts: new ones at once, all on Sunday from 02:00) and each agent's spend alert (lib/ai/usage.ts)
  void Promise.all([import('./evals'), import('@/lib/report-tz')]).then(([m, t]) => m.evalsTick(t.reportTz())).catch((e) => console.warn(`[evals] ${String((e as Error)?.message ?? e)}`));
  void import('./usage').then((m) => m.spendAlerts()).catch(() => {});
  void import('./comms').then((m) => m.deliverComms(HOLDER)).catch((e) => console.warn(`[comms] ${String((e as Error)?.message ?? e)}`)); // agents' hand-offs and messages (D, 2026-10-23)
  // team memory ingest (lib/ai/team-memory.ts): every 30 min on this copy, its own lease; not awaited
  void import('./team-memory').then((m) => m.teamMemoryTick(HOLDER, now)).catch((e) => console.warn(`[team-memory] ${String((e as Error)?.message ?? e)}`));
  // WhatsApp numbers' bridges (lib/wa/numbers.ts): kept running, on the copy that holds the clock
  try { void import('@/lib/wa/numbers').then((m) => m.bridgesTick()).catch((e) => console.warn(`[wa] ${String((e as Error)?.message ?? e)}`)); } catch { /* none */ }
  // the nightly memory pass (lib/ai/memory-nightly.ts): checks itself whether yesterday is done; not awaited either
  void nightlyMemory({ holder: HOLDER }).catch((e) => console.warn(`[memory] failed: ${String((e as Error)?.message ?? e)}`));
  return fired;
}
