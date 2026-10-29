import 'server-only';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import type { Usage } from './runners/types';
import { reportTz } from '@/lib/report-tz';
import { todayIn } from '@/lib/sales-range';
import { zoneMidnight } from '@/lib/tz';

// AI turn log (D, 2026-10-10: Operations › Analytics per agency). The runners report no cost and no per-turn token bill; Claude and the
// API runners only say how full the conversation is (`context` tokens). So each answer logs what is known: when, chat or routine, the
// agent, the model it ran on, that context size and whether it failed. Rows are in the agency's own SQLite. Logging never breaks a turn.
const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, user_id INTEGER, agent_id INTEGER, model TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'chat', context_tokens INTEGER, ok INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_ai_turns_at ON ai_turns (created_at);`);
  // tokens and cost per message (D, 2026-10-12)
  const cols = (db.prepare('PRAGMA table_info(ai_turns)').all() as { name: string }[]).map((c) => c.name);
  for (const c of ['input_tokens', 'output_tokens', 'cache_read', 'cache_write']) if (!cols.includes(c)) db.exec(`ALTER TABLE ai_turns ADD COLUMN ${c} INTEGER`);
  if (!cols.includes('cost_usd')) db.exec('ALTER TABLE ai_turns ADD COLUMN cost_usd REAL');
  ready.mark();
}

export interface TurnLog { threadId: number | null; userId: number | null; agentId: number | null; model: string; source: 'chat' | 'routine' | 'agent_ask' | 'agent_message' | 'agent_handoff'; context?: number | null; ok: boolean; usage?: Usage }

// Anthropic list prices per million tokens (input, output, cache read), 2026-10. A cache write is billed at 2x input (the runners write
// 1-hour caches; 5-minute writes are 1.25x, so this reads a little high for the subscription runner). On the subscription it is what the
// same message would cost on an API key ("API price"), not a bill. Other providers: tokens only, no price.
const CLAUDE_PRICES: Record<string, [number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2], 'claude-sonnet-5-5': [2, 10, 0.2], 'claude-haiku-5-5': [0.1, 0.5, 0.01],
};
/** What a message costs at Anthropic's API prices, or null for a model without a price here. `model` = 'provider:wire' or a bare id. */
export function claudeCost(model: string, u: Usage): number | null {
  const p = CLAUDE_PRICES[model.includes(':') ? model.split(':').slice(1).join(':') : model];
  if (!p) return null;
  return (u.input * p[0] + u.cacheWrite * p[0] * 2 + u.output * p[1] + u.cacheRead * p[2]) / 1_000_000;
}

/** Logs one answer. Swallows every error: the log is for the Analytics page, never a reason a reply fails. */
export function recordTurn(t: TurnLog): void {
  try {
    ensure();
    const u = t.usage;
    db.prepare(`INSERT INTO ai_turns (thread_id, user_id, agent_id, model, source, context_tokens, ok, input_tokens, output_tokens, cache_read, cache_write, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(t.threadId, t.userId, t.agentId, t.model.slice(0, 80), t.source, t.context ? Math.round(t.context) : null, t.ok ? 1 : 0,
        u?.input ?? null, u?.output ?? null, u?.cacheRead ?? null, u?.cacheWrite ?? null, u ? claudeCost(t.model, u) : null);
  } catch { /* never block a turn */ }
}

export interface TurnRow { created_at: string; agent_id: number | null; model: string; source: string; context_tokens: number | null; ok: number; input_tokens: number | null; output_tokens: number | null; cache_read: number | null; cache_write: number | null; cost_usd: number | null }
/** Turns since `sinceIso` (the page buckets them into the agency's days). */
export function turnsSince(sinceIso: string): TurnRow[] {
  ensure();
  return db.prepare('SELECT created_at, agent_id, model, source, context_tokens, ok, input_tokens, output_tokens, cache_read, cache_write, cost_usd FROM ai_turns WHERE created_at >= ? ORDER BY id').all(sinceIso) as TurnRow[];
}

/** When the turn log started in this agency (the first row), or null. */
export function firstTurnAt(): string | null {
  ensure();
  return (db.prepare('SELECT MIN(created_at) AS at FROM ai_turns').get() as { at: string | null }).at;
}

// ─── spend per agent (D 2026-10-28: a daily cap and a spend alert) ───
// cost_usd is the API-price estimate of each answer (a Claude plan bills nothing per answer, so it is a measure of use, not money spent).
const midnight = () => zoneMidnight(todayIn(reportTz()), reportTz());
/** An agent's spend since local midnight, or since `fromIso`. */
export function agentSpend(agentId: number, fromIso = midnight()): number {
  ensure();
  return (db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_turns WHERE agent_id = ? AND created_at >= ?').get(agentId, fromIso) as { c: number }).c;
}
/** Its own daily cap (ai_agents.daily_budget_usd, null = none), or null. */
export function agentCap(agentId: number): number | null {
  try { return (db.prepare('SELECT daily_budget_usd AS c FROM ai_agents WHERE id = ?').get(agentId) as { c: number | null } | undefined)?.c ?? null; } catch { return null; }
}
/** Why an agent may not start a run nobody is watching now (its daily cap is reached), or null. Never throws. */
export function overBudget(agentId: number | null | undefined): string | null {
  if (!agentId) return null;
  try {
    const cap = agentCap(agentId);
    if (cap === null || cap <= 0) return null;
    const spent = agentSpend(agentId);
    return spent >= cap ? `This agent reached its daily cap ($${spent.toFixed(2)} of $${cap.toFixed(2)} today, API prices). It runs again after midnight, or raise the cap in Operations › Agents.` : null;
  } catch { return null; }
}
/** From the routine clock, at most every 10 minutes: once a day per agent, a Telegram note to the owners when today's spend passes the larger
 *  of $20 and twice its daily average over the 7 days before. Never throws. */
let lastAlertCheck = 0;
export async function spendAlerts(): Promise<void> {
  if (Date.now() - lastAlertCheck < 10 * 60_000) return;
  lastAlertCheck = Date.now();
  try {
    ensure();
    db.exec('CREATE TABLE IF NOT EXISTS ai_spend_alerts (agent_id INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY (agent_id, day))');
    const day = todayIn(reportTz()), from = midnight(), weekAgo = new Date(Date.parse(from) - 7 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const rows = db.prepare(`SELECT t.agent_id id, a.name, SUM(CASE WHEN t.created_at >= ? THEN COALESCE(t.cost_usd, 0) ELSE 0 END) today,
        SUM(CASE WHEN t.created_at < ? THEN COALESCE(t.cost_usd, 0) ELSE 0 END) / 7.0 avg
      FROM ai_turns t JOIN ai_agents a ON a.id = t.agent_id WHERE t.created_at >= ? GROUP BY t.agent_id`).all(from, from, weekAgo) as { id: number; name: string; today: number; avg: number }[];
    for (const r of rows) {
      if (r.today < Math.max(20, 2 * r.avg) || db.prepare('SELECT 1 FROM ai_spend_alerts WHERE agent_id = ? AND day = ?').get(r.id, day)) continue;
      db.prepare('INSERT INTO ai_spend_alerts (agent_id, day) VALUES (?, ?)').run(r.id, day);
      await (await import('./telegram')).tellOwners(`${r.name} used $${r.today.toFixed(2)} of AI today (API prices), over its usual ($${r.avg.toFixed(2)} a day). Check Operations › Analytics.`);
    }
  } catch (e) { console.warn(`[usage] spend alerts: ${e instanceof Error ? e.message : String(e)}`); }
}
