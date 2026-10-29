// Routines storage (D, 2026-10-09: "Where are routines". ai_agent_routines on Fleet's SQLite): an agent, a prompt, a
// schedule (5-field cron, in the agency's reporting zone) and where the result goes. They replace the cortextOS daemon's jobs so the daemon can be
// switched off later. Runs are logged in ai_routine_runs. The scheduler (routine-scheduler.ts) fires them; routine-run.ts runs one.
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { reportTz } from '@/lib/report-tz';
import { tzName } from '@/lib/tz';
import { cronProblem, reactiveProblem, nextRun } from './cron';
import { canUseAgent, getAgent, listAgents } from './store';

export interface Deliver {
  /** Always true: every run is a conversation in the AI list. */
  conversation: true;
  /** "org/agent": that cortextOS agent's Telegram bot and chat (Settings › Telegram). */
  telegram?: string | null;
  /** Slack channel id or name, through the Composio Slack connection. */
  slack?: string | null;
}
export interface Routine {
  id: number; name: string; agent_id: number | null; prompt: string; schedule: string; enabled: boolean; deliver: Deliver; condition: string;
  created_by: number; created_at: string; updated_at: string; last_run_at: number | null; next_run_at: number | null; last_status: string | null;
  last_thread_id: number | null; running_since: number | null;
  /** Team (everyone with AI access sees it, only the owner or its maker changes it) or private to its maker (D, 2026-10-12). */
  shared: boolean;
  /** A script routine (D, 2026-10-28, docs/AGENT_WORKSPACE.md): this command runs in the agency's workspace on the schedule, no AI turn,
   *  and its output is the run's log. Empty = an agent routine. */
  script: string;
  /** Runs before the routine (agent or script) in the workspace: exit 0 = run, anything else = skipped. */
  condition_script: string;
  /** A folder of the Routines list (D, 2026-10-28: "categories and folders we can make"); '' = none. Display only, never changes a run. */
  folder: string;
}
export interface RoutineRun { id: number; routine_id: number; started_at: number; finished_at: number | null; status: 'running' | 'ok' | 'skipped' | 'error'; thread_id: number | null; summary: string; how: string; output: string }
/** script / condition_script undefined = keep what the routine has (the editor does not send them yet). */
export type RoutineInput = Pick<Routine, 'name' | 'agent_id' | 'prompt' | 'schedule' | 'enabled' | 'deliver' | 'condition'> & { shared?: boolean; script?: string; condition_script?: string; folder?: string };

/** A run that has said nothing for this long is treated as dead (an app restart mid-run). */
export const STALE_RUN_MS = 70 * 60_000; // past the 1-hour script limit, so a long script is never claimed twice
/** At most this many routine runs at once, across every app copy (D, 2026-10-09). */
export const MAX_PARALLEL = 2;

const ready = schemaOnce(); // per agency database: a module flag skipped the tables in every agency after the first (2026-10-10)
// the starter routines need an owner to belong to: a fresh install touches this table before /setup makes one, so it tries again
let seeded = false;
export function ensureRoutines() {
  if (ready.done()) { if (!seeded) seedRoutines(); return; }
  db.exec(`CREATE TABLE IF NOT EXISTS ai_routines (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, agent_id INTEGER, prompt TEXT NOT NULL DEFAULT '', schedule TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0, deliver TEXT NOT NULL DEFAULT '{"conversation":true}', condition TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_run_at INTEGER, next_run_at INTEGER, last_status TEXT, last_thread_id INTEGER, running_since INTEGER, seed_key TEXT);
    CREATE TABLE IF NOT EXISTS ai_routine_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, routine_id INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL DEFAULT 'running',
      thread_id INTEGER, summary TEXT NOT NULL DEFAULT '', how TEXT NOT NULL DEFAULT 'schedule');
    CREATE INDEX IF NOT EXISTS idx_ai_routine_runs ON ai_routine_runs (routine_id, id);
    CREATE TABLE IF NOT EXISTS ai_leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, until INTEGER NOT NULL);`);
  // team or private (D, 2026-10-12): every routine made before this is a team one
  const rcols = (db.prepare('PRAGMA table_info(ai_routines)').all() as { name: string }[]).map((c) => c.name);
  if (!rcols.includes('shared')) db.exec('ALTER TABLE ai_routines ADD COLUMN shared INTEGER NOT NULL DEFAULT 1');
  if (!rcols.includes('script')) db.exec("ALTER TABLE ai_routines ADD COLUMN script TEXT NOT NULL DEFAULT ''");
  if (!rcols.includes('condition_script')) db.exec("ALTER TABLE ai_routines ADD COLUMN condition_script TEXT NOT NULL DEFAULT ''");
  if (!rcols.includes('folder')) db.exec("ALTER TABLE ai_routines ADD COLUMN folder TEXT NOT NULL DEFAULT ''");
  if (!(db.prepare('PRAGMA table_info(ai_routine_runs)').all() as { name: string }[]).some((c) => c.name === 'output')) db.exec("ALTER TABLE ai_routine_runs ADD COLUMN output TEXT NOT NULL DEFAULT ''");
  ready.mark();
  seedRoutines();
}

type Row = Omit<Routine, 'enabled' | 'deliver' | 'shared'> & { enabled: number; deliver: string; shared: number };
export function parseDeliver(raw: unknown): Deliver {
  let v: Record<string, unknown> = {};
  try { v = typeof raw === 'string' ? JSON.parse(raw) : (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}); } catch { v = {}; }
  const s = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 120) : null);
  return { conversation: true, telegram: s(v.telegram), slack: s(v.slack)?.replace(/^#/, '') ?? null };
}
const toRoutine = (r: Row): Routine => ({ ...r, enabled: !!r.enabled, deliver: parseDeliver(r.deliver), shared: r.shared !== 0 });
/** Who sees a routine and who changes it: team ones everyone with AI access sees, the owner or their maker changes; private ones only their maker. */
export const canSeeRoutine = (r: Routine, uid: number) => r.shared || r.created_by === uid;
export const canEditRoutine = (r: Routine, uid: number, role: string) => r.created_by === uid || (r.shared && role === 'owner');

/** A routine from the editor or the AI's save_routine (D, 2026-10-23: the AI makes routines too), checked the same way; a string = why not. */
export function routineInput(b: Record<string, unknown>, uid: number, role: string): RoutineInput | string {
  const s = (k: string, max: number) => String(b[k] ?? '').trim().slice(0, max);
  const name = s('name', 120);
  if (!name) return 'Name the routine.';
  const script = b.script === undefined ? undefined : s('script', 2000), conditionScript = b.condition_script === undefined ? undefined : s('condition_script', 2000);
  const prompt = s('prompt', 8000);
  if (!prompt && !script) return 'Write what the agent should do each time (or give a script to run).';
  const schedule = s('schedule', 100).replace(/\s+/g, ' ');
  const condition = s('condition', 1000);
  // no schedule = reactive: it runs only when a new post lands in the channel its check names (runSoonForChannel)
  const problem = schedule ? cronProblem(schedule, script ? 5 : 15) : reactiveProblem(condition);
  if (problem) return problem;
  const agentId = Number(b.agent_id) || null;
  const agent = agentId ? getAgent(agentId) : undefined;
  if (agentId && (!agent || !canUseAgent(agent, uid))) return 'Pick one of your agents.';
  // team routines: only the owner makes them (like team agents); an admin's are private
  const shared = b.shared === undefined ? undefined : b.shared === true && role === 'owner';
  const folder = b.folder === undefined ? undefined : folderName(b.folder);
  return { name, prompt, schedule, agent_id: agentId, enabled: b.enabled === true, deliver: parseDeliver(b.deliver), condition, shared, script, condition_script: conditionScript, folder };
}

/** A folder name as typed: one line, no slashes (folders do not nest), 60 characters. */
export const folderName = (v: unknown) => String(v ?? '').replace(/[\r\n/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
/** Move a routine into a folder ('' = out of every folder). */
export function setRoutineFolder(id: number, folder: string): Routine | undefined {
  ensureRoutines();
  db.prepare("UPDATE ai_routines SET folder = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(folderName(folder), id);
  return getRoutine(id);
}

/** Every routine, or the ones this login sees (team ones and its own). */
export function listRoutines(uid?: number): Routine[] {
  ensureRoutines();
  const all = (db.prepare('SELECT * FROM ai_routines ORDER BY shared DESC, name COLLATE NOCASE, id').all() as Row[]).map(toRoutine);
  return uid === undefined ? all : all.filter((r) => canSeeRoutine(r, uid));
}
export function getRoutine(id: number): Routine | undefined {
  ensureRoutines();
  const r = db.prepare('SELECT * FROM ai_routines WHERE id = ?').get(id) as Row | undefined;
  return r ? toRoutine(r) : undefined;
}
// in the agency's zone (HARDCODE_AUDIT B3): its "6 am" is 6 am where it reports, not Eastern
const nextFor = (enabled: boolean, schedule: string, from = Date.now()) => { if (!enabled) return null; try { return nextRun(schedule, from, reportTz()); } catch { return null; } };

export function createRoutine(a: RoutineInput, by: number, seedKey: string | null = null): Routine {
  ensureRoutines();
  const r = db.prepare(`INSERT INTO ai_routines (name, agent_id, prompt, schedule, enabled, deliver, condition, created_by, next_run_at, seed_key, shared, script, condition_script, folder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.name, a.agent_id, a.prompt, a.schedule, a.enabled ? 1 : 0, JSON.stringify(parseDeliver(a.deliver)), a.condition, by,
    nextFor(a.enabled, a.schedule), seedKey, a.shared === false ? 0 : 1, a.script ?? '', a.condition_script ?? '', a.folder ?? '');
  return getRoutine(Number(r.lastInsertRowid))!;
}
export function updateRoutine(id: number, a: RoutineInput): Routine | undefined {
  ensureRoutines();
  db.prepare(`UPDATE ai_routines SET name = ?, agent_id = ?, prompt = ?, schedule = ?, enabled = ?, deliver = ?, condition = ?, next_run_at = ?,
    shared = COALESCE(?, shared), script = COALESCE(?, script), condition_script = COALESCE(?, condition_script), folder = COALESCE(?, folder), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
    .run(a.name, a.agent_id, a.prompt, a.schedule, a.enabled ? 1 : 0, JSON.stringify(parseDeliver(a.deliver)), a.condition, nextFor(a.enabled, a.schedule),
      a.shared === undefined ? null : a.shared ? 1 : 0, a.script ?? null, a.condition_script ?? null, a.folder ?? null, id);
  return getRoutine(id);
}
export function setRoutineEnabled(id: number, enabled: boolean): Routine | undefined {
  const cur = getRoutine(id);
  if (!cur) return undefined;
  db.prepare(`UPDATE ai_routines SET enabled = ?, next_run_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(enabled ? 1 : 0, nextFor(enabled, cur.schedule), id);
  return getRoutine(id);
}
export function deleteRoutine(id: number): boolean {
  ensureRoutines();
  const ok = db.prepare('DELETE FROM ai_routines WHERE id = ?').run(id).changes > 0;
  if (ok) db.prepare('DELETE FROM ai_routine_runs WHERE routine_id = ?').run(id);
  return ok;
}
export function listRuns(routineId: number, limit = 20): RoutineRun[] {
  ensureRoutines();
  return db.prepare('SELECT * FROM ai_routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?').all(routineId, limit) as RoutineRun[];
}

// ─── the lease: one app copy fires routines (prod runs 3 pm2 copies on one SQLite file) ───
/** Takes or renews a named lease for `ttlMs`. True when this holder has it: it was free, expired, or already ours. */
export function acquireLease(name: string, holder: string, ttlMs: number, now = Date.now()): boolean {
  ensureRoutines();
  return db.prepare(`INSERT INTO ai_leases (name, holder, until) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, until = excluded.until WHERE ai_leases.until < ? OR ai_leases.holder = excluded.holder`)
    .run(name, holder, now + ttlMs, now).changes > 0;
}
export function releaseLease(name: string, holder: string) {
  ensureRoutines();
  db.prepare('DELETE FROM ai_leases WHERE name = ? AND holder = ?').run(name, holder);
}

// ─── claiming a run ───
/** Enabled routines whose time has come and that are not running now. */
export function dueRoutines(now = Date.now()): Routine[] {
  ensureRoutines();
  return (db.prepare(`SELECT * FROM ai_routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
    AND (running_since IS NULL OR running_since < ?) ORDER BY next_run_at`).all(now, now - STALE_RUN_MS) as Row[]).map(toRoutine);
}

/** Marks a routine as running and moves its next run on, in one step, so no other tick or copy starts it too. Refuses when it is
 *  still running, or when MAX_PARALLEL runs are already going. Returns the run id, or a reason. */
export function claimRun(id: number, how: 'schedule' | 'manual', now = Date.now()): { runId: number } | { refused: string } {
  ensureRoutines();
  return db.transaction(() => {
    const r = getRoutine(id);
    if (!r) return { refused: 'Routine not found.' };
    if (r.running_since && r.running_since >= now - STALE_RUN_MS) return { refused: 'It is still running from last time.' };
    const busy = (db.prepare('SELECT COUNT(*) AS n FROM ai_routines WHERE running_since IS NOT NULL AND running_since >= ?').get(now - STALE_RUN_MS) as { n: number }).n;
    if (busy >= MAX_PARALLEL) return { refused: `${MAX_PARALLEL} routines are already running. Try again in a moment.` };
    // a scheduled run moves the next time on from now (a missed window while the app was down fires once, not once per slot)
    const next = nextFor(r.enabled, r.schedule, now);
    db.prepare(`UPDATE ai_routines SET running_since = ?, last_run_at = ?, last_status = 'running', next_run_at = ? WHERE id = ?`).run(now, now, next, id);
    // a run left 'running' by a crash is closed off
    db.prepare(`UPDATE ai_routine_runs SET status = 'error', finished_at = ?, summary = 'Stopped: the app restarted during the run.' WHERE routine_id = ? AND status = 'running'`).run(now, id);
    const runId = Number(db.prepare('INSERT INTO ai_routine_runs (routine_id, started_at, how) VALUES (?, ?, ?)').run(id, now, how).lastInsertRowid);
    return { runId };
  })();
}

/** Brings routines with this condition forward to run within `inMs` (D, 2026-10-13: a deal post starts 'Live deals from Slack' now, not at
 *  the next 10-minute mark). The scheduler fires it as usual (lease, claim); an earlier time already set stays. */
export function runSoon(condition: string, inMs: number, now = Date.now()): number {
  ensureRoutines();
  const at = now + inMs;
  return db.prepare(`UPDATE ai_routines SET next_run_at = ? WHERE enabled = 1 AND trim(condition) = ? AND (next_run_at IS NULL OR next_run_at > ?)`).run(at, condition, at).changes;
}

/** A new post in this Slack channel brings forward every routine whose "only run if" names the channel (D, 2026-10-23: a notification when a
 *  post comes in, not up to 15 minutes later). Same rules as runSoon: the scheduler fires it, an earlier time already set stays. */
export function runSoonForChannel(channel: string, inMs: number, now = Date.now()): number {
  if (!/^[CG][A-Z0-9]{6,20}$/.test(channel)) return 0;
  ensureRoutines();
  const at = now + inMs;
  return db.prepare('UPDATE ai_routines SET next_run_at = ? WHERE enabled = 1 AND instr(condition, ?) > 0 AND (next_run_at IS NULL OR next_run_at > ?)').run(at, channel, at).changes;
}

/** Ends a run: logs it and frees the routine. */
export function finishRun(id: number, runId: number, out: { status: 'ok' | 'skipped' | 'error'; summary: string; threadId: number | null; output?: string }, now = Date.now()) {
  ensureRoutines();
  const summary = out.summary.replace(/\s+/g, ' ').trim().slice(0, 400);
  // a script's output (its log), the last 20,000 characters
  db.prepare('UPDATE ai_routine_runs SET status = ?, finished_at = ?, summary = ?, thread_id = ?, output = ? WHERE id = ?').run(out.status, now, summary, out.threadId, (out.output ?? '').slice(-20_000), runId);
  db.prepare(`UPDATE ai_routines SET running_since = NULL, last_status = ?, last_thread_id = COALESCE(?, last_thread_id) WHERE id = ?`)
    .run(out.status === 'error' ? `error: ${summary.slice(0, 200)}` : out.status, out.threadId, id);
}

/** "SKIP" answers (the "only run if" check said no): the first word of the reply is SKIP. Returns the reason, or null. */
export function skipReason(reply: string): string | null {
  const m = /^\s*(?:\*\*)?SKIP\b(?:\*\*)?[:.\s-]*([\s\S]*)$/i.exec(reply);
  return m ? (m[1].trim().split('\n')[0] || 'Condition not met.').slice(0, 300) : null;
}

/** The prompt a run sends: the "only run if" check first, then the work. */
export function routinePrompt(prompt: string, condition: string): string {
  const c = condition.trim();
  if (!c) return prompt;
  return `Only run if: ${c}\nCheck that first with your tools. If it is not true, reply with exactly "SKIP: " and one short reason, and do nothing else. If it is true, do the work below.\n\n${prompt}`;
}

// ─── seeded routines: starter routines every new install gets, ON (turn them off on Routines) ───
export const SEED_ROUTINES: (Omit<RoutineInput, 'agent_id' | 'enabled'> & { key: string; agent: string })[] = [
  {
    key: 'morning-brief', name: 'Morning brief', agent: 'Operations', schedule: '0 8 * * 1-5', condition: '', deliver: { conversation: true },
    prompt: [
      'Morning brief ({{ZONE}}). Check the Inbox (inbox tool), the task board (list_tasks) and the routines (list_routines).',
      'Lead with what needs a person today: approvals waiting, blocked tasks, routines that failed. Then what the agents finished since yesterday. Keep it short.',
    ].join('\n'),
  },
  {
    key: 'weekly-review', name: 'Weekly review', agent: 'Operations', schedule: '0 9 * * 1', condition: '', deliver: { conversation: true },
    prompt: [
      'Weekly review of last week ({{ZONE}}): tasks done and still open (list_tasks), each agent\'s goals and progress (list_goals), routines that failed.',
      'End with three priorities for this week.',
    ].join('\n'),
  },
];

/** The routines a new install starts with, filled with its time zone. Seeds already made are never re-made. */
export function seedRoutinesFor(): typeof SEED_ROUTINES {
  const zone = tzName(reportTz());
  return SEED_ROUTINES.map((s) => ({ ...s, prompt: s.prompt.replaceAll('{{ZONE}}', zone) }));
}

function seedRoutines() {
  const have = new Set((db.prepare('SELECT seed_key FROM ai_routines WHERE seed_key IS NOT NULL').all() as { seed_key: string }[]).map((r) => r.seed_key));
  const seeds = seedRoutinesFor();
  if (seeds.every((s) => have.has(s.key))) { seeded = true; return; }
  // the owner (first user) owns the seeded routines; their conversations land in the owner's AI list
  const owner = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  if (!owner) return;
  const agents = listAgents();
  seeded = true; // before creating: createRoutine runs ensureRoutines again
  for (const s of seeds) {
    if (have.has(s.key)) continue;
    const agent = agents.find((a) => a.name === s.agent)?.id ?? null;
    createRoutine({ name: s.name, agent_id: agent, prompt: s.prompt, schedule: s.schedule, enabled: true, deliver: s.deliver, condition: s.condition }, owner.id, s.key);
  }
}

/** A conversation a team routine's run wrote (its maker owns it; everyone with AI access may read it, D 2026-10-12). */
export function teamRoutineThreadOwner(threadId: number): number | null {
  ensureRoutines();
  const r = db.prepare('SELECT r.created_by FROM ai_routine_runs x JOIN ai_routines r ON r.id = x.routine_id WHERE x.thread_id = ? AND r.shared = 1 LIMIT 1').get(threadId) as { created_by: number } | undefined;
  return r?.created_by ?? null;
}
