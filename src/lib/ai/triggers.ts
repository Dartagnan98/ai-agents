import 'server-only';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { ensureRoutines } from './routines';
import { ROUTINE_EVENTS } from './cron';

// Event triggers for routines (D 2026-10-28): a routine with no schedule and "Only run if" = when:<event> runs within a
// minute of the event, with what happened in its prompt (ai_routines.pending_event, read and cleared by routine-run.ts takeEvent). Each event
// is a cursor over a table; a new cursor starts at the newest row (no backlog). Slack-channel routines keep their own path (routines.ts).
const MAX_ITEMS = 30;
type Poll = (cursor: string | null) => { cursor: string; items: string[] };

const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  ensureRoutines();
  db.exec('CREATE TABLE IF NOT EXISTS ai_trigger_state (event TEXT PRIMARY KEY, cursor TEXT NOT NULL)');
  if (!(db.prepare('PRAGMA table_info(ai_routines)').all() as { name: string }[]).some((c) => c.name === 'pending_event')) db.exec("ALTER TABLE ai_routines ADD COLUMN pending_event TEXT NOT NULL DEFAULT ''");
  ready.mark();
}

const EVENTS: Record<string, Poll> = {
  // once per task becoming blocked: the cursor is the set of blocked ids already handed on (a note moves updated_at, so ids, not times)
  task_blocked: (cursor) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_tasks'").get()) return { cursor: '[]', items: [] };
    const now = db.prepare(`SELECT t.id, t.title, t.result, a.name agent FROM ai_tasks t LEFT JOIN ai_agents a ON a.id = t.agent_id WHERE t.status = 'blocked' ORDER BY t.id`).all() as { id: number; title: string; result: string; agent: string | null }[];
    const seen = new Set<number>(cursor && cursor.startsWith('[') ? JSON.parse(cursor) as number[] : now.map((r) => r.id));
    const fresh = cursor && cursor.startsWith('[') ? now.filter((r) => !seen.has(r.id)).slice(0, MAX_ITEMS) : [];
    return { cursor: JSON.stringify(now.map((r) => r.id)), items: fresh.map((r) => `Task #${r.id} "${r.title}" (${r.agent ?? 'no agent'}) is blocked: ${r.result.slice(0, 300)}`) };
  },
  routine_failed: (cursor) => {
    const max = (db.prepare("SELECT MAX(id) m FROM ai_routine_runs WHERE status = 'error'").get() as { m: number | null }).m ?? 0;
    if (cursor === null) return { cursor: String(max), items: [] };
    const rows = db.prepare(`SELECT r.id, r.summary, x.name FROM ai_routine_runs r LEFT JOIN ai_routines x ON x.id = r.routine_id WHERE r.status = 'error' AND r.id > ? ORDER BY r.id LIMIT ${MAX_ITEMS}`).all(Number(cursor)) as { id: number; summary: string; name: string | null }[];
    return { cursor: String(rows.length ? rows[rows.length - 1].id : cursor), items: rows.map((r) => `Routine "${r.name ?? '?'}" failed: ${r.summary}`) };
  },
};
/** The event a condition waits on ('' when it is not a when:<event> condition, or an unknown one). */
export const triggerOf = (condition: string) => { const k = condition.trim().match(/^when:([a-z_]+)$/)?.[1] ?? ''; return (ROUTINE_EVENTS as readonly string[]).includes(k) && k in EVENTS ? k : ''; };

/** From the routine clock, at most once a minute: poll each event some enabled routine waits on, hand the new items to those routines and
 *  bring them forward. Never throws. */
let last = 0;
export function triggersTick(now = Date.now()): void {
  if (now - last < 60_000) return;
  last = now;
  try {
    ensure();
    const waiting = db.prepare("SELECT id, condition, pending_event FROM ai_routines WHERE enabled = 1 AND trim(schedule) = '' AND condition LIKE 'when:%'").all() as { id: number; condition: string; pending_event: string }[];
    for (const key of [...new Set(waiting.map((r) => triggerOf(r.condition)))].filter(Boolean)) {
      const cur = (db.prepare('SELECT cursor FROM ai_trigger_state WHERE event = ?').get(key) as { cursor: string } | undefined)?.cursor ?? null;
      const { cursor, items } = EVENTS[key](cur);
      db.prepare('INSERT INTO ai_trigger_state (event, cursor) VALUES (?, ?) ON CONFLICT(event) DO UPDATE SET cursor = excluded.cursor').run(key, cursor);
      if (!items.length) continue;
      for (const r of waiting.filter((w) => triggerOf(w.condition) === key)) {
        const pending = [...(r.pending_event ? r.pending_event.split('\n') : []), ...items].slice(-MAX_ITEMS).join('\n');
        db.prepare('UPDATE ai_routines SET pending_event = ?, next_run_at = ? WHERE id = ?').run(pending, now + 5_000, r.id);
      }
    }
  } catch (e) { console.warn(`[triggers] ${e instanceof Error ? e.message : String(e)}`); }
}

/** For routine-run.ts: what happened since the routine last ran (and clears it). */
export function takeEvent(routineId: number): string {
  try {
    ensure();
    const p = (db.prepare('SELECT pending_event FROM ai_routines WHERE id = ?').get(routineId) as { pending_event: string } | undefined)?.pending_event ?? '';
    if (p) db.prepare("UPDATE ai_routines SET pending_event = '' WHERE id = ?").run(routineId);
    return p;
  } catch { return ''; }
}
