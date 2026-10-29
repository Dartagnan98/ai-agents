import { describe, expect, it, vi } from 'vitest';

// Agents talking to each other (D, 2026-10-23, lib/ai/comms.ts): limits, ask (read only, answer credited), hand-off (run by the clock,
// result posted back), messages (woken by the clock, inbox read once), and runs nobody typed never acting outside.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users (id, username) VALUES (1, 'dee');`);
  return { db };
});
vi.mock('@/lib/report-tz', () => ({ reportTz: () => 'America/New_York', tzName: () => 'Eastern' }));
vi.mock('@/lib/user-access', () => ({ getGrant: () => ({ role: 'owner' }) }));
vi.mock('@/lib/brand', () => ({ getBrand: () => ({ short: 'the agency' }) }));
vi.mock('@/lib/ai/agency-values', () => ({ strategyPrompt: () => '' }));
vi.mock('../access', () => ({ aiTierOf: () => 'full' }));
vi.mock('../team-memory', () => ({ recallFor: async () => '' }));
vi.mock('../tools', () => ({ mintRunKey: () => 'k', revokeRunKey: () => {}, stepTitle: () => '', toolAllowedFor: () => true }));
const runs: { system: string; prompt: string; tools: string[] }[] = [];
let answer = 'The refund rule: refunds count in the month they happen.';
vi.mock('../runners', () => ({ RUNNERS: new Proxy({}, { get: () => async (i: { system: string; prompt: string; tools: string[]; onText: (t: string) => void }) => { runs.push(i); i.onText(answer); return {}; } }) }));

const S = await import('../store');
const C = await import('../comms');
const base = { description: '', instructions: '', model: '', tools: [] as string[], use_memory: true, starters: [] as string[], icon: 'sparkles', color: 'ink' };
const main = S.createAgent({ ...base, name: 'the AI', description: 'Main agent' }, 1);
const { db } = await import('@/lib/db');
db.prepare('UPDATE ai_agents SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(main.id);
main.is_default = true;
const analyst = S.createAgent({ ...base, name: 'Numbers', description: 'Numbers and money rules' }, 1);
const ops = S.createAgent({ ...base, name: 'Slacker', description: 'Slack and people' }, 1);
const chat = { depth: 0, chain: [main.id], ownerStarted: true };

describe('limits', () => {
  it('never itself, never deeper than 2, never back up the chain', () => {
    expect(C.checkStart(main.id, main.id, chat, 1, 'ask')).toMatch(/itself/);
    expect(C.checkStart(main.id, analyst.id, { ...chat, depth: 2 }, 1, 'ask')).toMatch(/deep/);
    expect(C.checkStart(analyst.id, main.id, { depth: 1, chain: [main.id, analyst.id], ownerStarted: true }, 1, 'handoff')).toMatch(/loop/);
    expect(C.checkStart(main.id, analyst.id, chat, 1, 'ask')).toBeNull();
    expect(C.findAgent('@numbers', 1)?.id).toBe(analyst.id);
  });
});

describe('ask_agent', () => {
  it('runs the asked agent read only and credits the answer', async () => {
    runs.length = 0;
    const t = S.createThread(1, 'chat', 's', main.id);
    const out = await C.askAgent({ fromAgent: main.id, to: analyst, userId: 1, question: 'What is the refund rule?', originThread: t.id, ctx: chat });
    expect(out).toMatch(/^Answer from Numbers/);
    expect(out).toContain('refunds count in the month');
    expect(runs[0].system).toContain('the AI asked you');
    expect(runs[0].tools).not.toContain('propose_slack_post'); // an ask never acts
    expect(runs[0].tools).not.toContain('ask_agent');
    expect(C.listComms()[0]).toMatchObject({ kind: 'ask', status: 'done', from_name: 'the AI', to_name: 'Numbers' });
  });
});

describe('hand_off and messages on the clock', () => {
  it('runs the hand-off and posts the result back credited; nobody-typed chains lose Slack posts', async () => {
    runs.length = 0;
    const t = S.createThread(1, 'chat', 's2', main.id);
    C.handOff({ fromAgent: main.id, to: ops, userId: 1, brief: 'DM Alex the leaderboard', originThread: t.id, ctx: { ...chat, ownerStarted: false } });
    answer = 'Posted it.';
    await C.deliverComms('test');
    expect(runs).toHaveLength(1);
    expect(runs[0].tools).not.toContain('propose_slack_post');
    const back = S.listMessages(t.id).at(-1)!;
    expect(back.text).toMatch(/^\*\*Slacker finished the hand-off from the AI\*\*/);
    expect(C.listComms()[0]).toMatchObject({ kind: 'handoff', status: 'done', reply: 'Posted it.' });
  });
  it('wakes an agent with its messages once; the inbox is read once', async () => {
    runs.length = 0;
    const id = C.messageAgent({ fromAgent: analyst.id, to: ops, userId: 1, text: 'Who is Jamie?', originThread: null, ctx: chat });
    await C.deliverComms('test');
    expect(runs[0].prompt).toContain(`#${id} from Numbers: Who is Jamie?`);
    await C.deliverComms('test');
    expect(runs).toHaveLength(1);
    C.messageAgent({ fromAgent: ops.id, to: analyst, userId: 1, text: 'Jamie is BETA', replyTo: id, originThread: null, ctx: chat });
    expect(C.inboxBlock(analyst.id)).toContain(`(reply to #${id})`);
    expect(C.inboxBlock(analyst.id)).toBe('');
  });
  it('the main agent sees the team; others get a pointer', () => {
    expect(C.rosterBlock(main)).toContain('- Numbers: Numbers and money rules');
    expect(C.rosterBlock(analyst)).toContain('agents_list');
  });
});
