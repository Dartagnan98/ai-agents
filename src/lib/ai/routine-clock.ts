import crypto from 'crypto';

// The routine timer (D, 2026-10-09), started from instrumentation.ts in every app copy. Every 30 s it asks its own copy to tick
// (POST /api/ai/mcp with the x-fleet-routine-tick key, loopback only), and the route does the rest: the SQLite lease (one copy fires),
// due routines, runs (lib/ai/routine-scheduler.ts). Through the route because the runner and Fleet tools are server-only modules that
// instrumentation cannot import, and so a run's MCP calls land on the copy that minted its run key. The key is minted here per process
// and kept in process.env (shared by every module graph in the process, unlike a module variable); the route only accepts that key.
const TICK_MS = 30_000;
const g = globalThis as unknown as { __fleetRoutineClock?: boolean };
const KEY = 'FLEET_ROUTINE_TICK_KEY';

/** The key the tick request carries (null until the clock starts in this process). */
export const routineTickKey = () => process.env[KEY] || null;

export function startRoutineClock() {
  if (g.__fleetRoutineClock) return;
  g.__fleetRoutineClock = true;
  const key = (process.env[KEY] = crypto.randomBytes(24).toString('hex'));
  const tick = () => {
    const port = process.env.PORT || '3000';
    fetch(`http://127.0.0.1:${port}/api/ai/mcp`, { method: 'POST', headers: { 'x-fleet-routine-tick': key, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20_000) })
      .catch(() => { /* the app is still starting; the next tick tries again */ });
  };
  setInterval(tick, TICK_MS);
}
