import { describe, expect, it, vi } from 'vitest';

// Chat runs keep going after a reload (D, 2026-10-23): the reply so far lives on the thread, Stop is a flag the run polls,
// and a run that stopped refreshing (app restarted) counts as over.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  return { db: new Database(':memory:') };
});
const S = await import('../store');

describe('live runs', () => {
  it('saves, reads, stops and clears; a stale one is over', () => {
    const t = S.createThread(1, 'chat', 's', null);
    expect(S.liveOf(t.id)).toBeNull();
    S.requestStop(t.id);
    expect(S.stopRequested(t.id)).toBe(false); // nothing running: nothing to stop
    S.setLive(t.id, { reply: 'Half an answer', steps: [{ name: 'metrics', title: 'Reading', status: 'running' }] });
    expect(S.liveOf(t.id)?.reply).toBe('Half an answer');
    expect(S.liveOf(t.id, Date.now() + 31_000)).toBeNull(); // not refreshed for 30 s
    S.requestStop(t.id);
    expect(S.stopRequested(t.id)).toBe(true);
    S.setLive(t.id, null);
    expect(S.liveOf(t.id)).toBeNull();
    expect(S.stopRequested(t.id)).toBe(false);
  });
  it('a run cut off by a restart hands back what it had, once', () => {
    const t = S.createThread(1, 'chat', 's2', null);
    S.setLive(t.id, { reply: 'Part one', steps: [] });
    expect(S.endStaleLive(t.id)).toBeNull(); // still refreshing
    expect(S.endStaleLive(t.id, Date.now() + 31_000)?.reply).toBe('Part one');
    expect(S.endStaleLive(t.id, Date.now() + 31_000)).toBeNull(); // already saved
    expect(S.liveOf(t.id)).toBeNull();
  });
});
