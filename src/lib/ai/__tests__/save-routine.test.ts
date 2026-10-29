import { describe, expect, it, vi } from 'vitest';

// the AI makes and changes routines itself (D, 2026-10-23): save_routine runs through actNow (kept as an approved change), checked
// like the editor (schedule, agent), new ones on by default, a change keeps what it does not name, and only the owner or maker edits.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users (id, username) VALUES (1, 'owner'), (2, 'admin');`);
  return { db };
});
vi.mock('@/lib/user-access', () => ({ getGrant: (uid: number) => ({ role: uid === 1 ? 'owner' : 'admin' }) }));

const { actNow, actOrAsk } = await import('../approvals');
const { db } = await import('@/lib/db');
const R = await import('../routines');

describe('save_routine', () => {
  it('makes a team routine for the owner, on, posting to Slack', async () => {
    const out = await actNow(1, 1, 'save_routine', { name: '72h snapshot', prompt: '/72h-snapshot', schedule: '0 7 * * *', deliver: { slack: 'C0C3B55L01K' } }, 'x');
    const id = Number(/#(\d+)/.exec(out)![1]), r = R.getRoutine(id)!;
    expect(out).toMatch(/^Made routine #\d+ "72h snapshot": .*posts to #C0C3B55L01K/);
    expect(r).toMatchObject({ enabled: true, shared: true, schedule: '0 7 * * *', created_by: 1 });
    expect(r.next_run_at).toBeGreaterThan(Date.now());
    // a change keeps the prompt and delivery it does not name
    await actNow(1, 1, 'save_routine', { id, schedule: '0 8 * * 1-5' }, 'x');
    expect(R.getRoutine(id)).toMatchObject({ prompt: '/72h-snapshot', schedule: '0 8 * * 1-5', deliver: { slack: 'C0C3B55L01K' }, enabled: true });
    // an admin may not change a team routine someone else made
    await expect(actNow(2, 1, 'save_routine', { id, enabled: false }, 'x')).rejects.toThrow(/only the owner or its maker/);
  });
  it('refuses a bad schedule', async () => {
    await expect(actNow(1, 1, 'save_routine', { name: 'x', prompt: 'y', schedule: 'every morning' }, 'x')).rejects.toThrow();
  });
  it('a turn that read text other people wrote still acts at once, no card (D, 2026-10-26)', async () => {
    const before = R.listRoutines(1).length;
    expect(await actOrAsk(true, 1, 1, 'save_routine', { name: 'from slack', prompt: 'mirror the board', schedule: '0 8 * * *' }, 'x')).toMatch(/^Made routine/);
    expect(R.listRoutines(1).length).toBe(before + 1);
  });
});
