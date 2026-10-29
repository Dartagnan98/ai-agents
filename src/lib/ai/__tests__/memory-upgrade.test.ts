import { describe, expect, it, vi } from 'vitest';

// The memory upgrade (D, 2026-10-28, CTRL Flow parity): corrections become lessons carried in every prompt; the nightly cleanup retires
// copies, merges look-alikes through the model, sends notes that disagree to a person and keeps a cap; a message that leans on the one
// before is searched with it. An in-memory SQLite and a fake model.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users (id, username) VALUES (1, 'Sam');
    CREATE TABLE kb_docs (id INTEGER PRIMARY KEY, space TEXT, folder TEXT, title TEXT, body TEXT, updated_at TEXT);
    CREATE TABLE rep_staff (person_key TEXT PRIMARY KEY, name TEXT, active INTEGER NOT NULL DEFAULT 1);`);
  return { db };
});
vi.mock('@/lib/user-access', () => ({ getGrant: () => ({ role: 'owner' }) }));
vi.mock('@/lib/slack/app', () => ({ botToken: () => null }));
vi.mock('@/lib/agency-secrets', () => ({ agencySecretValues: () => ({}) }));
vi.mock('@/lib/report-tz', () => ({ reportTz: () => 'America/New_York', tzName: () => 'Eastern' }));
vi.mock('../tools', () => ({ mintRunKey: () => 'k', revokeRunKey: () => {} }));
const answers: string[] = [];
vi.mock('../runners', () => ({ RUNNERS: new Proxy({}, { get: () => async (i: { onText: (t: string) => void }) => { i.onText(answers.shift() ?? '{}'); return {}; } }) }));

const S = await import('../store');
const Les = await import('../lessons');
const Tidy = await import('../memory-tidy');
const { searchText } = await import('../team-memory');
const { db } = await import('@/lib/db');
const agent = S.defaultAgent()!;

describe('lessons', () => {
  it('a lesson is saved once, carried in the prompt, and dropping it stops it', () => {
    const id = Les.addLesson(agent.id, 1, 'Quote cash after refunds, never before, on every money answer.', null, 'chat')!;
    expect(Les.addLesson(agent.id, 1, 'Quote cash after refunds, never before, on every money answer.', null, 'chat')).toBeNull();
    expect(S.notebookPrompt(agent)).toContain('Quote cash after refunds');
    expect(Les.dropLesson(id, 'test')).toBe(true);
    expect(S.notebookPrompt(agent)).not.toContain('Quote cash after refunds');
  });
  it('a denied change writes the rule the model gives', async () => {
    const t = S.createThread(1, 'x', 'sid', agent.id);
    answers.push('{"lesson": "Ask before posting to client channels."}');
    await Les.lessonFromDenial({ threadId: t.id, userId: 1, tool: 'propose_slack_post', summary: 'Post to #client' });
    expect(Les.agentLessons(agent.id).map((l) => l.content)).toContain('Ask before posting to client channels.');
  });
});

describe('nightly cleanup', () => {
  it('retires near copies, merges look-alikes, flags notes that disagree', async () => {
    const add = (t: string) => S.addAgentNote(agent.id, 1, t, null);
    add('ACME setters earn 2.5% on pre-op sets paid in full');
    add('ACME setters earn 2.5% on pre-op sets paid in full.');            // a copy
    const m1 = add('BETA webinar sets pay the setter 2% when paid in full');
    const m2 = add('On BETA, a webinar set pays its setter 2% if the client paid in full');
    answers.push(JSON.stringify({ merge: [{ ids: [m1, m2], content: 'BETA webinar sets pay the setter 2% when the client paid in full.' }], conflict: [] }));
    const out = await Tidy.tidyAgent(agent);
    expect(out).toContain('1 copies');
    expect(out).toContain('1 merged');
    const live = S.agentNotes(agent.id).map((n) => n.content);
    expect(live.filter((c) => c.startsWith('ACME setters earn'))).toHaveLength(1);
    expect(live).toContain('BETA webinar sets pay the setter 2% when the client paid in full.');
    const c1 = add('Epsilon closers earn 10% when nobody set the call');
    const c2 = add('Epsilon closers earn 15% when nobody set the call');
    answers.push(JSON.stringify({ merge: [], conflict: [{ ids: [c1, c2], why: '10% or 15%' }] }));
    await Tidy.tidyAgent(agent);
    const [c] = Tidy.openConflicts();
    expect(c.why).toBe('10% or 15%');
    expect(Tidy.resolveConflict(c.id, 'a', 'test')).toBe(true);
    expect(S.agentNotes(agent.id).map((n) => n.content)).not.toContain('Epsilon closers earn 15% when nobody set the call');
    expect((db.prepare('SELECT count(*) n FROM ai_memory_log WHERE by LIKE ?').get('tidy%') as { n: number }).n).toBeGreaterThan(0);
  });
});

describe('searching with the message before', () => {
  it('a short or leaning message takes the previous one along; a full question stands alone', () => {
    expect(searchText('what about him?', 'How much did Alex Kim close in October')).toContain('Alex Kim');
    const full = 'How much cash did the ACME closers collect in October after refunds and fees on processors';
    expect(searchText(full, 'something else')).toBe(full);
  });
});
