import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/report-tz', () => ({ reportTz: () => 'America/New_York' }));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE ai_agents (id INTEGER PRIMARY KEY, name TEXT, daily_budget_usd REAL); INSERT INTO ai_agents VALUES (1, 'Ledger', 5), (2, 'Fleet AI', NULL)`);
  return { db };
});
const U = await import('../usage'), S = await import('../shift');
const { db } = await import('@/lib/db');

describe('per-agent daily cap and day/night ', () => {
  it('stops an agent once today passes its cap; no cap = never', () => {
    expect(U.overBudget(1)).toBeNull();
    U.recordTurn({ threadId: 1, userId: 1, agentId: 1, model: 'x', source: 'routine', ok: true });
    db.prepare('UPDATE ai_turns SET cost_usd = 6').run();
    expect(U.overBudget(1)).toMatch(/daily cap \(\$6\.00 of \$5\.00/);
    db.prepare("INSERT INTO ai_turns (agent_id, cost_usd) VALUES (2, 999)").run();
    expect(U.overBudget(2)).toBeNull();
    expect(U.overBudget(null)).toBeNull();
  });
  it('night is 00:00 to 08:00 in the business zone', () => {
    expect(S.isNight(new Date('2026-10-28T09:00:00Z'))).toBe(true); // 05:00 ET
    expect(S.isNight(new Date('2026-10-28T13:00:00Z'))).toBe(false); // 09:00 ET
    expect(S.shiftBlock(new Date('2026-10-28T09:00:00Z'))).toContain('Night mode');
  });
});
