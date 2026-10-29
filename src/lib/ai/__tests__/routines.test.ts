import { describe, expect, it, vi } from 'vitest';

// Routines (D, 2026-10-09): the lease that lets one app copy fire, the per-run claim (no double start, max 2 at once), the seeded
// routines (off), and "only run if" SKIP answers. Against an in-memory SQLite.
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users (id, username) VALUES (1, 'owner');`);
  return { db };
});

const R = await import('../routines');
const input = (name: string, enabled = true) => ({ name, agent_id: null, prompt: 'Do it', schedule: '0 6 * * *', enabled, deliver: { conversation: true as const }, condition: '' });

describe('lease', () => {
  it('one holder at a time; it renews its own; another takes over once it expires', () => {
    const t = 1_000_000;
    expect(R.acquireLease('routines', 'copy-a', 90_000, t)).toBe(true);
    expect(R.acquireLease('routines', 'copy-b', 90_000, t + 1000)).toBe(false);
    expect(R.acquireLease('routines', 'copy-a', 90_000, t + 30_000)).toBe(true); // renew to t+120s
    expect(R.acquireLease('routines', 'copy-b', 90_000, t + 100_000)).toBe(false);
    expect(R.acquireLease('routines', 'copy-b', 90_000, t + 121_000)).toBe(true);
    expect(R.acquireLease('routines', 'copy-a', 90_000, t + 122_000)).toBe(false);
    R.releaseLease('routines', 'copy-b');
    expect(R.acquireLease('routines', 'copy-a', 90_000, t + 123_000)).toBe(true);
  });
});

describe('seeded routines', () => {
  it('two starter routines, on, owned by the first user', () => {
    const seeded = R.listRoutines();
    expect(seeded.map((r) => r.name).sort()).toEqual(['Morning brief', 'Weekly review']);
    expect(seeded.every((r) => r.enabled && r.next_run_at !== null && r.created_by === 1)).toBe(true);
    expect(seeded.find((r) => r.name === 'Weekly review')!.schedule).toBe('0 9 * * 1');
    R.ensureRoutines(); // seeding twice adds nothing
    expect(R.listRoutines()).toHaveLength(2);
  });
});

describe('claiming runs', () => {
  it('due routines only when on and their time has come; a claim moves the next run on', () => {
    const r = R.createRoutine(input('Daily'), 1);
    expect(r.next_run_at).toBeGreaterThan(Date.now());
    const later = r.next_run_at! + 1000;
    expect(R.dueRoutines(later).map((x) => x.id)).toContain(r.id);
    expect(R.dueRoutines(Date.now()).map((x) => x.id)).not.toContain(r.id);
    const c = R.claimRun(r.id, 'schedule', later);
    expect('runId' in c).toBe(true);
    const after = R.getRoutine(r.id)!;
    expect(after.next_run_at).toBeGreaterThan(later);
    expect(after.last_status).toBe('running');
    expect(R.dueRoutines(later + 1000).map((x) => x.id)).not.toContain(r.id); // moved on and running: not due
    // a second claim while running is refused (another tick, or Run now)
    expect(R.claimRun(r.id, 'manual', later + 5000)).toEqual({ refused: 'It is still running from last time.' });
    R.finishRun(r.id, (c as { runId: number }).runId, { status: 'ok', summary: 'Done.', threadId: 42 }, later + 60_000);
    const done = R.getRoutine(r.id)!;
    expect(done.running_since).toBeNull();
    expect(done.last_status).toBe('ok');
    expect(done.last_thread_id).toBe(42);
    expect(R.listRuns(r.id)[0]).toMatchObject({ status: 'ok', summary: 'Done.', thread_id: 42, how: 'schedule' });
  });
  it('at most two runs at once across all routines; a run stuck for 30 minutes counts as dead', () => {
    const now = Date.now();
    const [a, b, c] = ['A', 'B', 'C'].map((n) => R.createRoutine(input(n, false), 1));
    expect('runId' in R.claimRun(a.id, 'manual', now)).toBe(true);
    expect(R.claimRun(b.id, 'manual', now)).toHaveProperty('runId');
    expect(R.claimRun(c.id, 'manual', now)).toEqual({ refused: '2 routines are already running. Try again in a moment.' });
    const stale = now + R.STALE_RUN_MS + 1000;
    expect('runId' in R.claimRun(c.id, 'manual', stale)).toBe(true);
    expect('runId' in R.claimRun(a.id, 'manual', stale)).toBe(true); // a's old run is closed off
    expect(R.listRuns(a.id).map((x) => x.status)).toEqual(['running', 'error']);
    expect(R.getRoutine(a.id)!.next_run_at).toBeNull(); // off: Run now does not schedule it
  });
  it('switching a routine on sets its next run; off clears it', () => {
    const r = R.createRoutine(input('Toggle', false), 1);
    expect(R.setRoutineEnabled(r.id, true)!.next_run_at).toBeGreaterThan(Date.now());
    expect(R.setRoutineEnabled(r.id, false)!.next_run_at).toBeNull();
  });
  it('a post in a channel brings forward the routines whose check names it, and only those', () => {
    const now = Date.now();
    const watch = R.createRoutine({ ...input('Watch'), condition: 'a new deal post in C09NCFGT32M' }, 1);
    const other = R.createRoutine({ ...input('Other'), condition: 'a post in C0OTHER123' }, 1);
    expect(R.runSoonForChannel('C09NCFGT32M', 20_000, now)).toBe(1);
    expect(R.getRoutine(watch.id)!.next_run_at).toBe(now + 20_000);
    expect(R.getRoutine(other.id)!.next_run_at).toBeGreaterThan(now + 60_000);
    expect(R.runSoonForChannel("x' OR 1=1", 20_000, now)).toBe(0);
  });
  it('no schedule = reactive: never on a timer, only after a post in the channel its check names', () => {
    expect(R.routineInput({ name: 'Sort', prompt: 'Sort it', schedule: '', condition: 'a post' }, 1, 'owner')).toMatch(/channel id/);
    const a = R.routineInput({ name: 'Sort', prompt: 'Sort it', schedule: '', condition: 'a new post in C0SORTME1', enabled: true }, 1, 'owner');
    if (typeof a === 'string') throw new Error(a);
    const r = R.createRoutine(a, 1);
    expect(r.next_run_at).toBeNull();
    const now = Date.now() + 2 * R.STALE_RUN_MS + 60_000; // past the runs other tests left going
    R.runSoonForChannel('C0SORTME1', 20_000, now);
    expect(R.dueRoutines(now + 21_000).map((x) => x.id)).toContain(r.id);
    expect(R.claimRun(r.id, 'schedule', now + 21_000)).toEqual({ runId: expect.any(Number) });
    expect(R.getRoutine(r.id)!.next_run_at).toBeNull(); // back to waiting for the next post
  });
});

describe('"only run if"', () => {
  it('puts the check before the work, and only when there is one', () => {
    expect(R.routinePrompt('Report.', '')).toBe('Report.');
    const p = R.routinePrompt('Report.', 'there were refunds yesterday');
    expect(p.startsWith('Only run if: there were refunds yesterday')).toBe(true);
    expect(p).toContain('SKIP: ');
    expect(p.endsWith('Report.')).toBe(true);
  });
  it('reads SKIP answers and their reason; anything else is a real report', () => {
    expect(R.skipReason('SKIP: no refunds yesterday')).toBe('no refunds yesterday');
    expect(R.skipReason('  skip - nothing to check\nmore')).toBe('nothing to check');
    expect(R.skipReason('**SKIP** no payments')).toBe('no payments');
    expect(R.skipReason('SKIP')).toBe('Condition not met.');
    expect(R.skipReason('Skipped calls went up 4%.')).toBeNull();
    expect(R.skipReason('Cash collected yesterday: 12,400. SKIP nothing.')).toBeNull();
  });
});

describe('send results to', () => {
  it('always a conversation; Telegram and Slack only when named', () => {
    expect(R.parseDeliver('{"telegram":"team/analyst","slack":"#beta-eod"}')).toEqual({ conversation: true, telegram: 'team/analyst', slack: 'beta-eod' });
    expect(R.parseDeliver('nonsense')).toEqual({ conversation: true, telegram: null, slack: null });
  });
});

// Script routines (D, 2026-10-28): a command instead of an agent turn, a condition script first, and an editor save that does not
// send them must not turn a script routine back into an agent one.
describe('script routines', () => {
  it('a script needs no prompt; saves without the fields keep them; the run keeps its output', () => {
    expect(R.routineInput({ name: 'x', schedule: '0 6 * * *' }, 1, 'owner')).toMatch(/give a script/);
    const a = R.routineInput({ name: 'Leo board', schedule: '*/5 * * * *', script: 'python3 skills/leo_calls_daily/scripts/run.py', condition_script: 'test -f state/go' }, 1, 'owner');
    if (typeof a === 'string') throw new Error(a);
    const r = R.createRoutine(a, 1);
    expect([r.script, r.condition_script, r.prompt]).toEqual(['python3 skills/leo_calls_daily/scripts/run.py', 'test -f state/go', '']);
    expect(R.routineInput({ name: 'agent', schedule: '*/5 * * * *', prompt: 'notes' }, 1, 'owner')).toMatch(/every 15 minutes/); // AI routines keep 15
    const edit = R.routineInput({ name: 'Leo board 2', schedule: '*/15 * * * *', prompt: 'notes' }, 1, 'owner');
    if (typeof edit === 'string') throw new Error(edit);
    expect(R.updateRoutine(r.id, edit)!.script).toBe('python3 skills/leo_calls_daily/scripts/run.py');
    const clear = R.routineInput({ name: 'Leo board 2', schedule: '*/15 * * * *', prompt: 'notes', script: '' }, 1, 'owner');
    if (typeof clear === 'string') throw new Error(clear);
    expect(R.updateRoutine(r.id, clear)!.script).toBe('');
    for (const x of R.listRoutines()) R.finishRun(x.id, -1, { status: 'ok', summary: '', threadId: null }); // earlier tests left runs going
    const later = Date.now();
    const c = R.claimRun(r.id, 'manual', later);
    if ('refused' in c) throw new Error(c.refused);
    R.finishRun(r.id, c.runId, { status: 'ok', summary: 'done', threadId: null, output: 'line 1\nline 2' }, later);
    expect(R.listRuns(r.id)[0].output).toBe('line 1\nline 2');
  });
});

describe('folders', () => {
  it('a routine starts with no folder, moves into one (one line, no slashes), keeps it on save, and comes out again', () => {
    const r = R.createRoutine(input('Filed'), 1);
    expect(r.folder).toBe('');
    expect(R.setRoutineFolder(r.id, '  Daily  /reports\n')!.folder).toBe('Daily reports');
    expect(R.updateRoutine(r.id, input('Filed again'))!.folder).toBe('Daily reports'); // the editor not sending a folder keeps it
    expect(R.updateRoutine(r.id, { ...input('Filed again'), folder: 'Slack' })!.folder).toBe('Slack');
    expect(R.setRoutineFolder(r.id, '')!.folder).toBe('');
  });
});
