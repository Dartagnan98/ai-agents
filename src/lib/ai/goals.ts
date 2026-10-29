import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';

// Goals per agent (D 2026-10-28; first CTRL Flow, 2026-10-25: "measurable targets with a change history"): what each agent works toward,
// with a metric, a target, a due date and its latest progress. Active goals are in every prompt of that agent (store.ts notebookPrompt);
// agents add and update them with set_goal (their own, or a teammate's when they lead it). The Strategy page goals
// (read_goals) stays the north star above them.
export interface Goal { id: number; agent_id: number; goal: string; metric: string; target: string; due: string; status: 'active' | 'done' | 'dropped'; progress: string; created_at: string; updated_at: string }

const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_agent_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, goal TEXT NOT NULL, metric TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '',
    due TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', progress TEXT NOT NULL DEFAULT '', history TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_ai_agent_goals ON ai_agent_goals (agent_id, status)`);
  ready.mark();
}
const STATUSES = ['active', 'done', 'dropped'];
const clip = (v: unknown, n: number) => String(v ?? '').replace(/—/g, ', ').trim().slice(0, n);

export function listGoals(agentId?: number, all = false): Goal[] {
  ensure();
  const where = [agentId ? 'agent_id = ?' : '1', all ? '1' : "status = 'active'"].join(' AND ');
  return db.prepare(`SELECT id, agent_id, goal, metric, target, due, status, progress, created_at, updated_at FROM ai_agent_goals WHERE ${where} ORDER BY status = 'active' DESC, due = '', due, id`)
    .all(...(agentId ? [agentId] : [])) as Goal[];
}

/** Add a goal (no id) or change one; every change is kept in its history. Returns the goal or an error in plain words. */
export function setGoal(g: { id?: number; agentId?: number; goal?: string; metric?: string; target?: string; due?: string; status?: string; progress?: string; by: string }): Goal | string {
  ensure();
  if (g.status && !STATUSES.includes(g.status)) return `Status is one of ${STATUSES.join(', ')}.`;
  if (g.due && !/^\d{4}-\d{2}-\d{2}$/.test(g.due)) return 'Due is a date: YYYY-MM-DD.';
  if (!g.id) {
    if (!g.agentId) return 'Say which agent the goal is for.';
    if (clip(g.goal, 300).length < 4) return 'Say the goal.';
    const id = Number(db.prepare('INSERT INTO ai_agent_goals (agent_id, goal, metric, target, due, progress, history) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(g.agentId, clip(g.goal, 300), clip(g.metric, 200), clip(g.target, 120), g.due ?? '', clip(g.progress, 600), JSON.stringify([{ at: new Date().toISOString(), by: g.by, set: 'added' }])).lastInsertRowid);
    return listGoals(undefined, true).find((x) => x.id === id)!;
  }
  const cur = db.prepare('SELECT * FROM ai_agent_goals WHERE id = ?').get(g.id) as (Goal & { history: string }) | undefined;
  if (!cur) return `No goal #${g.id}.`;
  const next = { goal: g.goal !== undefined ? clip(g.goal, 300) : cur.goal, metric: g.metric !== undefined ? clip(g.metric, 200) : cur.metric, target: g.target !== undefined ? clip(g.target, 120) : cur.target,
    due: g.due ?? cur.due, status: g.status ?? cur.status, progress: g.progress !== undefined ? clip(g.progress, 600) : cur.progress };
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => (cur as unknown as Record<string, string>)[k] !== v));
  if (!Object.keys(changed).length) return { ...cur };
  const history = [...(JSON.parse(cur.history || '[]') as unknown[]), { at: new Date().toISOString(), by: g.by, set: changed }].slice(-50);
  db.prepare("UPDATE ai_agent_goals SET goal = ?, metric = ?, target = ?, due = ?, status = ?, progress = ?, history = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
    .run(next.goal, next.metric, next.target, next.due, next.status, next.progress, JSON.stringify(history), g.id);
  return listGoals(undefined, true).find((x) => x.id === g.id)!;
}

/** The active goals block for an agent's prompt ('' when it has none). */
export function goalsPrompt(agentId: number, name: string): string {
  const gs = listGoals(agentId).slice(0, 12);
  if (!gs.length) return '';
  return `=== Your goals (${name}: work toward these; update progress with set_goal when it moves, mark one done or dropped when it is) ===\n${gs.map((x) => `- #${x.id} ${x.goal}${x.metric ? ` | metric: ${x.metric}` : ''}${x.target ? ` | target: ${x.target}` : ''}${x.due ? ` | due ${x.due}` : ''}${x.progress ? ` | now: ${x.progress}` : ''}`).join('\n')}`;
}
