import 'server-only';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { agencySecretValues } from '@/lib/agency-secrets';
import { modelOrDefault } from './models';
import { RUNNERS } from './runners';
import { envSecrets, redactSecrets, secretNeedles } from './tool-guard';
import { addAgentNote, addMemory, agentNotes, CORE_MAX, defaultAgent, getCore, listMemory, putCore, setStale, threadHistory, type Agent } from './store';
import { addTeamItem, hasTeamMemory, retireTeamItems, syncTeam } from './team-memory';

// The memory layers the AI was missing next to (D, 2026-10-23: "yes we need that"):
//  1. a change log of what the AI changes in memory, each change undoable from AI › Memory;
//  2. "Always remember": each agent's short core profile, in every prompt (store.ts notebookPrompt), edited by the agent itself;
//  3. learning after each answer: once an agent has answered an owner or admin, the model reads that exchange and the notes and adds,
//     updates or retires a few notes at once (the nightly pass still does the day's log and team memory);
//  4. conversation summaries: an owner or admin conversation that has gone quiet gets a short summary (what was asked, decided, done,
//     and who it was about), searched by recall as kind 'summary' (team-memory.ts ingest);
//  5. insights: the nightly pass turns team memory into a few patterns, each with its evidence and a confidence (team items, kind 'insight').
// Every model call: the main agent's model, no tools, JSON only, secrets scrubbed in and out.
const ready = schemaOnce(); // per agency database
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_memory_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), layer TEXT NOT NULL, target_id INTEGER,
      agent_id INTEGER, user_id INTEGER, action TEXT NOT NULL, before TEXT NOT NULL DEFAULT '', after TEXT NOT NULL DEFAULT '', by TEXT NOT NULL,
      thread_id INTEGER, undone_at TEXT);
    CREATE TABLE IF NOT EXISTS ai_thread_summaries (thread_id INTEGER PRIMARY KEY, summary TEXT NOT NULL, people TEXT NOT NULL DEFAULT '[]',
      through_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));`);
  ready.mark();
}
const scrub = (() => {
  let needles: string[] | null = null;
  return (t: string) => { needles ??= secretNeedles({ ...envSecrets(), ...agencySecretValues() }); return redactSecrets(t, needles).text; };
})();
const clean = (v: unknown, max = 600) => (typeof v === 'string' ? scrub(v).replace(/—/g, ',').trim().slice(0, max) : '');
const appPort = () => process.env.PORT || (process.env.NODE_ENV === 'production' ? '3000' : '3107');

/** One JSON answer from the model (no tools); null when not connected, failed or not JSON. */
export async function askJson<T>(system: string, prompt: string, agent: Agent | undefined = defaultAgent(), timeoutMs = 3 * 60_000): Promise<T | null> {
  const model = modelOrDefault(agent?.model), runner = RUNNERS[model.provider];
  if (!runner) return null;
  const { mintRunKey, revokeRunKey } = await import('./tools'); // loaded only for a model call (the tool server pulls in sign-in code)
  const key = mintRunKey(agent?.created_by ?? 1, 0, []);
  let text = '';
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
  const res = await runner({ system, prompt: scrub(prompt), session: { id: crypto.randomUUID(), resume: false }, model: model.wire, tools: [], signal: ac.signal,
    mcp: { url: `http://127.0.0.1:${appPort()}/api/ai/mcp`, key }, onText: (t) => { text += t; }, onToolStart: () => {}, onToolEnd: () => {} })
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  clearTimeout(timer); revokeRunKey(key);
  if (res.error) return null;
  try { return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as T; } catch { return null; }
}

// ─── 1. change log ───
export type Layer = 'agent_note' | 'note' | 'core' | 'insight';
export interface LogRow { id: number; at: string; layer: Layer; target_id: number | null; agent_id: number | null; user_id: number | null; action: string; before: string; after: string; by: string; thread_id: number | null; undone_at: string | null }
export function logChange(c: { layer: Layer; targetId?: number | null; agentId?: number | null; userId?: number | null; action: 'add' | 'update' | 'retire' | 'set'; before?: string; after?: string; by: string; threadId?: number | null }): number {
  ensure();
  return Number(db.prepare('INSERT INTO ai_memory_log (layer, target_id, agent_id, user_id, action, before, after, by, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c.layer, c.targetId ?? null, c.agentId ?? null, c.userId ?? null, c.action, (c.before ?? '').slice(0, 4000), (c.after ?? '').slice(0, 4000), c.by.slice(0, 40), c.threadId ?? null).lastInsertRowid);
}
/** Newest first, for AI › Memory: agent notes, core profiles and insights for everyone; personal notes only the person's own. */
export function listLog(userId: number, limit = 80): (LogRow & { agent: string | null })[] {
  ensure();
  return db.prepare(`SELECT l.*, a.name agent FROM ai_memory_log l LEFT JOIN ai_agents a ON a.id = l.agent_id
    WHERE l.layer <> 'note' OR l.user_id = ? ORDER BY l.id DESC LIMIT ?`).all(userId, limit) as never;
}
/** Puts back what a change replaced (an added note goes, an edit goes back, a retired note comes back, a core profile goes back). */
export function undoChange(id: number, userId: number): string {
  ensure();
  const c = db.prepare('SELECT * FROM ai_memory_log WHERE id = ?').get(id) as LogRow | undefined;
  if (!c || (c.layer === 'note' && c.user_id !== userId)) throw new Error('Not found.');
  if (c.undone_at) throw new Error('Already undone.');
  if (c.layer === 'core') putCore(c.agent_id!, c.before);
  else if (c.layer === 'insight') {
    if (c.action === 'add') db.prepare('DELETE FROM ai_team_memory WHERE id = ?').run(c.target_id);
    else db.prepare("UPDATE ai_team_memory SET status = 'active', valid_to = '' WHERE id = ?").run(c.target_id);
    syncTeam();
  } else if (c.action === 'add') db.prepare('DELETE FROM ai_memory WHERE id = ?').run(c.target_id);
  else if (c.action === 'update') db.prepare('UPDATE ai_memory SET content = ? WHERE id = ?').run(c.before, c.target_id);
  else if (c.action === 'retire') db.prepare('UPDATE ai_memory SET stale = 0 WHERE id = ?').run(c.target_id);
  db.prepare("UPDATE ai_memory_log SET undone_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(id);
  return 'Undone.';
}

// ─── 2. "Always remember" ───
export function coreAppend(agentId: number, text: string, by: string, userId: number | null, threadId: number | null): string {
  const before = getCore(agentId), add = clean(text, 400);
  if (!add) throw new Error('Say what to remember.');
  if (before.includes(add)) return 'Already in your core profile.';
  const after = `${before}${before ? '\n' : ''}- ${add.replace(/^-\s*/, '')}`;
  if (after.length > CORE_MAX) throw new Error(`Your core profile is full (${CORE_MAX} characters): replace an old line with core_memory_replace instead.`);
  putCore(agentId, after);
  logChange({ layer: 'core', agentId, userId, action: 'set', before, after, by, threadId });
  return 'Added to your core profile.';
}
export function coreReplace(agentId: number, old: string, next: string, by: string, userId: number | null, threadId: number | null): string {
  const before = getCore(agentId), o = old.trim();
  if (!o || !before.includes(o)) throw new Error('That text is not in your core profile; copy it exactly.');
  const after = before.replace(o, clean(next, 400)).replace(/\n{2,}/g, '\n').trim();
  if (after.length > CORE_MAX) throw new Error(`That would make the core profile longer than ${CORE_MAX} characters.`);
  putCore(agentId, after);
  logChange({ layer: 'core', agentId, userId, action: 'set', before, after, by, threadId });
  return 'Core profile updated.';
}
/** AI › Memory: a person (owner or admin) rewrites an agent's core profile. */
export function setCoreByPerson(agentId: number, body: string, userId: number): void {
  const before = getCore(agentId), after = body.trim().slice(0, CORE_MAX);
  if (before === after) return;
  putCore(agentId, after);
  logChange({ layer: 'core', agentId, userId, action: 'set', before, after, by: 'person' });
}

// ─── 3. learning after each answer ───
const learning = new Set<number>();
type LearnOut = { add?: { content?: string; for?: string }[]; update?: { id?: number; content?: string }[]; retire?: { id?: number }[]; lesson?: string };
/** After an agent answered an owner or admin (fire and forget; one at a time per conversation). Returns what changed, for tests. */
export async function learnAfterTurn(a: { agent: Agent | undefined; userId: number; threadId: number; question: string; reply: string }): Promise<string | null> {
  const agent = a.agent;
  if (!agent?.use_memory || !hasTeamMemory(a.userId) || learning.has(a.threadId)) return null;
  if (a.question.trim().length < 12 || a.reply.trim().length < 40 || (process.env.AI_LEARN || '').toLowerCase() === 'off') return null;
  learning.add(a.threadId);
  try {
    const notebook = agentNotes(agent.id).slice(0, 80), mine = listMemory(a.userId).slice(0, 60);
    const prompt = [
      `You keep ${agent.name}'s memory. Read this one exchange and decide whether anything in it should change memory. Answer with ONE JSON object:`,
      '{"add": [{"content": "<one sentence>", "for": "agent" | "person"}], "update": [{"id": <note id>, "content": "<the corrected note>"}], "retire": [{"id": <note id>}], "lesson": "<one rule, or empty>"}',
      `lesson = only when the person's message CORRECTS ${agent.name} (a wrong number, rule, person, tone or way of working in its earlier answer or this one): one short rule (at most 30 words) saying what to do from now on. Empty when nothing was corrected.`,
      'agent = a lasting fact about the agency, its rules, people or data that the agent should know in every later conversation. person = a lasting preference or fact about this person. update = a note the exchange corrects. retire = a note the exchange shows is no longer true.',
      'Most exchanges change nothing: then answer {"add": [], "update": [], "retire": []}. At most 3 changes. Never one-off numbers, questions, to-dos or anything already in the notes. Never secrets. Never invent. Never use em dashes.',
      `=== ${agent.name}'s notebook (id: note) ===\n${notebook.map((n) => `${n.id}: ${n.content}`).join('\n') || '(empty)'}`,
      `=== This person's notes (id: note) ===\n${mine.map((n) => `${n.id}: ${n.content}`).join('\n') || '(empty)'}`,
      `=== Before it (earlier in the conversation) ===\n${threadHistory(a.threadId, 6).slice(0, -2).map((m) => `${m.role === 'user' ? 'Person' : agent.name}: ${m.text.slice(0, 1500)}`).join('\n\n') || '(nothing)'}`,
      `=== The exchange ===\nPerson: ${a.question.slice(0, 4000)}\n\n${agent.name}: ${a.reply.slice(0, 6000)}`,
    ].join('\n\n');
    const out = await askJson<LearnOut>('You keep an AI agent\'s memory up to date after each answer. Answer with JSON only.', prompt, agent, 2 * 60_000);
    if (!out) return null;
    const done: string[] = [];
    let n = 0;
    for (const x of out.add ?? []) {
      const content = clean(x.content);
      if (!content || n >= 3) continue;
      if (x.for === 'person') { const id = addMemory(a.userId, content, a.threadId); logChange({ layer: 'note', targetId: id, userId: a.userId, agentId: agent.id, action: 'add', after: content, by: 'learn', threadId: a.threadId }); }
      else { const id = addAgentNote(agent.id, a.userId, content, a.threadId); logChange({ layer: 'agent_note', targetId: id, agentId: agent.id, userId: a.userId, action: 'add', after: content, by: 'learn', threadId: a.threadId }); }
      done.push(`add ${content}`); n++;
    }
    const owned = new Map<number, { layer: 'agent_note' | 'note'; content: string }>();
    for (const x of notebook) owned.set(x.id, { layer: 'agent_note', content: x.content });
    for (const x of mine) owned.set(x.id, { layer: 'note', content: x.content });
    for (const x of out.update ?? []) {
      const cur = owned.get(Number(x.id)), content = clean(x.content);
      if (!cur || !content || content === cur.content || n >= 3) continue;
      db.prepare('UPDATE ai_memory SET content = ? WHERE id = ?').run(content, Number(x.id));
      logChange({ layer: cur.layer, targetId: Number(x.id), agentId: agent.id, userId: a.userId, action: 'update', before: cur.content, after: content, by: 'learn', threadId: a.threadId });
      done.push(`update ${x.id}`); n++;
    }
    for (const x of out.retire ?? []) {
      const cur = owned.get(Number(x.id));
      if (!cur || n >= 3) continue;
      setStale([Number(x.id)], true, cur.layer === 'agent_note' ? { agentId: agent.id } : { userId: a.userId });
      logChange({ layer: cur.layer, targetId: Number(x.id), agentId: agent.id, userId: a.userId, action: 'retire', before: cur.content, by: 'learn', threadId: a.threadId });
      done.push(`retire ${x.id}`); n++;
    }
    if (typeof out.lesson === 'string' && out.lesson.trim()) {
      const { addLesson } = await import('./lessons');
      if (addLesson(agent.id, a.userId, clean(out.lesson, 400), a.threadId, 'chat')) done.push('lesson');
    }
    if (done.length) console.log(`[memory] learned after a turn in thread ${a.threadId}: ${done.length} change(s)`);
    return done.join('; ');
  } catch (e) { console.warn(`[memory] learn: ${e instanceof Error ? e.message : String(e)}`); return null; }
  finally { learning.delete(a.threadId); }
}

// ─── 4. conversation summaries ───
const QUIET_MS = 30 * 60_000;
/** Owner and admin conversations quiet for 30 minutes with new messages since their summary: up to `max` summarised per call. */
export async function summarizeIdle(max = 6, now = Date.now()): Promise<number> {
  ensure();
  const leads = (db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[]).filter((u) => hasTeamMemory(u.id));
  if (!leads.length) return 0;
  const names = new Map(leads.map((u) => [u.id, u.username]));
  const quiet = new Date(now - QUIET_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const due = db.prepare(`SELECT t.id, t.user_id, t.title, a.name agent, max(m.id) last, count(m.id) n FROM ai_threads t
      JOIN ai_messages m ON m.thread_id = t.id LEFT JOIN ai_agents a ON a.id = t.agent_id LEFT JOIN ai_thread_summaries s ON s.thread_id = t.id
     WHERE t.user_id IN (${leads.map(() => '?').join(',')}) GROUP BY t.id
    HAVING n >= 2 AND last > coalesce(max(s.through_id), 0) AND max(m.created_at) < ? ORDER BY last DESC LIMIT ?`).all(...leads.map((u) => u.id), quiet, max) as { id: number; user_id: number; title: string; agent: string | null; last: number }[];
  let made = 0;
  for (const t of due) {
    const msgs = (db.prepare('SELECT role, text FROM ai_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 40').all(t.id) as { role: string; text: string }[]).reverse();
    const transcript = msgs.map((m) => `${m.role === 'user' ? names.get(t.user_id) : t.agent ?? 'the AI'}: ${m.text.slice(0, 2000)}`).join('\n').slice(-30_000);
    const out = await askJson<{ summary?: string; people?: string[] }>('You summarise an AI conversation for an agency\'s team memory. Answer with JSON only.', [
      'Summarise this conversation for later recall. Answer with ONE JSON object: {"summary": "<under 120 words: what was asked, what was found (exact numbers with dates and contracts), what was decided or done, what is still open>", "people": ["<reps, clients and contracts it was about, names as written>"]}.',
      'Plain sentences, never invent, never use em dashes.',
      `=== "${t.title}" with ${names.get(t.user_id)} ===\n${transcript}`,
    ].join('\n\n'));
    // a failed or empty answer still moves the mark, so a conversation the model cannot read is not retried every pass
    db.prepare(`INSERT INTO ai_thread_summaries (thread_id, summary, people, through_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET summary = CASE WHEN excluded.summary <> '' THEN excluded.summary ELSE summary END, people = excluded.people,
      through_id = excluded.through_id, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`)
      .run(t.id, clean(out?.summary, 1500), JSON.stringify((out?.people ?? []).map((p) => clean(p, 80)).filter(Boolean).slice(0, 20)), t.last);
    if (clean(out?.summary)) made++;
  }
  return made;
}
/** The summaries as team memory sources (team-memory.ts ingest, kind 'summary'). */
export function summarySources(): { kind: string; ref: string; title: string; body: string; at: string }[] {
  ensure();
  const rows = db.prepare(`SELECT s.thread_id, s.summary, s.people, s.updated_at, t.title, u.username FROM ai_thread_summaries s
    JOIN ai_threads t ON t.id = s.thread_id LEFT JOIN users u ON u.id = t.user_id WHERE s.summary <> ''`).all() as { thread_id: number; summary: string; people: string; updated_at: string; title: string; username: string | null }[];
  return rows.map((r) => {
    const people = (JSON.parse(r.people || '[]') as string[]).join(', ');
    return { kind: 'summary', ref: `sum:${r.thread_id}`, title: `Summary of AI chat with ${r.username ?? 'a lead'}: ${r.title}`, body: `${r.summary}${people ? `\nAbout: ${people}` : ''}`, at: r.updated_at.slice(0, 10) };
  });
}

// ─── 5. insights ───
type InsightOut = { insights?: { text?: string; evidence?: number[]; confidence?: number }[]; retire?: number[] };
/** Nightly (memory-nightly.ts): a few patterns from team memory, each with its evidence and a confidence; old ones the sources no longer
 *  support are retired. Saved as team items (kind 'insight'), so recall and AI › Memory see them like decisions. */
export async function insightPass(day: string): Promise<string | null> {
  ensure();
  const since = new Date(Date.parse(`${day}T12:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
  const src: { title: string; body: string }[] = [
    ...(db.prepare("SELECT kind, content, who, day FROM ai_team_memory WHERE status = 'active' AND kind IN ('decision', 'fact') ORDER BY id DESC LIMIT 40").all() as { kind: string; content: string; who: string; day: string }[])
      .map((t) => ({ title: `Team ${t.kind} ${t.day} (${t.who})`, body: t.content })),
    ...summarySources().filter((s) => s.at >= since).slice(0, 40).map((s) => ({ title: `${s.title} (${s.at})`, body: s.body })),
    ...(db.prepare('SELECT e.name, p.body FROM ai_mem_profiles p JOIN ai_mem_entities e ON e.id = p.entity_id ORDER BY p.updated_at DESC LIMIT 20').all() as { name: string; body: string }[])
      .map((p) => ({ title: `Profile of ${p.name}`, body: p.body })),
    ...(db.prepare("SELECT who, what, due FROM ai_team_commitments WHERE status = 'open' ORDER BY id DESC LIMIT 15").all() as { who: string; what: string; due: string }[])
      .map((c) => ({ title: `Open commitment (${c.who})`, body: `${c.what}${c.due ? `, due ${c.due}` : ''}` })),
  ];
  if (src.length < 5) return null;
  const current = db.prepare("SELECT id, content FROM ai_team_memory WHERE status = 'active' AND kind = 'insight' ORDER BY id DESC LIMIT 30").all() as { id: number; content: string }[];
  const out = await askJson<InsightOut>('You find patterns in an agency\'s team memory. Answer with JSON only.', [
    'From the numbered sources below, write up to 5 NEW insights: patterns that hold across several sources and would change how the agency acts ("ACME no-shows rise on Mondays", "Sam wants numbers before commentary"). Answer with ONE JSON object:',
    '{"insights": [{"text": "<one or two sentences, with the names, numbers and dates that show it>", "evidence": [<source numbers, at least 2>], "confidence": <0 to 1>}], "retire": [<ids of current insights the sources now contradict>]}',
    'Not a restatement of one source, not a current insight again, never a guess. [] when there is nothing solid. Never use em dashes.',
    `=== Current insights (id: insight) ===\n${current.map((c) => `${c.id}: ${c.content}`).join('\n') || '(none)'}`,
    src.map((s, i) => `## Source ${i + 1}: ${s.title}\n${s.body.slice(0, 900)}`).join('\n\n'),
  ].join('\n\n'), undefined, 4 * 60_000);
  if (!out) return 'insights: no answer';
  let added = 0;
  for (const x of out.insights ?? []) {
    const ev = (x.evidence ?? []).map(Number).filter((n) => src[n - 1]), text = clean(x.text), conf = Math.max(0, Math.min(1, Number(x.confidence) || 0));
    if (!text || ev.length < 2 || conf < 0.5) continue;
    const id = addTeamItem({ kind: 'insight', content: text, who: 'the AI', day });
    if (!id) continue;
    db.prepare('UPDATE ai_team_memory SET evidence = ?, confidence = ? WHERE id = ?').run(JSON.stringify(ev.slice(0, 6).map((n) => src[n - 1].title)), conf, id);
    logChange({ layer: 'insight', targetId: id, action: 'add', after: text, by: 'nightly' });
    added++;
  }
  const retire = (out.retire ?? []).map(Number).filter((id) => current.some((c) => c.id === id));
  retireTeamItems(retire);
  for (const id of retire) logChange({ layer: 'insight', targetId: id, action: 'retire', before: current.find((c) => c.id === id)?.content, by: 'nightly' });
  if (added || retire.length) syncTeam();
  return `insights: ${added} new, ${retire.length} retired`;
}

