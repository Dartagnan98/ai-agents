import { describe, expect, it, vi } from 'vitest';

// Test runs of routines (D, 2026-10-28: "test them with me"): Slack posts go to the tester marked with where they would have gone,
// API writes and change tools are reported and not done, reads go through.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  return { db: new Database(':memory:') };
});

const { testGate, TEST_SLACK } = await import('../tools');
const run = (test?: { slackTo: string }) => ({ userId: 1, threadId: 0, tools: [], exp: Date.now() + 60_000, test });

describe('test runs', () => {
  it('a Slack post goes to the tester, marked with where it would have gone', () => {
    const args: Record<string, unknown> = { channel: 'C0AB12CD34', text: 'Daily report', thread_ts: '1712345678.123456' };
    expect(testGate(run({ slackTo: 'U0TEST0001' }), 'propose_slack_post', args)).toBeNull();
    expect(args).toEqual({ channel: 'U0TEST0001', text: '[TEST · would post to C0AB12CD34 as a thread reply]\nDaily report' });
  });
  it('a test run sends at most 5 posts to the tester, the rest are listed', () => {
    const t = run({ slackTo: 'U0TEST0001' });
    for (let i = 0; i < 5; i++) expect(testGate(t, 'propose_slack_post', { channel: 'C0AB12CD34', text: `n${i}` })).toBeNull();
    expect(testGate(t, 'propose_slack_post', { channel: 'C0AB12CD34', text: 'n6' })).toBe('[TEST: not sent, over 5 test posts] to C0AB12CD34: n6');
  });
  it('change tools are reported, not done; reads go through', () => {
    const t = run({ slackTo: 'U0TEST0001' });
    for (const name of ['save_routine', 'propose_skill', 'propose_strategy', 'run_routine']) expect(testGate(t, name, {})).toMatch(/^\[TEST: not done\]/);
    for (const name of ['search_knowledge', 'slack_read', 'remember']) expect(testGate(t, name, {})).toBeNull();
  });
  it('outside a test run nothing changes', () => {
    const args = { channel: 'C0AB12CD34', text: 'x' };
    expect(testGate(run(), 'propose_slack_post', args)).toBeNull();
    expect(args.channel).toBe('C0AB12CD34');
    expect(testGate(run(), 'fix_deal', {})).toBeNull();
  });
  it('test targets are Slack ids only', () => {
    expect(['U0TEST0001', 'D0AGHLB2XMH', 'C09DK48DTDK'].every((x) => TEST_SLACK.test(x))).toBe(true);
    expect(['#general', 'dart@x.com', 'u0test0001'].some((x) => TEST_SLACK.test(x))).toBe(false);
  });
});
