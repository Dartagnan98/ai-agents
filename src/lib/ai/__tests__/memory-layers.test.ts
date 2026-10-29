import { describe, expect, it, vi } from 'vitest';

// The memory layers (D, 2026-10-23, lib/ai/memory-layers.ts): learning after an answer (add, fix, retire, at most 3, only for owners and
// admins), each change logged and undoable; "Always remember" (append, replace, size cap, undo); summaries of quiet conversations; nightly
// insights (2+ sources and 50%+ sure, saved with their evidence, undoable). An in-memory SQLite and a fake model.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users (id, username) VALUES (1, 'Sam'), (3, 'Rep Ryan');
    CREATE TABLE kb_docs (id INTEGER PRIMARY KEY, space TEXT, folder TEXT, title TEXT, body TEXT, updated_at TEXT);
    CREATE TABLE rep_staff (person_key TEXT PRIMARY KEY, name TEXT, active INTEGER NOT NULL DEFAULT 1);`);
  return { db };
});
vi.mock('@/lib/user-access', () => ({ getGrant: (id: number) => ({ role: id === 1 ? 'owner' : 'user' }) }));
vi.mock('@/lib/slack/app', () => ({ botToken: () => null }));
vi.mock('@/lib/agency-secrets', () => ({ agencySecretValues: () => ({ OPENAI_API_KEY: 'sk-supersecretvalue123' }) }));
vi.mock('@/lib/report-tz', () => ({ reportTz: () => 'America/New_York', tzName: () => 'Eastern' }));
vi.mock('../tools', () => ({ mintRunKey: () => 'k', revokeRunKey: () => {} }));
const answers: string[] = [];
const prompts: string[] = [];
vi.mock('../runners', () => ({ RUNNERS: new Proxy({}, { get: () => async (i: { prompt: string; onText: (t: string) => void }) => { prompts.push(i.prompt); i.onText(answers.shift() ?? '{}'); return {}; } }) }));

const S = await import('../store');
const L = await import('../memory-layers');
const T = await import('../team-memory');
const { db } = await import('@/lib/db');
const agent = S.defaultAgent()!;

describe('learning after an answer', () => {
  it('adds, fixes and retires notes, logs each change, and undo puts them back', async () => {
    const old = S.addAgentNote(agent.id, 1, 'BETA pays closers 10%', null), gone = S.addAgentNote(agent.id, 1, 'DELTA is a client', null);
    const t = S.createThread(1, 'Rates', 's', agent.id);
    answers.push(JSON.stringify({ add: [{ content: 'Triage sets paid in full pay the setter 2%', for: 'agent' }, { content: 'Sam wants totals first', for: 'person' }],
      update: [{ id: old, content: 'BETA pays closers 12% since October' }], retire: [{ id: gone }, { id: 99999 }] }));
    const out = await L.learnAfterTurn({ agent, userId: 1, threadId: t.id, question: 'What do we pay BETA closers now?', reply: 'Since October BETA closers get 12% and DELTA is no longer a client of ours.' });
    expect(out?.split('; ')).toHaveLength(3); // capped at 3
    expect(S.agentNotes(agent.id).map((n) => n.content)).toContain('Triage sets paid in full pay the setter 2%');
    expect(S.listMemory(1).map((n) => n.content)).toContain('Sam wants totals first');
    expect(S.agentNotes(agent.id).find((n) => n.id === old)?.content).toBe('BETA pays closers 12% since October');
    expect(S.agentNotes(agent.id).some((n) => n.id === gone)).toBe(true); // the 4th change (retire) was not made
    const log = L.listLog(1);
    expect(log.map((c) => c.action).sort()).toEqual(['add', 'add', 'update']);
    for (const c of log) L.undoChange(c.id, 1);
    expect(S.agentNotes(agent.id).map((n) => n.content)).not.toContain('Triage sets paid in full pay the setter 2%');
    expect(S.listMemory(1)).toHaveLength(0);
    expect(S.agentNotes(agent.id).find((n) => n.id === old)?.content).toBe('BETA pays closers 10%');
    expect(() => L.undoChange(log[0].id, 1)).toThrow(/Already/);
  });
  it('not for reps, not for short exchanges', async () => {
    expect(await L.learnAfterTurn({ agent, userId: 3, threadId: 1, question: 'What is my commission this month?', reply: 'Your commission this month is $1,200 so far.' })).toBeNull();
    expect(await L.learnAfterTurn({ agent, userId: 1, threadId: 1, question: 'thanks', reply: 'You are welcome, anything else?' })).toBeNull();
  });
});

describe('always remember', () => {
  it('appends, replaces, caps, shows in the prompt, undoes', () => {
    L.coreAppend(agent.id, 'Work for the agency: owner Sam, partner Sam', 'agent', 1, null);
    L.coreReplace(agent.id, 'partner Sam', 'partners Sam and Morgan', 'agent', 1, null);
    expect(S.getCore(agent.id)).toBe('- Work for the agency: owner Sam, partners Sam and Morgan');
    expect(S.notebookPrompt(agent)).toContain('partners Sam and Morgan');
    expect(() => L.coreReplace(agent.id, 'not there', 'x', 'agent', 1, null)).toThrow();
    expect(() => L.coreAppend(agent.id, 'x'.repeat(400) + 'y', 'agent', 1, null)).not.toThrow();
    for (let i = 0; i < 4; i++) try { L.coreAppend(agent.id, `${i} ${'z'.repeat(390)}`, 'agent', 1, null); } catch (e) { expect(String(e)).toMatch(/full/); }
    expect(S.getCore(agent.id).length).toBeLessThanOrEqual(S.CORE_MAX);
    const last = L.listLog(1).find((c) => c.layer === 'core')!;
    L.undoChange(last.id, 1);
    expect(S.getCore(agent.id)).toBe(last.before);
  });
});

describe('conversation summaries', () => {
  it('summarises a quiet lead conversation once, never a rep\'s', async () => {
    const t = S.createThread(1, 'Refund rule', 's2', agent.id), r = S.createThread(3, 'Mine', 's3', agent.id);
    S.addMessage(t.id, 'user', 'Refunds count in the month they happen.'); S.addMessage(t.id, 'assistant', 'Noted.');
    S.addMessage(r.id, 'user', 'rep question'); S.addMessage(r.id, 'assistant', 'answer');
    db.prepare("UPDATE ai_messages SET created_at = '2026-10-20T10:00:00Z'").run();
    answers.push(JSON.stringify({ summary: 'Sam set refunds to count in the month they happen.', people: ['Sam'] }));
    prompts.length = 0;
    expect(await L.summarizeIdle(6)).toBeGreaterThanOrEqual(1);
    expect(prompts.some((p) => p.includes('rep question'))).toBe(false);
    expect(L.summarySources().map((s) => s.body)).toContain('Sam set refunds to count in the month they happen.\nAbout: Sam');
    expect(await L.summarizeIdle(6)).toBe(0); // nothing new since
  });
});

describe('insights', () => {
  it('keeps insights with 2+ sources and 50%+ confidence, with their evidence; undo removes one', async () => {
    for (const c of ['BETA no-shows rose on Mondays in September', 'ACME no-shows rose on Mondays', 'GAMMA moved calls off Mondays', 'Refunds count in their month', 'DELTA departed'])
      T.addTeamItem({ kind: 'decision', content: c, who: 'Sam', day: '2026-10-20' });
    answers.push(JSON.stringify({ insights: [{ text: 'Monday calls no-show more across contracts', evidence: [1, 2, 3], confidence: 0.8 },
      { text: 'One source only', evidence: [4], confidence: 0.9 }, { text: 'Weak guess', evidence: [1, 2], confidence: 0.3 }], retire: [] }));
    expect(await L.insightPass('2026-10-22')).toBe('insights: 1 new, 0 retired');
    const ins = T.allTeamItems().filter((t) => t.kind === 'insight');
    expect(ins).toHaveLength(1);
    expect(JSON.parse(ins[0].evidence!)).toHaveLength(3);
    L.undoChange(L.listLog(1).find((c) => c.layer === 'insight')!.id, 1);
    expect(T.allTeamItems().filter((t) => t.kind === 'insight')).toHaveLength(0);
  });
});
