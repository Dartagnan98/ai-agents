import type { Instrumentation } from 'next';

export async function register() {
  // the Node.js check wraps the import itself, so the Edge build never sees Node-only code
  // FLEET_NO_JOBS=1 runs no routines, tasks or memory passes: only the pages
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.FLEET_NO_JOBS !== '1') {
    // The agents' clock (lib/ai/routine-clock.ts, every 30 s): routines, the task board, agent messages, triggers, tests and the memory passes
    const { startRoutineClock } = await import('./lib/ai/routine-clock');
    setTimeout(() => startRoutineClock(), 10_000);
  }
}

// Server errors (P5, D 2026-10-09): every error Next catches in a route, page or action goes to alert('server-error'), de-duplicated
// per route and message for 30 minutes (lib/ops/alerts.ts). Node runtime only; never throws.
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  try {
    const e = error as { message?: string; digest?: string } | null;
    if (typeof e?.digest === 'string' && e.digest.startsWith('NEXT_')) return; // redirects and not-found are not errors
    const { alert } = await import('./lib/ops/alerts');
    await alert('server-error', `${request.method} ${context.routePath}: ${String(e?.message ?? error).split('\n')[0]}`, {
      path: request.path.split('?')[0], routeType: context.routeType, digest: e?.digest,
    });
  } catch { /* alerting must never break a request */ }
};
