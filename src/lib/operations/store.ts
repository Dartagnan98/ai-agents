import 'server-only';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';

// Operations per agency (D, 2026-10-10: "give every agency the Operations pages and Experiments"). Strategy (north star, bottleneck,
// daily focus, goals with progress and their history) and the experiments log live in the agency's own SQLite (`db` = the current
// agency's database), so agency B never reads agency A's rows. Same shape as the cortextOS goals.json page so it feels familiar; the
// legacy agency (the agency) keeps that page as a second view.

const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ops_strategy (
      id INTEGER PRIMARY KEY CHECK (id = 1), north_star TEXT NOT NULL DEFAULT '', bottleneck TEXT NOT NULL DEFAULT '',
      daily_focus TEXT NOT NULL DEFAULT '', daily_focus_set_at TEXT, updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE IF NOT EXISTS ops_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE IF NOT EXISTS ops_goal_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, change TEXT NOT NULL, user_id INTEGER,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE IF NOT EXISTS ops_experiments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, hypothesis TEXT NOT NULL DEFAULT '', metric TEXT NOT NULL DEFAULT '',
      business TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL DEFAULT '', started_on TEXT NOT NULL DEFAULT '', ended_on TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned', result TEXT NOT NULL DEFAULT '', decision TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'person',
      created_by INTEGER, updated_by INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_ops_experiments_status ON ops_experiments (status, id);`);
  ready.mark();
}
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const text = (v: unknown, max: number) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

// ─── strategy ───
export type StrategyField = 'north_star' | 'bottleneck' | 'daily_focus';
export const STRATEGY_FIELDS: StrategyField[] = ['north_star', 'bottleneck', 'daily_focus'];
export const isStrategyField = (v: unknown): v is StrategyField => STRATEGY_FIELDS.includes(v as StrategyField);
const FIELD_LABEL: Record<StrategyField, string> = { north_star: 'North star', bottleneck: 'Bottleneck', daily_focus: 'Daily focus' };
export const STRATEGY_MAX = 500;

export interface Strategy { north_star: string; bottleneck: string; daily_focus: string; daily_focus_set_at: string | null; updated_at: string | null }
export interface OpsGoal { id: number; title: string; progress: number; sort: number; updated_at: string }
export interface HistoryEntry { timestamp: string; change: string }

export function getStrategy(): Strategy {
  ensure();
  const r = db.prepare('SELECT north_star, bottleneck, daily_focus, daily_focus_set_at, updated_at FROM ops_strategy WHERE id = 1').get() as Strategy | undefined;
  return r ?? { north_star: '', bottleneck: '', daily_focus: '', daily_focus_set_at: null, updated_at: null };
}

function log(change: string, userId: number | null) {
  db.prepare('INSERT INTO ops_goal_history (change, user_id) VALUES (?, ?)').run(change.slice(0, 300), userId);
}

/** Sets one strategy line. Logs the change in the history (like the cortextOS bottleneck events). */
export function setStrategyField(field: StrategyField, value: string, userId: number | null): Strategy {
  ensure();
  const v = text(value, STRATEGY_MAX);
  const cur = getStrategy();
  if (cur[field] === v) return cur;
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO ops_strategy (id) VALUES (1)').run();
    db.prepare(`UPDATE ops_strategy SET ${field} = ?, ${field === 'daily_focus' ? `daily_focus_set_at = ${v ? NOW : 'NULL'},` : ''} updated_by = ?, updated_at = ${NOW} WHERE id = 1`).run(v, userId);
    log(v ? `${FIELD_LABEL[field]} set: ${oneLine(v, 200)}` : `${FIELD_LABEL[field]} cleared`, userId);
  })();
  return getStrategy();
}

export function listGoals(): OpsGoal[] {
  ensure();
  return db.prepare('SELECT id, title, progress, sort, updated_at FROM ops_goals ORDER BY sort, id').all() as OpsGoal[];
}

const clampProgress = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export function addGoal(title: string, userId: number | null): OpsGoal | string {
  ensure();
  const t = oneLine(title, 200);
  if (!t) return 'Give the goal a title.';
  const next = (db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM ops_goals').get() as { n: number }).n;
  const id = Number(db.prepare('INSERT INTO ops_goals (title, sort, created_by) VALUES (?, ?, ?)').run(t, next, userId).lastInsertRowid);
  log(`Goal added: ${t}`, userId);
  return listGoals().find((g) => g.id === id)!;
}

/** Saves the whole list as the page shows it: titles, progress and order (the array order). Ids that are not this agency's are ignored. */
export function saveGoals(goals: { id: number | string; title?: string; progress?: number }[], userId: number | null): OpsGoal[] {
  ensure();
  const have = new Map(listGoals().map((g) => [g.id, g]));
  db.transaction(() => {
    let sort = 0, reordered = false;
    for (const g of goals) {
      const id = Number(g.id), cur = have.get(id);
      if (!cur) continue;
      const title = g.title === undefined ? cur.title : oneLine(g.title, 200) || cur.title;
      const progress = g.progress === undefined ? cur.progress : clampProgress(g.progress);
      if (cur.sort !== sort) reordered = true;
      if (title !== cur.title || progress !== cur.progress || cur.sort !== sort) {
        db.prepare(`UPDATE ops_goals SET title = ?, progress = ?, sort = ?, updated_at = ${NOW} WHERE id = ?`).run(title, progress, sort, id);
      }
      if (progress !== cur.progress) log(`Goal progress: ${title} ${cur.progress}% to ${progress}%`, userId);
      if (title !== cur.title) log(`Goal renamed: ${cur.title} to ${title}`, userId);
      sort++;
    }
    if (reordered) log('Goals reordered', userId);
  })();
  return listGoals();
}

export function deleteGoal(id: number, userId: number | null): boolean {
  ensure();
  const g = listGoals().find((x) => x.id === id);
  if (!g) return false;
  db.prepare('DELETE FROM ops_goals WHERE id = ?').run(id);
  log(`Goal removed: ${g.title}`, userId);
  return true;
}

export function goalHistory(limit = 50): HistoryEntry[] {
  ensure();
  return db.prepare('SELECT at AS timestamp, change FROM ops_goal_history ORDER BY id DESC LIMIT ?').all(limit) as HistoryEntry[];
}

// ─── experiments ───
export type ExpStatus = 'planned' | 'running' | 'done';
export type ExpDecision = '' | 'keep' | 'discard';
export const EXP_STATUSES: ExpStatus[] = ['planned', 'running', 'done'];
export interface Experiment {
  id: number; title: string; hypothesis: string; metric: string; business: string; owner: string; started_on: string; ended_on: string;
  status: ExpStatus; result: string; decision: ExpDecision; source: 'person' | 'ai'; created_by: number | null; updated_by: number | null;
  created_at: string; updated_at: string;
}
export type ExperimentInput = Pick<Experiment, 'title' | 'hypothesis' | 'metric' | 'business' | 'owner' | 'started_on' | 'ended_on' | 'status' | 'result' | 'decision'>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown) => { const s = String(v ?? '').trim().slice(0, 10); return DAY.test(s) ? s : ''; };

/** Clean an experiment from a form or the AI; a string is the reason it was refused. `base` fills fields left out (an update). */
export function cleanExperiment(b: Record<string, unknown>, base?: ExperimentInput): ExperimentInput | string {
  const pick = <K extends keyof ExperimentInput>(k: K, f: (v: unknown) => ExperimentInput[K]): ExperimentInput[K] =>
    (b[k] === undefined && base ? base[k] : f(b[k]));
  const title = pick('title', (v) => oneLine(v, 160));
  if (!title) return 'Give the experiment a title.';
  const status = pick('status', (v) => (EXP_STATUSES.includes(v as ExpStatus) ? v as ExpStatus : 'planned'));
  const decision = pick('decision', (v) => (v === 'keep' || v === 'discard' ? v : ''));
  const started_on = pick('started_on', day), ended_on = pick('ended_on', day);
  if (started_on && ended_on && ended_on < started_on) return 'The end date is before the start date.';
  return {
    title, status, decision, started_on, ended_on,
    hypothesis: pick('hypothesis', (v) => text(v, 2000)), metric: pick('metric', (v) => oneLine(v, 200)),
    business: pick('business', (v) => oneLine(v, 60)), owner: pick('owner', (v) => oneLine(v, 80)), result: pick('result', (v) => text(v, 4000)),
  };
}

export function listExperiments(status?: ExpStatus): Experiment[] {
  ensure();
  return (status
    ? db.prepare(`SELECT * FROM ops_experiments WHERE status = ? ORDER BY id DESC`).all(status)
    : db.prepare(`SELECT * FROM ops_experiments ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, id DESC`).all()) as Experiment[];
}
export function getExperiment(id: number): Experiment | undefined {
  ensure();
  return db.prepare('SELECT * FROM ops_experiments WHERE id = ?').get(id) as Experiment | undefined;
}

export function saveExperiment(userId: number | null, e: ExperimentInput, id?: number, source: 'person' | 'ai' = 'person'): Experiment {
  ensure();
  if (id !== undefined) {
    const r = db.prepare(`UPDATE ops_experiments SET title = ?, hypothesis = ?, metric = ?, business = ?, owner = ?, started_on = ?, ended_on = ?, status = ?,
        result = ?, decision = ?, updated_by = ?, updated_at = ${NOW} WHERE id = ?`)
      .run(e.title, e.hypothesis, e.metric, e.business, e.owner, e.started_on, e.ended_on, e.status, e.result, e.decision, userId, id);
    if (!r.changes) throw new Error('That experiment is gone.');
    return getExperiment(id)!;
  }
  const r = db.prepare(`INSERT INTO ops_experiments (title, hypothesis, metric, business, owner, started_on, ended_on, status, result, decision, source, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.title, e.hypothesis, e.metric, e.business, e.owner, e.started_on, e.ended_on, e.status, e.result, e.decision, source, userId, userId);
  return getExperiment(Number(r.lastInsertRowid))!;
}

export function deleteExperiment(id: number): boolean {
  ensure();
  return db.prepare('DELETE FROM ops_experiments WHERE id = ?').run(id).changes > 0;
}

export interface ExperimentSummary { total: number; running: number; planned: number; done: number; kept: number; discarded: number; keepRate: number | null }
export function experimentSummary(list = listExperiments()): ExperimentSummary {
  const n = (f: (e: Experiment) => boolean) => list.filter(f).length;
  const kept = n((e) => e.decision === 'keep'), discarded = n((e) => e.decision === 'discard');
  return { total: list.length, running: n((e) => e.status === 'running'), planned: n((e) => e.status === 'planned'), done: n((e) => e.status === 'done'),
    kept, discarded, keepRate: kept + discarded ? Math.round((kept / (kept + discarded)) * 100) : null };
}
