import 'server-only';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { reportTz } from '@/lib/report-tz';
import { todayIn } from '@/lib/sales-range';
import { getAgent, listAgents, agentNotes, getCore, type Agent } from './store';
import { addLesson } from './lessons';

// Agent tests (D 2026-10-28; first evals, 2026-10-25): questions an agent should answer well, each with what a good answer contains. A run asks
// the agent through the normal path READ ONLY (comms kind 'ask': no writes, no sends) with its memory recalled, then a model scores the
// answer 0-10 against the expectation. "Write tests" drafts 5 from the agent's instructions, notes and core profile. All tests run every
// Sunday 02:00 (business time) so a change to instructions or memory shows up as a score that moved. Operations › Tests.
export interface Eval { id: number; agent_id: number; question: string; expect: string; created_at: string; last_score: number | null; last_at: string | null; last_answer: string; last_why: string }

const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_evals (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, question TEXT NOT NULL, expect TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE IF NOT EXISTS ai_eval_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, eval_id INTEGER NOT NULL, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      answer TEXT NOT NULL DEFAULT '', score INTEGER, why TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS idx_ai_eval_runs ON ai_eval_runs (eval_id, id)`);
  ready.mark();
}
const clip = (v: unknown, n: number) => String(v ?? '').replace(/—/g, ', ').trim().slice(0, n);

export function listEvals(agentId?: number): Eval[] {
  ensure();
  return db.prepare(`SELECT e.*, r.score last_score, r.at last_at, COALESCE(r.answer, '') last_answer, COALESCE(r.why, '') last_why FROM ai_evals e
    LEFT JOIN ai_eval_runs r ON r.id = (SELECT MAX(id) FROM ai_eval_runs WHERE eval_id = e.id) ${agentId ? 'WHERE e.agent_id = ?' : ''} ORDER BY e.agent_id, e.id`).all(...(agentId ? [agentId] : [])) as Eval[];
}
/** Each test's scores, oldest first (the trend). */
export function evalHistory(evalId: number, limit = 12): { at: string; score: number | null }[] {
  ensure();
  return (db.prepare('SELECT at, score FROM ai_eval_runs WHERE eval_id = ? ORDER BY id DESC LIMIT ?').all(evalId, limit) as { at: string; score: number | null }[]).reverse();
}
export function addEval(agentId: number, question: string, expect: string): number | string {
  ensure();
  if (!getAgent(agentId)) return 'No such agent.';
  if (clip(question, 1000).length < 8 || clip(expect, 1000).length < 4) return 'Write the question and what a good answer contains.';
  return Number(db.prepare('INSERT INTO ai_evals (agent_id, question, expect) VALUES (?, ?, ?)').run(agentId, clip(question, 1000), clip(expect, 1000)).lastInsertRowid);
}
export function deleteEval(id: number): boolean { ensure(); db.prepare('DELETE FROM ai_eval_runs WHERE eval_id = ?').run(id); return db.prepare('DELETE FROM ai_evals WHERE id = ?').run(id).changes > 0; }

const owner = () => (db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id ?? 1;

/** Run one test: ask read only, then score. Returns the score (null when the agent or the grader did not answer). */
export async function runEval(id: number): Promise<{ score: number | null; why: string }> {
  ensure();
  const e = db.prepare('SELECT * FROM ai_evals WHERE id = ?').get(id) as Eval | undefined;
  const agent = e && getAgent(e.agent_id);
  if (!e || !agent) return { score: null, why: 'Test or agent gone.' };
  const { runAgentTurn } = await import('./comms');
  const r = await runAgentTurn({ agent, userId: owner(), prompt: e.question, title: `Test #${e.id}: ${e.question.slice(0, 60)}`, kind: 'ask', from: 'The agent tests (AI › Tests)', ctx: { depth: 1, chain: [], ownerStarted: false }, timeoutMs: 5 * 60_000 });
  // the test's own conversation is not a chat anyone had: removed so it never feeds memory
  if (r.threadId) { db.prepare('DELETE FROM ai_messages WHERE thread_id = ?').run(r.threadId); db.prepare('DELETE FROM ai_threads WHERE id = ?').run(r.threadId); }
  let score: number | null = null, why = r.error ? `No answer: ${r.error}` : '';
  if (!r.error && r.text) {
    const { askJson } = await import('./memory-layers');
    const g = await askJson<{ score?: number; why?: string }>('You grade an AI agent\'s answer against what a good answer contains. Answer with JSON only.', [
      `Today is ${todayIn(reportTz())} in the business's time zone (${reportTz()}); judge dates against that. ` + 'Score the answer 0 to 10 against the expectation: 10 = every expected point, correct and clear; 5 = half the points or vague; 0 = wrong or missing. Wrong numbers or invented facts cost the most. Answer {"score": <0-10>, "why": "<one line: what it got right or missed>"}.',
      `=== Question ===\n${e.question}`, `=== A good answer contains ===\n${e.expect}`, `=== The agent's answer ===\n${r.text.slice(0, 6000)}`,
    ].join('\n\n'), agent, 2 * 60_000);
    if (g && typeof g.score === 'number') { score = Math.max(0, Math.min(10, Math.round(g.score))); why = clip(g.why, 300); } else why = 'The grader did not answer.';
  }
  db.prepare('INSERT INTO ai_eval_runs (eval_id, answer, score, why) VALUES (?, ?, ?, ?)').run(id, clip(r.text, 6000), score, why);
  return { score, why };
}

/** Draft 5 tests for an agent from what it is meant to know (instructions, core profile, notebook). Returns how many were added. */
export async function writeEvals(agentId: number): Promise<number | string> {
  const agent = getAgent(agentId);
  if (!agent) return 'No such agent.';
  const { askJson } = await import('./memory-layers');
  const have = listEvals(agentId).map((e) => e.question);
  const out = await askJson<{ tests?: { question?: string; expect?: string }[] }>('You write tests for an AI agent. Answer with JSON only.', [
    `Write 5 tests for ${agent.name}: questions its people really ask it, each with what a good answer must contain. Cover its standing rules (the ones it must never get wrong), how its numbers are counted, who does what, and one thing it must refuse or ask first. Prefer questions whose right answer is in the text below, so the expectation is checkable. Answer {"tests": [{"question": "...", "expect": "<the points a good answer contains>"}]}. No em dashes.`,
    have.length ? `Tests it already has (do not repeat):\n${have.map((q) => `- ${q}`).join('\n')}` : '',
    `=== ${agent.name}'s instructions ===\n${agent.instructions.slice(0, 9000)}`,
    `=== Always remember ===\n${getCore(agentId) || '(empty)'}`,
    `=== Notebook ===\n${agentNotes(agentId).slice(0, 60).map((n) => `- ${n.content}`).join('\n') || '(empty)'}`,
  ].filter(Boolean).join('\n\n'), agent, 4 * 60_000);
  let n = 0;
  for (const t of out?.tests ?? []) if (typeof addEval(agentId, String(t.question ?? ''), String(t.expect ?? '')) === 'number') n++;
  return n;
}

/** From the routine clock: tests never run yet, any time; every Sunday from 02:00 business time, every test not run in the last 6 days. One at a time. */
let weeklyBusy = false;
export async function evalsTick(tz: string, now = new Date()): Promise<void> {
  if (weeklyBusy) return;
  activateWaitingLessons(now); // test lessons past their 3 days go live (cheap; the hub did it nightly)
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  ensure();
  // a test never run gets its first score now, any day; every test runs again on Sunday from 02:00
  const weekly = p.weekday === 'Sun' && Number(p.hour) >= 2;
  const due = db.prepare(`SELECT e.id FROM ai_evals e WHERE NOT EXISTS (SELECT 1 FROM ai_eval_runs r WHERE r.eval_id = e.id${weekly ? ' AND r.at >= ?' : ''})`).all(...(weekly ? [new Date(now.getTime() - 6 * 86_400_000).toISOString()] : [])) as { id: number }[];
  if (!due.length) return;
  weeklyBusy = true;
  try {
    for (const d of due) await runEval(d.id).catch(() => null);
    if (weekly) {
      const learned = await learnFromTests().catch((e) => { console.warn(`[evals] learn: ${e instanceof Error ? e.message : String(e)}`); return 0; });
      await weeklyReport(learned).catch((e) => console.warn(`[evals] report: ${e instanceof Error ? e.message : String(e)}`));
    }
  } finally { weeklyBusy = false; }
}

// ─── learning from failed tests (CTRL Flow parity, D 2026-10-26) ───
// After the Sunday run: each test scored 5 or under this week becomes a proposed lesson for its agent (at most 3 per agent a week). It waits
// (ai_memory kind 'lesson', stale 1, day 'waiting') and goes live after 3 days unless dropped on AI › Memory (activateWaitingLessons, nightly).
const FAIL_AT = 5, LESSONS_A_WEEK = 3, WAIT_DAYS = 3;
export async function learnFromTests(now = new Date()): Promise<number> {
  ensure();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const failed = (db.prepare(`SELECT e.id, e.agent_id, e.question, e.expect, r.answer, r.why FROM ai_evals e JOIN ai_eval_runs r ON r.id = (SELECT MAX(id) FROM ai_eval_runs WHERE eval_id = e.id)
    WHERE r.score IS NOT NULL AND r.score <= ? AND r.at >= ? ORDER BY r.score, e.id`).all(FAIL_AT, weekAgo)) as { id: number; agent_id: number; question: string; expect: string; answer: string; why: string }[];
  const { askJson } = await import('./memory-layers');
  let n = 0;
  for (const f of failed) {
    const agent = getAgent(f.agent_id);
    if (!agent) continue;
    const made = (db.prepare("SELECT count(*) n FROM ai_memory WHERE agent_id = ? AND kind = 'lesson' AND content LIKE 'From test #%' AND created_at >= ?").get(f.agent_id, weekAgo.slice(0, 19) + 'Z') as { n: number }).n;
    if (made >= LESSONS_A_WEEK || db.prepare("SELECT 1 FROM ai_memory WHERE agent_id = ? AND kind = 'lesson' AND content LIKE ?").get(f.agent_id, `From test #${f.id}:%`)) continue;
    const out = await askJson<{ lesson?: string }>('You turn a failed test of an AI agent into one standing rule it should follow. Answer with JSON only.', [
      `The agent ${agent.name} failed this test. Write ONE short rule (under 200 characters) that would make it answer right next time, in the imperative ("Count cancelled bookings as no-shows."). Only what the expectation shows; never invent facts. {"lesson": ""} when the failure was a tool or data outage, not a gap in what it knows. No em dashes.`,
      `=== Question ===\n${f.question}`, `=== A good answer contains ===\n${f.expect}`, `=== Its answer ===\n${f.answer.slice(0, 3000)}`, `=== Grader ===\n${f.why}`,
    ].join('\n\n'), agent, 2 * 60_000);
    const rule = clip(out?.lesson, 220);
    if (!rule) continue;
    db.prepare("INSERT INTO ai_memory (user_id, content, agent_id, kind, stale, day) VALUES (?, ?, ?, 'lesson', 1, 'waiting')").run(owner(), `From test #${f.id}: ${rule}`, f.agent_id);
    n++;
  }
  if (n) console.log(`[evals] ${n} proposed lessons from failed tests (live in ${WAIT_DAYS} days unless dropped)`);
  return n;
}
/** The Sunday results in one message to the owners on Telegram (when linked): each agent's average and its tests under 6. Operations ›
 *  Tests shows the same. */
export async function weeklyReport(learned: number, now = new Date()): Promise<string> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = db.prepare(`SELECT e.id, e.agent_id, e.question, r.score FROM ai_evals e JOIN ai_eval_runs r ON r.id = (SELECT MAX(id) FROM ai_eval_runs WHERE eval_id = e.id) WHERE r.at >= ? AND r.score IS NOT NULL`).all(weekAgo) as { id: number; agent_id: number; question: string; score: number }[];
  if (!rows.length) return '';
  const by = new Map<number, typeof rows>();
  for (const r of rows) by.set(r.agent_id, [...(by.get(r.agent_id) ?? []), r]);
  const lines = [...by].map(([id, rs]) => {
    const avg = rs.reduce((t, r) => t + r.score, 0) / rs.length, low = rs.filter((r) => r.score <= FAIL_AT);
    return `${getAgent(id)?.name ?? `Agent ${id}`}: ${avg.toFixed(1)}/10 over ${rs.length}${low.length ? `; low: ${low.map((r) => `#${r.id} (${r.score})`).join(', ')}` : ''}`;
  });
  const text = `Weekly agent tests\n${lines.join('\n')}${learned ? `\n\n${learned} lessons proposed from failed tests; they go live in ${WAIT_DAYS} days unless dropped in the Inbox.` : ''}`;
  if (!(await (await import('./telegram')).tellOwners(text))) console.log(`[evals] ${text.replace(/\n/g, ' | ')}`);
  return text;
}

/** Proposed test lessons older than WAIT_DAYS go live through lessons.ts addLesson (logged, deduped, the 40 cap), like correction
 *  lessons, so the prompt's Lessons block and the Inbox see them. The waiting row is replaced by the live one. Returns how many. */
export function activateWaitingLessons(now = new Date()): number {
  ensure();
  const cut = new Date(now.getTime() - WAIT_DAYS * 86_400_000).toISOString().slice(0, 19) + 'Z';
  const due = db.prepare("SELECT id, user_id, agent_id, content FROM ai_memory WHERE kind = 'lesson' AND stale = 1 AND day = 'waiting' AND created_at <= ?").all(cut) as { id: number; user_id: number; agent_id: number; content: string }[];
  let n = 0;
  for (const l of due) {
    db.prepare('DELETE FROM ai_memory WHERE id = ?').run(l.id);
    if (addLesson(l.agent_id, l.user_id, l.content, null, 'failed test')) n++;
  }
  return n;
}

export const agentsForTests = (): Pick<Agent, 'id' | 'name' | 'icon' | 'color'>[] => listAgents().map(({ id, name, icon, color }) => ({ id, name, icon, color }));
