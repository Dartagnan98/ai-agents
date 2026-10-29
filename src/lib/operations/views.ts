import 'server-only';
import { db } from '@/lib/db';
import { reportTz } from '@/lib/report-tz';
import { tzAbbr, tzName } from '@/lib/tz';
import { describeCron } from '@/lib/ai/cron';
import { ensureRoutines, listRoutines, STALE_RUN_MS, type Routine } from '@/lib/ai/routines';
import { listAgents, type Agent } from '@/lib/ai/store';
import { pendingApprovals } from '@/lib/ai/approvals';
import { listConnections } from '@/lib/ai/connections';
import { availableProviders } from '@/lib/ai/available';
import { findModel, modelOrDefault, MODEL_PROVIDERS, type ModelProvider } from '@/lib/ai/models';
import { firstTurnAt, turnsSince } from '@/lib/ai/usage';

// Operations pages per agency (D, 2026-10-10): Workflows, Fleet health and Analytics built on the agency's own the agents data (routines and
// their runs, agents, approve cards, AI connections, messages and the turn log), all read through `db` = the current agency's SQLite.
// The cortextOS daemon's crons, agent files and cost logs stay the legacy agency's second view (components/operations/legacy-*).

const DAY_MS = 86_400_000;
const fmt = (ms: number | null, tz: string) => (ms ? `${new Date(ms).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ${tzAbbr(tz)}` : '');
/** The agency's calendar day of an instant (YYYY-MM-DD). */
export const dayIn = (ms: number, tz: string) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });

type RunStatus = 'running' | 'ok' | 'skipped' | 'error';
export interface RunView { id: number; routineId: number; routine: string; status: RunStatus; how: string; startedAt: number; finishedAt: number | null; startedText: string; durationMs: number | null; summary: string; threadId: number | null }
export interface RoutineView {
  id: number; name: string; agent: string; agentId: number | null; schedule: string; scheduleText: string; enabled: boolean;
  nextRunAt: number | null; nextRunText: string; lastRunAt: number | null; lastRunText: string; lastStatus: RunStatus | 'never'; lastError: string;
  lastThreadId: number | null; sends: string[]; runs: RunView[];
}

function agentName(agents: Agent[], id: number | null): string {
  return (agents.find((a) => a.id === id) ?? agents.find((a) => a.is_default))?.name ?? 'Agent';
}
function lastStatus(r: Routine, now: number): RoutineView['lastStatus'] {
  const s = r.last_status ?? '';
  if (s === 'running') return r.running_since && now - r.running_since < STALE_RUN_MS ? 'running' : 'error';
  if (s.startsWith('error')) return 'error';
  return s === 'ok' || s === 'skipped' ? s : 'never';
}

interface RunRow { id: number; routine_id: number; started_at: number; finished_at: number | null; status: RunStatus; thread_id: number | null; summary: string; how: string; name: string }
function runRows(sql: string, ...args: unknown[]): RunRow[] {
  ensureRoutines();
  return db.prepare(`SELECT r.*, COALESCE(a.name, 'Deleted routine') AS name FROM ai_routine_runs r LEFT JOIN ai_routines a ON a.id = r.routine_id ${sql}`).all(...args) as RunRow[];
}
const runView = (r: RunRow, tz: string): RunView => ({
  id: r.id, routineId: r.routine_id, routine: r.name, status: r.status, how: r.how, startedAt: r.started_at, finishedAt: r.finished_at,
  startedText: fmt(r.started_at, tz), durationMs: r.finished_at ? r.finished_at - r.started_at : null, summary: r.summary, threadId: r.thread_id,
});

/** Workflows: the agency's routines as a schedule (agency zone), with each one's last runs and the latest runs across all of them. */
export function workflowsView(now = Date.now()) {
  const tz = reportTz();
  const agents = listAgents();
  const routines = listRoutines();
  const perRoutine = new Map<number, RunView[]>();
  // the last 10 runs of each routine, in one query
  ensureRoutines();
  const last10 = db.prepare(`SELECT * FROM (SELECT r.*, COALESCE(a.name, 'Deleted routine') AS name, ROW_NUMBER() OVER (PARTITION BY r.routine_id ORDER BY r.id DESC) AS n
      FROM ai_routine_runs r LEFT JOIN ai_routines a ON a.id = r.routine_id) WHERE n <= 10 ORDER BY id DESC`).all() as RunRow[];
  for (const r of last10) {
    perRoutine.set(r.routine_id, [...(perRoutine.get(r.routine_id) ?? []), runView(r, tz)]);
  }
  const rows: RoutineView[] = routines.map((r) => ({
    id: r.id, name: r.name, agent: agentName(agents, r.agent_id), agentId: r.agent_id, schedule: r.schedule, scheduleText: describeCron(r.schedule, tz),
    enabled: r.enabled, nextRunAt: r.enabled ? r.next_run_at : null, nextRunText: r.enabled ? fmt(r.next_run_at, tz) : '',
    lastRunAt: r.last_run_at, lastRunText: fmt(r.last_run_at, tz), lastStatus: lastStatus(r, now),
    lastError: (r.last_status ?? '').startsWith('error') ? (r.last_status ?? '').replace(/^error:\s*/, '') : '', lastThreadId: r.last_thread_id,
    sends: ['Conversation', ...(r.deliver.telegram ? ['Telegram'] : []), ...(r.deliver.slack ? ['Slack'] : [])], runs: perRoutine.get(r.id) ?? [],
  }));
  // the schedule order: on and next first, then off
  rows.sort((a, b) => (a.enabled === b.enabled ? (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name) : a.enabled ? -1 : 1));
  const recent = runRows('ORDER BY r.id DESC LIMIT 40').map((r) => runView(r, tz));
  return { tz, tzName: tzName(tz), tzAbbr: tzAbbr(tz), routines: rows, recent, on: rows.filter((r) => r.enabled).length };
}

export type HealthState = 'healthy' | 'warning' | 'failing' | 'never' | 'off';
export interface RoutineHealth { id: number; name: string; agent: string; state: HealthState; reason: string; enabled: boolean; lastRunText: string; lastRunAt: number | null; runs7: number; failed7: number; skipped7: number; nextRunText: string; lastThreadId: number | null }
export interface WaitingApproval { id: number; summary: string; tool: string; createdAt: string; threadId: number; routine: string | null }
export interface AgentHealth { id: number; name: string; model: string; provider: string; connected: boolean; routines: number; lastUsed: string | null; isDefault: boolean }
export interface ConnectionHealth { id: ModelProvider; label: string; on: boolean; status: string; detail: string }

/** Fleet health: every routine's state (last run, failures and skips in the last 7 days, missed or stuck runs), approve cards still
 *  waiting (from routine runs and chats), the agents and whether their model is connected, and the AI connections. */
export function healthView(now = Date.now()) {
  const tz = reportTz();
  const agents = listAgents();
  const routines = listRoutines();
  ensureRoutines();
  const since = now - 7 * DAY_MS;
  const counts = new Map((db.prepare(`SELECT routine_id, COUNT(*) AS runs, SUM(status = 'error') AS failed, SUM(status = 'skipped') AS skipped
      FROM ai_routine_runs WHERE started_at >= ? GROUP BY routine_id`).all(since) as { routine_id: number; runs: number; failed: number; skipped: number }[])
    .map((r) => [r.routine_id, r]));
  const health: RoutineHealth[] = routines.map((r) => {
    const c = counts.get(r.id) ?? { runs: 0, failed: 0, skipped: 0 };
    const st = lastStatus(r, now);
    const stuck = r.running_since !== null && now - r.running_since >= STALE_RUN_MS;
    const missed = r.enabled && r.next_run_at !== null && r.next_run_at < now - 15 * 60_000 && !r.running_since;
    let state: HealthState, reason: string;
    if (!r.enabled) { state = 'off'; reason = 'Switched off.'; }
    else if (stuck) { state = 'failing'; reason = 'A run has said nothing for over 30 minutes.'; }
    else if (st === 'error') { state = 'failing'; reason = (r.last_status ?? '').replace(/^error:\s*/, '') || 'The last run failed.'; }
    else if (missed) { state = 'warning'; reason = `It was due ${fmt(r.next_run_at, tz)} and has not run.`; }
    else if (c.failed > 0) { state = 'warning'; reason = `${c.failed} of ${c.runs} runs failed in the last 7 days.`; }
    else if (st === 'never') { state = 'never'; reason = 'On, not run yet.'; }
    else { state = 'healthy'; reason = st === 'skipped' ? 'Last run skipped (its condition was not met).' : st === 'running' ? 'Running now.' : 'Last run went through.'; }
    return { id: r.id, name: r.name, agent: agentName(agents, r.agent_id), state, reason, enabled: r.enabled, lastRunText: fmt(r.last_run_at, tz), lastRunAt: r.last_run_at,
      runs7: c.runs, failed7: c.failed, skipped7: c.skipped, nextRunText: r.enabled ? fmt(r.next_run_at, tz) : '', lastThreadId: r.last_thread_id };
  });
  const order: Record<HealthState, number> = { failing: 0, warning: 1, never: 2, healthy: 3, off: 4 };
  health.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));

  // approve cards: a routine run's thread names its routine
  const runThreads = new Map((db.prepare('SELECT r.thread_id, COALESCE(a.name, \'Deleted routine\') AS name FROM ai_routine_runs r LEFT JOIN ai_routines a ON a.id = r.routine_id WHERE r.thread_id IS NOT NULL')
    .all() as { thread_id: number; name: string }[]).map((r) => [r.thread_id, r.name]));
  const waiting: WaitingApproval[] = pendingApprovals().map((a) => ({ id: a.id, summary: a.summary, tool: a.tool, createdAt: a.created_at, threadId: a.thread_id, routine: runThreads.get(a.thread_id) ?? null }));

  const on = new Set(availableProviders());
  const used = new Map((db.prepare('SELECT agent_id, MAX(updated_at) AS at FROM ai_threads GROUP BY agent_id').all() as { agent_id: number | null; at: string }[]).map((r) => [r.agent_id, r.at]));
  const agentRows: AgentHealth[] = agents.map((a) => {
    const m = modelOrDefault(a.model);
    return { id: a.id, name: a.name, model: m.label, provider: MODEL_PROVIDERS.find((p) => p.id === m.provider)?.label ?? m.provider, connected: on.has(m.provider),
      routines: routines.filter((r) => (r.agent_id ?? agents.find((x) => x.is_default)?.id) === a.id).length,
      lastUsed: used.get(a.id) ?? (a.is_default ? used.get(null) ?? null : null), isDefault: a.is_default };
  });

  const conns = Object.fromEntries(listConnections().map((c) => [c.kind, c]));
  const kindOf: Record<ModelProvider, string> = { 'claude-cli': 'claude-token', 'anthropic-api': 'anthropic-key', 'openai-api': 'openai-key', 'xai-api': 'xai-key', 'chatgpt-plan': 'chatgpt-plan', 'grok-plan': 'grok-plan' };
  const connections: ConnectionHealth[] = MODEL_PROVIDERS.map((p) => {
    const c = conns[kindOf[p.id]];
    const status = on.has(p.id) ? (c?.status && c.status !== 'ok' ? c.status : 'connected') : c?.connected ? (c.status || 'error') : 'not connected';
    return { id: p.id, label: p.label, on: on.has(p.id), status, detail: c?.detail ?? (p.id === 'claude-cli' && on.has(p.id) && !c?.connected ? 'The server\'s own Claude login.' : '') };
  });
  return { tz, health, waiting, agents: agentRows, connections, connected: connections.filter((c) => c.on).length };
}

export interface DayUsage { day: string; chat: number; routineRuns: number; failedRuns: number; turns: number }
// per-answer tokens and API-price cost (D, 2026-10-12): read = every input token incl. cache, cached = the part read from cache
export interface UsageSlice { key: string; label: string; chat: number; runs: number; turns: number; tokens: number; withTokens: number; failed: number; cost: number; costed: number; read: number; cached: number; output: number }

/** Analytics: the agents use per agency day for the last `days` days, by agent and by model. Messages = what people sent in chats; routine
 *  runs from their history; model and context size come from the turn log (lib/ai/usage.ts), which starts on the day it shipped. */
/** `from` (ms): count from there instead of `days` back (This month, D 2026-10-14). */
export function usageView(days: number, now = Date.now(), from?: number) {
  const tz = reportTz();
  const agents = listAgents();
  const routines = listRoutines();
  const sinceMs = from ?? now - days * DAY_MS;
  const sinceIso = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const routineThreads = new Set((db.prepare('SELECT thread_id FROM ai_routine_runs WHERE thread_id IS NOT NULL').all() as { thread_id: number }[]).map((r) => r.thread_id));
  const msgs = (db.prepare(`SELECT m.created_at, m.thread_id, t.agent_id FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id
      WHERE m.role = 'user' AND m.created_at >= ?`).all(sinceIso) as { created_at: string; thread_id: number; agent_id: number | null }[])
    .filter((m) => !routineThreads.has(m.thread_id));
  const runs = db.prepare('SELECT started_at, status, routine_id FROM ai_routine_runs WHERE started_at >= ?').all(sinceMs) as { started_at: number; status: string; routine_id: number }[];
  const turns = turnsSince(sinceIso);

  const dayList: string[] = [];
  for (let t = from ?? now - (days - 1) * DAY_MS; t <= now; t += DAY_MS) { const d = dayIn(t, tz); if (!dayList.includes(d)) dayList.push(d); }
  const byDay = new Map<string, DayUsage>(dayList.map((d) => [d, { day: d, chat: 0, routineRuns: 0, failedRuns: 0, turns: 0 }]));
  const bump = (iso: string | number, f: (d: DayUsage) => void) => { const d = byDay.get(dayIn(typeof iso === 'number' ? iso : Date.parse(iso), tz)); if (d) f(d); };
  for (const m of msgs) bump(m.created_at, (d) => { d.chat++; });
  for (const r of runs) bump(r.started_at, (d) => { d.routineRuns++; if (r.status === 'error') d.failedRuns++; });
  for (const t of turns) bump(t.created_at, (d) => { d.turns++; });

  const defaultId = agents.find((a) => a.is_default)?.id ?? null;
  const slice = (m: Map<string, UsageSlice>, key: string, label: string) => { let s = m.get(key); if (!s) m.set(key, (s = { key, label, chat: 0, runs: 0, turns: 0, tokens: 0, withTokens: 0, failed: 0, cost: 0, costed: 0, read: 0, cached: 0, output: 0 })); return s; };
  const byAgent = new Map<string, UsageSlice>();
  const agentKey = (id: number | null) => String(id ?? defaultId ?? 0);
  for (const m of msgs) slice(byAgent, agentKey(m.agent_id), agentName(agents, m.agent_id)).chat++;
  for (const r of runs) { const ro = routines.find((x) => x.id === r.routine_id); slice(byAgent, agentKey(ro?.agent_id ?? null), agentName(agents, ro?.agent_id ?? null)).runs++; }
  const byModel = new Map<string, UsageSlice>();
  for (const t of turns) {
    for (const s of [slice(byAgent, agentKey(t.agent_id), agentName(agents, t.agent_id)), slice(byModel, t.model || 'unknown', findModel(t.model)?.label ?? (t.model || 'Unknown'))]) {
      s.turns++; if (!t.ok) s.failed++;
      if (t.context_tokens) { s.tokens += t.context_tokens; s.withTokens++; }
      if (t.cost_usd !== null) { s.cost += t.cost_usd; s.costed++; }
      s.read += (t.input_tokens ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0); s.cached += t.cache_read ?? 0; s.output += t.output_tokens ?? 0;
    }
  }
  const sortSlices = (m: Map<string, UsageSlice>) => [...m.values()].sort((a, b) => (b.chat + b.runs + b.turns) - (a.chat + a.runs + a.turns));
  return {
    tz, days, month: from !== undefined, daily: [...byDay.values()], byAgent: sortSlices(byAgent), byModel: sortSlices(byModel),
    totals: { chat: msgs.length, runs: runs.length, failedRuns: runs.filter((r) => r.status === 'error').length, turns: turns.length,
      tokens: turns.reduce((s, t) => s + (t.context_tokens ?? 0), 0), withTokens: turns.filter((t) => t.context_tokens).length,
      cost: turns.reduce((s, t) => s + (t.cost_usd ?? 0), 0), costed: turns.filter((t) => t.cost_usd !== null).length,
      read: turns.reduce((s, t) => s + (t.input_tokens ?? 0) + (t.cache_read ?? 0) + (t.cache_write ?? 0), 0), cached: turns.reduce((s, t) => s + (t.cache_read ?? 0), 0) },
    loggingSince: firstTurnAt(),
  };
}
