import 'server-only';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { defaultAgent, getAgent, listAgents } from './store';
import { acquireLease, releaseLease } from './routines';
import { isNight } from './shift';
import { reportTz } from '@/lib/report-tz';
import { todayIn } from '@/lib/sales-range';

// Tasks for the AI agents (D 2026-10-28; the hub's from 2026-10-24). A person or an agent puts a task
// on the board, assigned to an agent; the routine clock (30 s, the lease holder) starts the agent on it, at most MAX_RUNNING at once, in its
// own conversation, and the card moves Pending -> In progress -> Completed (the agent's answer is the result) or Blocked (the error or
// what the agent says it needs). A task with no agent goes to the main agent, who does it or hands it on (D, 2026-10-25: "main agent
// does tasks"). At night each agent with its Night shift switch on (only the agents, D 2026-10-28) gets one Night shift card. AI › Tasks shows the board.
export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed';
export type TaskPriority = 'critical' | 'urgent' | 'high' | 'normal' | 'low';
export const TASK_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'blocked', 'completed'];
export const TASK_PRIORITIES: TaskPriority[] = ['critical', 'urgent', 'high', 'normal', 'low'];
const MAX_RUNNING = 2, RUN_LIMIT_MS = 15 * 60_000;

export interface AiTask {
  id: number; title: string; description: string; status: TaskStatus; priority: TaskPriority; agent_id: number | null; created_by: number | null;
  created_by_agent: number | null; result: string; run_thread: number | null; created_at: string; updated_at: string; completed_at: string | null;
}

const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
    priority TEXT NOT NULL DEFAULT 'normal', agent_id INTEGER, created_by INTEGER, created_by_agent INTEGER, result TEXT NOT NULL DEFAULT '',
    run_thread INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), completed_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_ai_tasks_status ON ai_tasks (status, agent_id);`);
  ready.mark();
}

export function listTasks(limit = 300): AiTask[] {
  ensure();
  return db.prepare(`SELECT * FROM ai_tasks ORDER BY status = 'completed', CASE priority WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, id DESC LIMIT ?`).all(limit) as AiTask[];
}
export function getTask(id: number): AiTask | undefined { ensure(); return db.prepare('SELECT * FROM ai_tasks WHERE id = ?').get(id) as AiTask | undefined; }

/** A new task. Returns it, or an error in plain words. */
export function createTask(t: { title: string; description?: string; agentId?: number | null; priority?: string; createdBy: number | null; createdByAgent?: number | null }): AiTask | string {
  ensure();
  const title = t.title.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
  if (title.length < 3) return 'Give the task a title.';
  if (t.agentId && !getAgent(t.agentId)) return 'No such agent.';
  const priority = TASK_PRIORITIES.includes(t.priority as TaskPriority) ? t.priority : 'normal';
  const id = Number(db.prepare('INSERT INTO ai_tasks (title, description, agent_id, priority, created_by, created_by_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, String(t.description ?? '').slice(0, 8000), t.agentId ?? null, priority, t.createdBy, t.createdByAgent ?? null).lastInsertRowid);
  return getTask(id)!;
}

/** Changes a task (title, description, agent, priority, status; a note is added to the result). Moving it back to Pending runs it again. */
export function updateTask(id: number, f: { title?: string; description?: string; agentId?: number | null; priority?: string; status?: string; note?: string }): AiTask | string {
  ensure();
  const cur = getTask(id);
  if (!cur) return 'No such task.';
  if (f.status && !TASK_STATUSES.includes(f.status as TaskStatus)) return 'Unknown status.';
  if (f.status === 'in_progress' && cur.status !== 'in_progress') return 'An agent moves a task to In progress when it starts it; put it in Pending to run it.';
  if (f.agentId && !getAgent(f.agentId)) return 'No such agent.';
  const next = {
    title: f.title?.trim() ? f.title.trim().slice(0, 200) : cur.title,
    description: f.description !== undefined ? f.description.slice(0, 8000) : cur.description,
    agent_id: f.agentId !== undefined ? f.agentId : cur.agent_id,
    priority: TASK_PRIORITIES.includes(f.priority as TaskPriority) ? f.priority! : cur.priority,
    status: (f.status as TaskStatus) ?? cur.status,
    result: f.note?.trim() ? `${cur.result ? `${cur.result}\n\n` : ''}${f.note.trim().slice(0, 4000)}` : cur.result,
  };
  db.prepare(`UPDATE ai_tasks SET title = ?, description = ?, agent_id = ?, priority = ?, status = ?, result = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
    completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')) ELSE NULL END WHERE id = ?`)
    .run(next.title, next.description, next.agent_id, next.priority, next.status, next.result, next.status, id);
  return getTask(id)!;
}
export function deleteTask(id: number): boolean { ensure(); return db.prepare('DELETE FROM ai_tasks WHERE id = ?').run(id).changes > 0; }

const running = new Set<number>();
/** From the routine clock: start pending tasks that have an agent, at most MAX_RUNNING at once (this copy holds the lease). Never throws. */
export async function runDueTasks(holder: string): Promise<void> {
  ensure();
  // a task left In progress by an app restart goes back to Pending (its run died with the process)
  if (!running.size) db.prepare(`UPDATE ai_tasks SET status = 'pending' WHERE status = 'in_progress' AND updated_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-20 minutes')`).run();
  const free = MAX_RUNNING - running.size;
  if (free <= 0 || !acquireLease('ai-tasks', holder, RUN_LIMIT_MS + 60_000)) return;
  try {
    const main = defaultAgent();
    if (main) db.prepare(`UPDATE ai_tasks SET agent_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE status = 'pending' AND agent_id IS NULL`).run(main.id);
    if (isNight()) queueNightShifts();
    const due = db.prepare(`SELECT * FROM ai_tasks WHERE status = 'pending' AND agent_id IS NOT NULL ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END, id LIMIT ?`).all(free) as AiTask[];
    for (const t of due) if (!running.has(t.id)) void runTask(t);
  } finally { releaseLease('ai-tasks', holder); }
}

/** One Night shift card per night-shift agent per night (title = the date, so a restart never doubles it); low priority, so real tasks go first. */
function queueNightShifts(): void {
  const title = `Night shift ${todayIn(reportTz())}`;
  const has = db.prepare('SELECT 1 FROM ai_tasks WHERE agent_id = ? AND title = ?');
  for (const a of listAgents().filter((x) => x.night_shift)) if (!has.get(a.id, title)) createTask({ title, agentId: a.id, priority: 'low', createdBy: null, description: [
    'Your night shift. 1) list_tasks: finish or move forward your open tasks. 2) Look over the contracts for work nobody asked for yet',
    '(numbers that moved, gaps in the data, follow-ups, stopped feeds) and put each on the board with create_task, for you or the right teammate.',
    '3) Your goals are in your prompt: move at least one forward and update its progress with set_goal. With no goals yet, set 2 or 3 measurable ones (metric, target, due).',
    '4) Send finished pieces to teammates with message_agent or hand_off. No messages to people and no money changes unless critical.',
    'Your answer: a short report of what you did and what waits for a person.',
  ].join(' ') });
}

async function runTask(t: AiTask): Promise<void> {
  const agent = getAgent(t.agent_id);
  if (!agent) { updateTask(t.id, { status: 'blocked', note: 'Its agent is gone. Assign another agent.' }); return; }
  running.add(t.id);
  db.prepare(`UPDATE ai_tasks SET status = 'in_progress', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(t.id);
  try {
    const { runAgentTurn } = await import('./comms'); // comms imports store and tools; loaded only when a task runs
    const owner = t.created_by ?? (db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id ?? 1;
    const from = t.created_by_agent ? `${getAgent(t.created_by_agent)?.name ?? 'Another agent'} (through the task board)` : 'The task board';
    const prompt = [
      `Task #${t.id}: ${t.title}`, t.description ? `\n${t.description}` : '', t.result ? `\n\nEarlier notes on this task:\n${t.result}` : '',
      '\n\nDo the task with your tools. Your final answer is the result shown on the card. If you cannot finish it, start your answer with BLOCKED: and say exactly what you need.',
    ].join('');
    const r = await runAgentTurn({ agent, userId: owner, prompt, title: `Task #${t.id}: ${t.title}`, kind: 'handoff', from, ctx: { depth: 0, chain: [agent.id], ownerStarted: !t.created_by_agent }, timeoutMs: RUN_LIMIT_MS });
    const text = r.text.trim();
    const blocked = !!r.error || /^BLOCKED:/i.test(text);
    db.prepare(`UPDATE ai_tasks SET status = ?, result = ?, run_thread = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      completed_at = CASE WHEN ? = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE NULL END WHERE id = ?`)
      .run(blocked ? 'blocked' : 'completed', (r.error ? `Stopped: ${r.error}${text ? `\n\n${text}` : ''}` : text.replace(/^BLOCKED:\s*/i, '')).slice(0, 12000), r.threadId || null, blocked ? 'blocked' : 'completed', t.id);
  } catch (e) {
    updateTask(t.id, { status: 'blocked', note: `Stopped: ${e instanceof Error ? e.message : String(e)}` });
  } finally { running.delete(t.id); }
}

/** Board rows with the agent's name (the API and the agents' list_tasks). */
export function boardTasks(): (AiTask & { agent: string | null; by_agent: string | null })[] {
  const names = new Map(listAgents().map((a) => [a.id, a.name]));
  return listTasks().map((t) => ({ ...t, agent: t.agent_id ? names.get(t.agent_id) ?? null : null, by_agent: t.created_by_agent ? names.get(t.created_by_agent) ?? null : null }));
}
