import 'server-only';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { pendingApprovals, type Approval } from './approvals';
import { ensureRoutines, type RoutineRun } from './routines';
import { tenantCachePrefix } from '@/lib/platform/context';
import { recentLessons } from './lessons';
import { openConflicts } from './memory-tidy';
import { getAgent } from './store';
import { boardTasks } from './tasks';

// The notifications Inbox: one list per login, built when the page opens from what already exists: the agents' approve cards waiting
// on you, lessons and notebook conflicts to check, agent tasks that are blocked or have no agent, and the routines' runs of the last 7 days. An item leaves "Needs you" once it is
// decided where it lives. Read and done are kept per login here.
export type InboxKind = 'approval' | 'lesson' | 'conflict' | 'routine' | 'task';
export interface InboxItem {
  key: string; kind: InboxKind; needsYou: boolean; title: string; sub: string; at: string; read: boolean;
  approval?: Omit<Approval, 'args'> & { args: Record<string, unknown> };
  run?: RoutineRun & { routine: string; failed: boolean };
  lesson?: { id: number; agent: string; content: string; threadId: number | null };
  conflict?: { id: number; agent: string; a: string; b: string; why: string };
  task?: { id: number; status: string; priority: string; agent: string | null; description: string; result: string; threadId: number | null };
}

const ready = schemaOnce(); // per agency database
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_state (user_id INTEGER NOT NULL, item_key TEXT NOT NULL, read_at TEXT, done_at TEXT,
    PRIMARY KEY (user_id, item_key));`);
  ready.mark();
}
const iso = (ms: number) => new Date(ms).toISOString();
const sqlIso = (s: string) => (s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
const WEEK = 7 * 86_400_000;
/** A run summary without its markdown marks (**bold**, *italic*, `code`, # headings). */
const plain = (t: string) => t.replace(/[*_`#]+/g, '').replace(/\s+/g, ' ').trim();

/** Everything for this owner or admin, newest first: what needs them, then updates. Done items are left out. */
export async function inboxFor(uid: number, now = Date.now()): Promise<InboxItem[]> {
  ensure();
  const state = new Map((db.prepare('SELECT item_key, read_at, done_at FROM inbox_state WHERE user_id = ?').all(uid) as { item_key: string; read_at: string | null; done_at: string | null }[])
    .map((r) => [r.item_key, r]));
  const items: Omit<InboxItem, 'read'>[] = [];

  // the AI's approve cards: only the person the conversation belongs to can decide one (lib/ai/approvals.ts decide)
  for (const a of pendingApprovals(200).filter((x) => x.user_id === uid)) {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(a.args); } catch { /* shown without its details */ }
    items.push({ key: `approval:${a.id}`, kind: 'approval', needsYou: true, title: a.summary, sub: `${a.tool.replace(/^propose_/, '').replace(/_/g, ' ')} · waiting for you`, at: sqlIso(a.created_at), approval: { ...a, args } });
  }
  // lessons the agents wrote from corrections this week (lib/ai/lessons.ts): Keep (clears it) or Drop (the agent stops following it)
  for (const l of recentLessons(7).filter((x) => !x.stale)) {
    const name = getAgent(l.agent_id)?.name ?? 'An agent';
    items.push({ key: `lesson:${l.id}`, kind: 'lesson', needsYou: true, title: `${name} learned a lesson`, sub: l.content, at: sqlIso(l.created_at), lesson: { id: l.id, agent: name, content: l.content, threadId: l.thread_id } });
  }
  // two notes in an agent's notebook that disagree (the nightly cleanup, memory-tidy.ts): a person picks
  for (const c of openConflicts()) {
    const name = getAgent(c.agent_id)?.name ?? 'An agent';
    items.push({ key: `conflict:${c.id}`, kind: 'conflict', needsYou: true, title: `${name} has two notes that disagree`, sub: c.why || c.a_text, at: sqlIso(c.at), conflict: { id: c.id, agent: name, a: c.a_text, b: c.b_text, why: c.why } });
  }
  // agent tasks (Agents › Tasks): blocked or unassigned ones need a person; the ones this login gave an agent show while they run and
  // for a week after they finish. The key carries the status, so each change shows again.
  for (const t of boardTasks()) {
    const mine = t.created_by === uid, team = t.created_by === null; // made by an agent or a routine: everyone's
    const stuck = t.status === 'blocked' || (t.status === 'pending' && t.agent_id === null);
    const recent = t.status !== 'completed' || now - Date.parse(sqlIso(t.completed_at ?? t.updated_at)) < WEEK;
    if (!(mine || team) || !recent) continue;
    if (!stuck && !mine) continue;
    const who = t.agent ?? 'No agent';
    const sub = t.status === 'blocked' ? `${who} is blocked${t.result ? `: ${plain(t.result)}` : ''}` : stuck ? 'No agent on it yet'
      : t.status === 'completed' ? `${who} finished${t.result ? `: ${plain(t.result)}` : ''}` : `${who} · ${t.status === 'in_progress' ? 'working on it' : 'queued'}`;
    items.push({ key: `task:${t.id}:${t.status}`, kind: 'task', needsYou: stuck, title: t.title, sub, at: sqlIso(t.updated_at),
      task: { id: t.id, status: t.status, priority: t.priority, agent: t.agent, description: t.description, result: t.result, threadId: t.run_thread } });
  }
  // routine runs of the last week, scheduled ones only (manual runs and tests were watched by whoever started them): the team's
  // routines and their own private ones
  ensureRoutines();
  const runs = db.prepare(`SELECT r.*, t.name routine FROM ai_routine_runs r JOIN ai_routines t ON t.id = r.routine_id
    WHERE r.started_at >= ? AND r.status IN ('ok', 'error') AND r.how = 'schedule' AND (t.shared = 1 OR t.created_by = ?) ORDER BY r.id DESC LIMIT 400`).all(now - WEEK, uid) as (RoutineRun & { routine: string })[];
  // the newest run of each routine only (a routine that fires every few minutes, or one being tested, would bury everything else)
  const seen = new Set<number>();
  for (const r of runs) {
    const failed = r.status === 'error';
    if (seen.has(r.routine_id)) continue;
    seen.add(r.routine_id);
    const summary = plain(r.summary);
    items.push({ key: `run:${r.id}`, kind: 'routine', needsYou: false, title: `${r.routine}${failed ? ' failed' : ''}`, sub: summary || (failed ? 'No reason given' : 'Finished'), at: iso(r.finished_at ?? r.started_at), run: { ...r, summary, failed } });
  }

  return items.filter((x) => !state.get(x.key)?.done_at)
    .map((x) => ({ ...x, read: !!state.get(x.key)?.read_at }))
    .sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || b.at.localeCompare(a.at));
}

/** How many items need this login and are unread (the sidebar count), kept a minute per login. */
const countCache = new Map<string, { at: number; n: number }>();
export async function inboxCount(uid: number, now = Date.now()): Promise<number> {
  const k = `${tenantCachePrefix()}${uid}`, hit = countCache.get(k);
  if (hit && now - hit.at < 60_000) return hit.n;
  const n = (await inboxFor(uid, now)).filter((x) => x.needsYou && !x.read).length;
  countCache.set(k, { at: now, n });
  return n;
}

export function markRead(uid: number, key: string) {
  ensure();
  db.prepare(`INSERT INTO inbox_state (user_id, item_key, read_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(user_id, item_key) DO UPDATE SET read_at = COALESCE(read_at, excluded.read_at)`).run(uid, key);
}
/** Clear an update from the list (things that need you leave when they are decided, not here). */
export function markDone(uid: number, key: string) {
  ensure();
  db.prepare(`INSERT INTO inbox_state (user_id, item_key, read_at, done_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(user_id, item_key) DO UPDATE SET done_at = excluded.done_at`).run(uid, key);
}
