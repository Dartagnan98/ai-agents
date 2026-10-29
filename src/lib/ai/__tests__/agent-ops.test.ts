import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ai_agents (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO ai_agents VALUES (1, 'Fleet AI'), (2, 'Payments');
    CREATE TABLE ai_routines (id INTEGER PRIMARY KEY, name TEXT, schedule TEXT NOT NULL DEFAULT '', condition TEXT NOT NULL DEFAULT '', enabled INTEGER, next_run_at INTEGER);
    CREATE TABLE ai_routine_runs (id INTEGER PRIMARY KEY, routine_id INTEGER, status TEXT, summary TEXT);
    INSERT INTO ai_routines (id, name, schedule, condition, enabled) VALUES (1, 'Unblock', '', 'when:task_blocked', 1)`);
  return { db };
});
vi.mock('../routines', () => ({ ensureRoutines: () => {}, acquireLease: () => true, releaseLease: () => {} }));
vi.mock('../store', () => ({ getAgent: (id: number) => (id === 1 || id === 2 ? { id, name: id === 1 ? 'Fleet AI' : 'Payments' } : undefined), defaultAgent: () => ({ id: 1 }), listAgents: () => [{ id: 1, name: 'Fleet AI' }, { id: 2, name: 'Payments' }] }));
const T = await import('../tasks'), G = await import('../goals'), X = await import('../triggers');
const { db } = await import('@/lib/db');

describe('agent ops ', () => {
  it('tasks: checks input, never jumps to In progress by hand, keeps notes', () => {
    expect(T.createTask({ title: 'x', createdBy: 1 })).toBe('Give the task a title.');
    expect(T.createTask({ title: 'Check refunds', agentId: 9, createdBy: 1 })).toBe('No such agent.');
    const t = T.createTask({ title: 'Check refunds', agentId: 2, priority: 'bogus', createdBy: 1 });
    if (typeof t === 'string') throw new Error(t);
    expect(t.priority).toBe('normal');
    expect(T.updateTask(t.id, { status: 'in_progress' })).toMatch(/Pending/);
    const b = T.updateTask(t.id, { status: 'blocked', note: 'Needs the Whop key' });
    expect(typeof b !== 'string' && b.result).toBe('Needs the Whop key');
  });
  it('goals: measurable fields checked, every change in the history, prompt lists active ones', () => {
    expect(G.setGoal({ agentId: 2, goal: 'x', by: 'D' })).toBe('Say the goal.');
    expect(G.setGoal({ agentId: 2, goal: 'Refunds under 3%', due: 'next week', by: 'D' })).toMatch(/YYYY-MM-DD/);
    const g = G.setGoal({ agentId: 2, goal: 'Refunds under 3%', metric: 'refund rate', target: '3%', due: '2026-11-30', by: 'D' });
    if (typeof g === 'string') throw new Error(g);
    G.setGoal({ id: g.id, progress: '4.1% on 10-28', by: 'Payments' });
    expect(G.goalsPrompt(2, 'Payments')).toContain('now: 4.1% on 10-28');
    G.setGoal({ id: g.id, status: 'done', by: 'Payments' });
    expect(G.goalsPrompt(2, 'Payments')).toBe('');
    expect((db.prepare('SELECT history FROM ai_agent_goals WHERE id = ?').get(g.id) as { history: string }).history).toContain('4.1%');
  });
  it('triggers: a blocked task wakes a when:task_blocked routine once, with what happened', () => {
    expect(X.triggerOf('when:task_blocked')).toBe('task_blocked');
    expect(X.triggerOf('when:nope')).toBe('');
    X.triggersTick(1_000_000); // first look: the cursor starts at what is already blocked, no backlog
    expect(X.takeEvent(1)).toBe('');
    const t = T.createTask({ title: 'Send statements', agentId: 1, createdBy: 1 });
    if (typeof t === 'string') throw new Error(t);
    T.updateTask(t.id, { status: 'blocked', note: 'No Slack' });
    X.triggersTick(2_000_000);
    expect(X.takeEvent(1)).toContain('"Send statements" (Fleet AI) is blocked: No Slack');
    T.updateTask(t.id, { note: 'still' }); // a note on a blocked task does not fire it again
    X.triggersTick(3_000_000);
    expect(X.takeEvent(1)).toBe('');
  });
});
