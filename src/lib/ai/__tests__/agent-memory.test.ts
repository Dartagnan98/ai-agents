import { describe, expect, it, vi } from 'vitest';

// Agent memory (D, 2026-10-12): notebooks apart from personal notes, the nightly pass (log, new notes, stale flags, secrets scrubbed,
// once per day) against an in-memory SQLite and a fake model, and yesterday's bounds in the agency's zone.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users (id, username) VALUES (1, 'dee'), (2, 'yas');`);
  return { db };
});
vi.mock('@/lib/report-tz', () => ({ reportTz: () => 'America/New_York' }));
vi.mock('@/lib/user-access', () => ({ getGrant: () => ({ role: 'owner' }) })); // team memory (memory-nightly) reads roles

vi.mock('@/lib/agency-secrets', () => ({ agencySecretValues: () => ({ GHL_ADPI_TOKEN: 'pit' + '-11111111-2222-3333-4444-555555555555' }) }));
vi.mock('../tools', () => ({ mintRunKey: () => 'k', revokeRunKey: () => {} }));
let answer = '';
const prompts: string[] = [];
vi.mock('../runners', () => ({ RUNNERS: new Proxy({}, { get: () => async (i: { prompt: string; onText: (t: string) => void }) => { prompts.push(i.prompt); i.onText(answer); return {}; } }) }));

const S = await import('../store');
const N = await import('../memory-nightly');

describe('dayWindow', () => {
  it('yesterday in the zone, its UTC bounds across DST', () => {
    const w = N.dayWindow('America/New_York', new Date('2026-10-12T08:00:00Z')); // 04:00 EDT
    expect(w).toEqual({ day: '2026-10-11', from: '2026-10-11T04:00:00Z', to: '2026-10-12T04:00:00Z', hour: 4 });
    const n = N.dayWindow('America/New_York', new Date('2026-11-02T09:00:00Z')); // the day after DST ends: 25 hours
    expect(n.from).toBe('2026-11-01T04:00:00Z');
    expect(n.to).toBe('2026-11-02T05:00:00Z');
    expect(N.dayWindow('America/New_York', new Date(Date.parse('2026-10-10T12:00:00Z') + 86_400_000)).day).toBe('2026-10-10'); // a past day (day option)
  });
});

describe('notebooks', () => {
  it('agent notes stay out of personal memory and the other way round', () => {
    const fleet = S.defaultAgent()!;
    S.addMemory(1, 'Dee wants USD with cents', null);
    S.addAgentNote(fleet.id, 1, 'Paul is a client closer: no commission', null);
    expect(S.listMemory(1).map((n) => n.content)).toEqual(['Dee wants USD with cents']);
    expect(S.agentNotes(fleet.id).map((n) => n.content)).toEqual(['Paul is a client closer: no commission']);
    expect(S.clearMemory(1)).toBe(1);
    expect(S.agentNotes(fleet.id)).toHaveLength(1);
    expect(S.notebookPrompt(fleet)).toContain('Paul is a client closer');
  });
});

describe('nightly pass', () => {
  it('writes the log, adds notes, flags stale ones, scrubs secrets, runs once a day', async () => {
    const fleet = S.defaultAgent()!;
    const old = S.agentNotes(fleet.id)[0];
    const mine = S.addMemory(2, 'Yas reports in EUR', null);
    const { day, from } = N.dayWindow('America/New_York');
    const t = S.createThread(2, 'Commission', 's1', fleet.id);
    const { db } = await import('@/lib/db');
    const at = new Date(Date.parse(from) + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare('INSERT INTO ai_messages (thread_id, role, text, created_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
      .run(t.id, 'user', 'Paul closes for us now, pay him 10%', at, t.id, 'assistant', 'Noted.', at);
    answer = `Here: {"log": "Paul now closes for the agency. Key ${'pit'}-11111111-2222-3333-4444-555555555555", "agent_notes": ["Paul is paid 10% on his closes"],
      "agent_stale": [${old.id}, 99999], "personal": [{"user": 2, "notes": ["Yas now reports in USD"], "stale": [${mine}]}, {"user": 1, "notes": ["not in the day"]}],
      "team": [{"kind": "decision", "content": "Paul closes for the agency at 10% of his closes", "who": "Yas", "thread": ${t.id}}, {"kind": "decision", "content": "from a thread not in the day", "who": "x", "thread": 99999}],
      "commitments": [{"who": "Yas", "what": "Send Paul his commission sheet", "due": "2026-10-30", "thread": ${t.id}}, {"who": "x", "what": "not in the day", "thread": 99999}]}`;
    const out = await N.nightlyMemory({ force: true });
    expect(out).toContain('2 new notes, 1 team, 1 commitments, 2 flagged stale');
    // team memory: the decision from that day's lead conversation, with who and the thread; never one from a thread not in the day
    const { listTeamItems } = await import('../team-memory');
    expect(listTeamItems().map((x) => [x.kind, x.content, x.who, x.thread_id])).toEqual([['decision', 'Paul closes for the agency at 10% of his closes', 'Yas', t.id]]);
    expect(prompts[0]).toContain(', LEAD)');
    const { listCommitments } = await import('../team-memory');
    expect(listCommitments().map((c) => [c.who, c.what, c.due, c.thread_id])).toEqual([['Yas', 'Send Paul his commission sheet', '2026-10-30', t.id]]);
    expect(prompts[0]).toContain('pay him 10%');
    const log = S.agentLogs(fleet.id)[0];
    expect(log.day).toBe(day);
    expect(log.content).not.toContain('pit-1111');
    expect(S.agentNotes(fleet.id).map((n) => n.content)).toEqual(['Paul is paid 10% on his closes']);
    expect(S.agentNotes(fleet.id, true).find((n) => n.id === old.id)?.stale).toBe(1);
    expect(S.listMemory(2).map((n) => n.content)).toEqual(['Yas now reports in USD']);
    expect(S.listMemory(1)).toHaveLength(0); // user 1 had no conversation that day
    expect(S.memoryRunDone(day)).toBe(true);
    expect(await N.nightlyMemory()).toBeNull(); // done for the day
    expect(S.setStale([old.id], false, { agentId: fleet.id })).toBe(1); // Keep
    expect(S.agentNotes(fleet.id)).toHaveLength(2);
  });
});
