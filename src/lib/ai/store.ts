// the agents storage (D, 2026-10-09: "the AI built into the back end here like CTRL Flow"). Fleet's SQLite, per user:
// conversations (each holds the headless Claude session it resumes, so a conversation is one continuous session), their messages,
// and memory notes (ai_agent_memory: lasting facts the AI saves with remember and reads at the start of every turn).
import { db } from '@/lib/db';
import { SYSTEM_SKILLS } from './system-skills';
import { schemaOnce } from '../schema-once';
import { goalsPrompt } from './goals';

const ready = schemaOnce(); // per agency database (D, 2026-10-09)
// Agents and skills (D, 2026-10-09): ai_agents / ai_skills, install-wide agents and per-login skills.
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_ai_threads_user ON ai_threads (user_id, updated_at);
    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_ai_messages_thread ON ai_messages (thread_id, id);
    CREATE TABLE IF NOT EXISTS ai_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, content TEXT NOT NULL, thread_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_ai_memory_user ON ai_memory (user_id, id);
    CREATE TABLE IF NOT EXISTS ai_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '', tools TEXT NOT NULL DEFAULT '[]', use_memory INTEGER NOT NULL DEFAULT 1, starters TEXT NOT NULL DEFAULT '[]',
      icon TEXT NOT NULL DEFAULT 'sparkles', color TEXT NOT NULL DEFAULT 'ink', is_default INTEGER NOT NULL DEFAULT 0, shared INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE IF NOT EXISTS ai_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      share TEXT NOT NULL DEFAULT 'me', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE INDEX IF NOT EXISTS idx_ai_skills_user ON ai_skills (user_id, name);`);
  // conversations remember their agent (D, 2026-10-09: agents)
  const cols = (db.prepare('PRAGMA table_info(ai_threads)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('agent_id')) db.exec('ALTER TABLE ai_threads ADD COLUMN agent_id INTEGER');
  // compaction (D, 2026-10-09): how full the session is, and the summary a compacted conversation carries on from
  if (!cols.includes('context_tokens')) db.exec('ALTER TABLE ai_threads ADD COLUMN context_tokens INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('summary')) db.exec("ALTER TABLE ai_threads ADD COLUMN summary TEXT NOT NULL DEFAULT ''");
  // a run in progress (D, 2026-10-23: runs keep going when the page reloads): its reply so far, refreshed every second; stop_at = Stop pressed
  if (!cols.includes('live_json')) db.exec("ALTER TABLE ai_threads ADD COLUMN live_json TEXT");
  if (!cols.includes('live_at')) db.exec('ALTER TABLE ai_threads ADD COLUMN live_at INTEGER');
  if (!cols.includes('stop_at')) db.exec('ALTER TABLE ai_threads ADD COLUMN stop_at INTEGER');
  // skills get a display name beside their command (D, 2026-10-09, Name + Command)
  const scols = (db.prepare('PRAGMA table_info(ai_skills)').all() as { name: string }[]).map((c) => c.name);
  if (!scols.includes('title')) db.exec("ALTER TABLE ai_skills ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  if (!scols.includes('agent_id')) db.exec('ALTER TABLE ai_skills ADD COLUMN agent_id INTEGER'); // the agent that wrote it (D, 2026-10-23)
  if (!scols.includes('folder')) db.exec("ALTER TABLE ai_skills ADD COLUMN folder TEXT NOT NULL DEFAULT ''"); // sidebar folder, 'a/b' nests (D, 2026-10-27)
  // a skill is a folder like a Claude skill (D, 2026-10-27): SKILL.md is ai_skills.body, its other files (references/x.md ...) live here
  db.exec(`CREATE TABLE IF NOT EXISTS ai_skill_files (skill_id INTEGER NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), PRIMARY KEY (skill_id, path))`);
  // files and pictures sent with a message (lib/ai/attachments.ts, D 2026-10-23): [{ id, name, type, size, kind }]
  if (!(db.prepare('PRAGMA table_info(ai_messages)').all() as { name: string }[]).some((c) => c.name === 'files')) db.exec("ALTER TABLE ai_messages ADD COLUMN files TEXT NOT NULL DEFAULT '[]'");
  const acols = (db.prepare('PRAGMA table_info(ai_agents)').all() as { name: string }[]).map((c) => c.name);
  if (!acols.includes('avatar')) db.exec("ALTER TABLE ai_agents ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
  if (!acols.includes('apps')) db.exec("ALTER TABLE ai_agents ADD COLUMN apps TEXT NOT NULL DEFAULT '[]'"); // connected apps (Composio slugs)
  if (!acols.includes('role')) db.exec("ALTER TABLE ai_agents ADD COLUMN role TEXT NOT NULL DEFAULT '{}'"); // role card (AgentRole JSON)
  if (!acols.includes('daily_budget_usd')) db.exec('ALTER TABLE ai_agents ADD COLUMN daily_budget_usd REAL'); // own daily cap, API-price dollars (usage.ts overBudget; null = none)
  if (!acols.includes('night_shift')) db.exec('ALTER TABLE ai_agents ADD COLUMN night_shift INTEGER NOT NULL DEFAULT 0'); // a Night shift card each night (tasks.ts)
  if (!cols.includes('summary_from')) db.exec('ALTER TABLE ai_threads ADD COLUMN summary_from INTEGER NOT NULL DEFAULT 0');
  // agent memory (D, 2026-10-12): agent_id set = that agent's notebook (shared by everyone who uses it), kind 'note' or 'log' (its daily
  // log, day = YYYY-MM-DD); stale = flagged by the nightly memory pass (kept and shown, no longer read into prompts)
  // "Always remember" (D, 2026-10-23, working memory): a short core profile per agent, in every prompt, the agent edits it itself
  db.exec(`CREATE TABLE IF NOT EXISTS ai_agent_core (agent_id INTEGER PRIMARY KEY, body TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
  const mcols = (db.prepare('PRAGMA table_info(ai_memory)').all() as { name: string }[]).map((c) => c.name);
  if (!mcols.includes('agent_id')) db.exec('ALTER TABLE ai_memory ADD COLUMN agent_id INTEGER');
  if (!mcols.includes('kind')) db.exec("ALTER TABLE ai_memory ADD COLUMN kind TEXT NOT NULL DEFAULT 'note'");
  if (!mcols.includes('day')) db.exec("ALTER TABLE ai_memory ADD COLUMN day TEXT NOT NULL DEFAULT ''");
  if (!mcols.includes('stale')) db.exec('ALTER TABLE ai_memory ADD COLUMN stale INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_memory_agent ON ai_memory (agent_id, kind, id);
    CREATE TABLE IF NOT EXISTS ai_memory_runs (day TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), summary TEXT NOT NULL DEFAULT '')`);
  ready.mark();
  seedAgents();
}

export interface Thread { id: number; user_id: number; title: string; session_id: string; agent_id: number | null; context_tokens?: number; summary?: string; created_at: string; updated_at: string }
export interface Step { name: string; title: string; status: 'running' | 'done' | 'error' }
export interface MessageFile { id: string; name: string; type: string; size: number; kind: 'image' | 'pdf' | 'text' | 'office' }
export interface Message { id: number; thread_id: number; role: 'user' | 'assistant'; text: string; steps: Step[]; files: MessageFile[]; created_at: string }
export interface Note { id: number; content: string; created_at: string; stale?: number; day?: string }

/** This login's conversations, newest first; `q` matches the title or any message. */
/** This login's conversations, newest first: up to 100 chats, plus up to 300 routine runs tagged with their routine (D, 2026-10-27: routines
 *  get their own section, a folder per routine, so runs no longer crowd out the chats). `q` searches titles and messages. */
export function listThreads(userId: number, q = ''): (Thread & { routine_id?: number | null; routine?: string | null })[] {
  ensure();
  const needle = q.trim();
  const like = needle ? `%${needle.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  const match = like ? ` AND (t.title LIKE @like ESCAPE '\\' OR EXISTS (SELECT 1 FROM ai_messages m WHERE m.thread_id = t.id AND m.text LIKE @like ESCAPE '\\'))` : '';
  const routines = (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_routine_runs'").get()) && (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_routines'").get());
  if (!routines) return db.prepare(`SELECT * FROM ai_threads t WHERE t.user_id = @uid${match} ORDER BY t.updated_at DESC LIMIT 100`).all({ uid: userId, ...(like ? { like } : {}) }) as Thread[];
  const p = { uid: userId, ...(like ? { like } : {}) };
  const chats = db.prepare(`SELECT t.*, NULL AS routine_id, NULL AS routine FROM ai_threads t WHERE t.user_id = @uid${match}
    AND NOT EXISTS (SELECT 1 FROM ai_routine_runs r WHERE r.thread_id = t.id) ORDER BY t.updated_at DESC LIMIT 100`).all(p) as Thread[];
  const runs = db.prepare(`SELECT t.*, r.routine_id, COALESCE(rt.name, 'Routine') AS routine FROM ai_threads t JOIN ai_routine_runs r ON r.thread_id = t.id
    LEFT JOIN ai_routines rt ON rt.id = r.routine_id WHERE t.user_id = @uid${match} ORDER BY t.updated_at DESC LIMIT 300`).all(p) as Thread[];
  return [...chats, ...runs];
}
// ─── runs in progress: in the database, since the 3 app copies share it (a reload or Stop may reach another copy) ───
export interface LiveRun { reply: string; steps: Step[] }
const LIVE_STALE_MS = 30_000; // not refreshed for this long = the app restarted mid-run
export function setLive(threadId: number, live: LiveRun | null) {
  ensure();
  if (live) db.prepare('UPDATE ai_threads SET live_json = ?, live_at = ? WHERE id = ?').run(JSON.stringify(live), Date.now(), threadId);
  else db.prepare('UPDATE ai_threads SET live_json = NULL, live_at = NULL, stop_at = NULL WHERE id = ?').run(threadId);
}
export function liveOf(threadId: number, now = Date.now()): LiveRun | null {
  ensure();
  const r = db.prepare('SELECT live_json, live_at FROM ai_threads WHERE id = ?').get(threadId) as { live_json: string | null; live_at: number | null } | undefined;
  return r?.live_json && r.live_at && now - r.live_at < LIVE_STALE_MS ? JSON.parse(r.live_json) as LiveRun : null;
}
/** A run the app stopped refreshing (it restarted mid-answer): cleared, and what it had so far handed back once so it can be saved. */
export function endStaleLive(threadId: number, now = Date.now()): LiveRun | null {
  ensure();
  const r = db.prepare('SELECT live_json, live_at FROM ai_threads WHERE id = ?').get(threadId) as { live_json: string | null; live_at: number | null } | undefined;
  if (!r?.live_json || (r.live_at && now - r.live_at < LIVE_STALE_MS)) return null;
  const done = db.prepare('UPDATE ai_threads SET live_json = NULL, live_at = NULL, stop_at = NULL WHERE id = ? AND live_json IS NOT NULL').run(threadId);
  return done.changes ? JSON.parse(r.live_json) as LiveRun : null;
}
export function requestStop(threadId: number) { ensure(); db.prepare('UPDATE ai_threads SET stop_at = ? WHERE id = ? AND live_json IS NOT NULL').run(Date.now(), threadId); }
export function stopRequested(threadId: number): boolean { ensure(); return !!(db.prepare('SELECT stop_at FROM ai_threads WHERE id = ?').get(threadId) as { stop_at: number | null } | undefined)?.stop_at; }
export function getThread(userId: number, id: number): Thread | undefined {
  ensure();
  return db.prepare('SELECT * FROM ai_threads WHERE id = ? AND user_id = ?').get(id, userId) as Thread | undefined;
}
export function createThread(userId: number, title: string, sessionId: string, agentId: number | null = null): Thread {
  ensure();
  const r = db.prepare('INSERT INTO ai_threads (user_id, title, session_id, agent_id) VALUES (?, ?, ?, ?)').run(userId, title.slice(0, 80), sessionId, agentId);
  return getThread(userId, Number(r.lastInsertRowid))!;
}
export function setThreadAgent(id: number, agentId: number | null) {
  ensure();
  db.prepare('UPDATE ai_threads SET agent_id = ? WHERE id = ?').run(agentId, id);
}
export function setThreadContext(id: number, tokens: number) {
  ensure();
  db.prepare('UPDATE ai_threads SET context_tokens = ? WHERE id = ?').run(Math.round(tokens), id);
}
/** After compaction: a fresh session that starts from the summary. */
export function compactThread(id: number, sessionId: string, summary: string) {
  ensure();
  const last = (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ai_messages WHERE thread_id = ?').get(id) as { m: number }).m;
  db.prepare('UPDATE ai_threads SET session_id = ?, summary = ?, summary_from = ?, context_tokens = 0 WHERE id = ?').run(sessionId, summary.slice(0, 20_000), last, id);
}
/** The turns since the last compaction (the summary covers the rest), oldest first, for runners that replay history. */
export function threadHistory(id: number, limit = 40): { role: 'user' | 'assistant'; text: string }[] {
  ensure();
  const from = (db.prepare('SELECT summary_from FROM ai_threads WHERE id = ?').get(id) as { summary_from?: number } | undefined)?.summary_from ?? 0;
  return (db.prepare('SELECT role, text FROM ai_messages WHERE thread_id = ? AND id > ? ORDER BY id DESC LIMIT ?').all(id, from, limit) as { role: 'user' | 'assistant'; text: string }[]).reverse();
}
export function renameThread(userId: number, id: number, title: string): boolean {
  ensure();
  const t = title.trim().slice(0, 80);
  return !!t && db.prepare('UPDATE ai_threads SET title = ? WHERE id = ? AND user_id = ?').run(t, id, userId).changes > 0;
}
export function touchThread(id: number) {
  ensure();
  db.prepare(`UPDATE ai_threads SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(id);
}
export function deleteThread(userId: number, id: number) {
  ensure();
  if (db.prepare('DELETE FROM ai_threads WHERE id = ? AND user_id = ?').run(id, userId).changes) db.prepare('DELETE FROM ai_messages WHERE thread_id = ?').run(id);
}
export function listMessages(threadId: number): Message[] {
  ensure();
  return (db.prepare('SELECT * FROM ai_messages WHERE thread_id = ? ORDER BY id').all(threadId) as (Omit<Message, 'steps' | 'files'> & { steps: string; files?: string })[])
    .map((m) => ({ ...m, steps: JSON.parse(m.steps || '[]'), files: JSON.parse(m.files || '[]') }));
}
export function addMessage(threadId: number, role: Message['role'], text: string, steps: Step[] = [], files: MessageFile[] = []) {
  ensure();
  db.prepare('INSERT INTO ai_messages (thread_id, role, text, steps, files) VALUES (?, ?, ?, ?, ?)').run(threadId, role, text, JSON.stringify(steps), JSON.stringify(files));
  touchThread(threadId);
}

// ─── memory notes ───
/** This login's own notes (agent notebooks are separate); stale ones only with `withStale` (the Memory page). */
export function listMemory(userId: number, withStale = false): Note[] {
  ensure();
  return db.prepare(`SELECT id, content, created_at, stale FROM ai_memory WHERE user_id = ? AND agent_id IS NULL${withStale ? '' : ' AND stale = 0'} ORDER BY id DESC LIMIT 200`).all(userId) as Note[];
}
export function addMemory(userId: number, content: string, threadId: number | null): number {
  ensure();
  const text = content.trim().slice(0, 1000);
  if (!text) throw new Error('Memory note is empty.');
  return Number(db.prepare('INSERT INTO ai_memory (user_id, content, thread_id) VALUES (?, ?, ?)').run(userId, text, threadId).lastInsertRowid);
}
export function deleteMemory(userId: number, id: number): boolean {
  ensure();
  return db.prepare('DELETE FROM ai_memory WHERE id = ? AND user_id = ? AND agent_id IS NULL').run(id, userId).changes > 0;
}
export function editMemory(userId: number, id: number, content: string): boolean {
  ensure();
  const text = content.trim().slice(0, 1000);
  if (!text) throw new Error('Memory note is empty.');
  return db.prepare('UPDATE ai_memory SET content = ?, stale = 0 WHERE id = ? AND user_id = ? AND agent_id IS NULL').run(text, id, userId).changes > 0;
}
export function clearMemory(userId: number): number {
  ensure();
  return db.prepare('DELETE FROM ai_memory WHERE user_id = ? AND agent_id IS NULL').run(userId).changes;
}

// ─── agents (install-wide; the owner and admins edit them) ───
export interface Agent {
  id: number; name: string; description: string; instructions: string; model: string; tools: string[]; use_memory: boolean; starters: string[];
  icon: string; color: string; avatar?: string; apps?: string[]; role?: AgentRole; daily_budget_usd?: number | null; night_shift?: boolean; is_default: boolean; shared: boolean; created_by: number | null; created_at: string; updated_at: string;
}
// The role card (D 2026-10-28): title, a line on the job, what the agent owns and what it hands off. Opens every prompt.
export interface AgentRole { title: string; summary: string; owns: string[]; not_owns: string[] }
type AgentRow = Omit<Agent, 'tools' | 'starters' | 'use_memory' | 'is_default' | 'shared' | 'apps' | 'role' | 'night_shift'> & { tools: string; starters: string; use_memory: number; is_default: number; shared: number; apps?: string; role?: string; night_shift?: number };
const list = (raw: string): string[] => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
const toRole = (raw: string | undefined): AgentRole => {
  try { const v = JSON.parse(raw || '{}'); return { title: String(v.title ?? ''), summary: String(v.summary ?? ''), owns: list(JSON.stringify(v.owns ?? [])), not_owns: list(JSON.stringify(v.not_owns ?? [])) }; }
  catch { return { title: '', summary: '', owns: [], not_owns: [] }; }
};
/** A role card from untrusted input (the agents API): short strings, at most 12 lines each side. */
export const cleanRole = (v: unknown): AgentRole => {
  const r = toRole(JSON.stringify(v ?? {})), lines = (a: string[]) => a.map((x) => x.trim().slice(0, 200)).filter(Boolean).slice(0, 12);
  return { title: r.title.trim().slice(0, 80), summary: r.summary.trim().slice(0, 600), owns: lines(r.owns), not_owns: lines(r.not_owns) };
};
const toAgent = (r: AgentRow): Agent => ({ ...r, tools: list(r.tools), starters: list(r.starters), apps: list(r.apps ?? '[]'), role: toRole(r.role), night_shift: !!r.night_shift, use_memory: !!r.use_memory, is_default: !!r.is_default, shared: !!r.shared });
export type AgentInput = Pick<Agent, 'name' | 'description' | 'instructions' | 'model' | 'tools' | 'use_memory' | 'starters' | 'icon' | 'color'> & { shared?: boolean; avatar?: string; apps?: string[]; role?: AgentRole; daily_budget_usd?: number | null; night_shift?: boolean }; // seeded agents are team agents
/** The role card, then the instructions: how every prompt opens on the agent ('' when it has neither). */
export function roleBlock(agent: Agent | undefined): string {
  if (!agent) return '';
  const r = agent.role, card = r && (r.title || r.summary || r.owns.length || r.not_owns.length) ? [
    `=== Role card (${agent.name}) ===`, r.title && `Title: ${r.title}`, r.summary,
    r.owns.length && `You own:\n${r.owns.map((x) => `- ${x}`).join('\n')}`,
    r.not_owns.length && `Not yours (hand off to whoever owns it):\n${r.not_owns.map((x) => `- ${x}`).join('\n')}`,
  ].filter(Boolean).join('\n') : '';
  return [card, agent.instructions.trim() ? `=== Your role (${agent.name}) ===\n${agent.instructions.trim()}` : ''].filter(Boolean).join('\n\n');
}
// Sharing (D, 2026-10-09: "owners can set up AI agents with the same settings for the team, or private"): a team agent is for everyone
// with AI access and only the owner changes it; a private one is its maker's alone (any owner or admin can make one).
export const canUseAgent = (a: Agent, uid: number) => a.shared || a.created_by === uid;
export const canEditAgent = (a: Agent, uid: number, role: string) => role === 'owner' || (!a.shared && a.created_by === uid);

export function listAgents(uid?: number): Agent[] {
  ensure();
  const all = (db.prepare('SELECT * FROM ai_agents ORDER BY is_default DESC, id').all() as AgentRow[]).map(toAgent);
  return uid === undefined ? all : all.filter((a) => canUseAgent(a, uid));
}
export function getAgent(id: number | null | undefined): Agent | undefined {
  ensure();
  const r = id ? db.prepare('SELECT * FROM ai_agents WHERE id = ?').get(id) as AgentRow | undefined : undefined;
  return r ? toAgent(r) : undefined;
}
export function defaultAgent(): Agent | undefined {
  ensure();
  const r = db.prepare('SELECT * FROM ai_agents ORDER BY is_default DESC, id LIMIT 1').get() as AgentRow | undefined;
  return r ? toAgent(r) : undefined;
}
export function createAgent(a: AgentInput, by: number | null, isDefault = false): Agent {
  ensure();
  const r = db.prepare(`INSERT INTO ai_agents (name, description, instructions, model, tools, use_memory, starters, icon, color, is_default, shared, created_by, avatar, apps, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.name, a.description, a.instructions, a.model, JSON.stringify(a.tools), a.use_memory ? 1 : 0,
    JSON.stringify(a.starters), a.icon, a.color, isDefault ? 1 : 0, isDefault || a.shared !== false ? 1 : 0, by, a.avatar ?? '', JSON.stringify(a.apps ?? []), JSON.stringify(a.role ?? {}));
  return getAgent(Number(r.lastInsertRowid))!;
}
export function updateAgent(id: number, a: AgentInput): boolean {
  ensure();
  return db.prepare(`UPDATE ai_agents SET name = ?, description = ?, instructions = ?, model = ?, tools = ?, use_memory = ?, starters = ?, icon = ?, color = ?,
    shared = CASE WHEN is_default = 1 THEN 1 ELSE ? END, avatar = COALESCE(?, avatar), apps = COALESCE(?, apps), role = COALESCE(?, role), daily_budget_usd = CASE WHEN ? THEN ? ELSE daily_budget_usd END, night_shift = COALESCE(?, night_shift), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(a.name, a.description, a.instructions, a.model, JSON.stringify(a.tools),
    a.use_memory ? 1 : 0, JSON.stringify(a.starters), a.icon, a.color, a.shared ? 1 : 0, a.avatar ?? null, a.apps ? JSON.stringify(a.apps) : null, a.role ? JSON.stringify(a.role) : null, a.daily_budget_usd !== undefined ? 1 : 0, a.daily_budget_usd ?? null, a.night_shift === undefined ? null : a.night_shift ? 1 : 0, id).changes > 0;
}
/** The default agent stays (every conversation without one runs on it). */
export function deleteAgent(id: number): boolean {
  ensure();
  const ok = db.prepare('DELETE FROM ai_agents WHERE id = ? AND is_default = 0').run(id).changes > 0;
  if (ok) db.prepare('UPDATE ai_threads SET agent_id = NULL WHERE agent_id = ?').run(id);
  return ok;
}

// ─── skills (per login; 'team' ones are shared with every owner and admin) ───
export interface SkillFile { path: string; body: string; updated_at?: string }
export interface Skill { id: number; user_id: number; name: string; title?: string; folder?: string; files?: SkillFile[]; description: string; body: string; share: 'me' | 'team'; agent_id?: number | null; builtin?: boolean; created_at: string; updated_at: string }
export type SkillInput = Pick<Skill, 'name' | 'description' | 'body' | 'share'> & { title?: string; folder?: string; agentId?: number | null };
/** A folder as typed: 'Reports / Weekly' -> 'Reports/Weekly', at most 4 levels of 40 characters. */
export const skillFolder = (v: unknown) => String(v ?? '').split('/').map((x) => x.trim().slice(0, 40)).filter(Boolean).slice(0, 4).join('/');
/** The skills this login sees: its own and the team's (everyone's with `all`: the owner), each with its files; built-ins nobody replaced last. */
export function listSkills(userId: number, all = false): Skill[] {
  ensure();
  const own = db.prepare(`SELECT * FROM ai_skills WHERE ? OR user_id = ? OR share = 'team' ORDER BY name`).all(all ? 1 : 0, userId) as Skill[];
  // shortcut: every file body rides along in the list; fine for tens of skills, page it if skills grow to megabytes
  const files = db.prepare('SELECT skill_id, path, body, updated_at FROM ai_skill_files ORDER BY path').all() as (SkillFile & { skill_id: number })[];
  for (const s of own) s.files = files.filter((f) => f.skill_id === s.id).map(({ path, body, updated_at }) => ({ path, body, updated_at }));
  const taken = new Set(own.map((s) => s.name));
  return [...own, ...SYSTEM_SKILLS.filter((s) => !taken.has(s.name)).map((s, i) => ({ id: -(i + 1), user_id: 0, name: s.name, title: s.title, folder: 'Built in', files: [], description: s.description, body: s.body, share: 'team' as const, builtin: true, created_at: '', updated_at: '' }))];
}
export function getSkill(id: number): Skill | undefined {
  ensure();
  return db.prepare('SELECT * FROM ai_skills WHERE id = ?').get(id) as Skill | undefined;
}
/** Who may change a skill (D, 2026-10-27: "I still can't edit current skills"): its maker; owners and admins any team skill; the owner every skill. */
export function canEditSkill(userId: number, sk: Pick<Skill, 'user_id' | 'share'>, role: string): boolean {
  return sk.user_id === userId || role === 'owner' || (role === 'admin' && sk.share === 'team');
}
export function saveSkill(userId: number, s: SkillInput, id?: number, role = ''): Skill {
  ensure();
  const clash = db.prepare(`SELECT id FROM ai_skills WHERE name = ? AND (user_id = ? OR share = 'team') AND id != ?`).get(s.name, userId, id ?? 0);
  if (clash) throw new Error(`There is already a skill called /${s.name}.`);
  if (id) {
    const cur = getSkill(id);
    if (!cur || !canEditSkill(userId, cur, role)) throw new Error('Only the person who made a skill (or an owner or admin, for team skills) can change it.');
    db.prepare(`UPDATE ai_skills SET name = ?, title = ?, folder = COALESCE(?, folder), description = ?, body = ?, share = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .run(s.name, s.title ?? '', s.folder ?? null, s.description, s.body, s.share, id);
    return getSkill(id)!;
  }
  const r = db.prepare('INSERT INTO ai_skills (user_id, name, title, folder, description, body, share, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(userId, s.name, s.title ?? '', s.folder ?? '', s.description, s.body, s.share, s.agentId ?? null);
  return getSkill(Number(r.lastInsertRowid))!;
}
export function deleteSkill(userId: number, id: number, role = ''): boolean {
  ensure();
  const cur = getSkill(id);
  if (!cur || !canEditSkill(userId, cur, role)) return false;
  db.prepare('DELETE FROM ai_skill_files WHERE skill_id = ?').run(id);
  return db.prepare('DELETE FROM ai_skills WHERE id = ?').run(id).changes > 0;
}
/** A file path inside a skill: up to 4 folders of letters, digits, . _ -; never SKILL.md (that is the skill's own body). '' = not allowed. */
export function skillFilePath(v: unknown): string {
  const p = String(v ?? '').trim().replace(/^\/+|\/+$/g, '');
  const parts = p.split('/');
  if (!p || parts.length > 5 || parts.some((x) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(x) || x === '..') || /^skill\.md$/i.test(p)) return '';
  return p;
}
/** Adds or replaces one file of a skill (renames when `oldPath` differs); the skill's updated time moves with it. */
export function saveSkillFile(userId: number, skillId: number, path: string, body: string, role = '', oldPath?: string): void {
  ensure();
  const cur = getSkill(skillId);
  if (!cur || !canEditSkill(userId, cur, role)) throw new Error('You cannot change this skill\'s files.');
  db.transaction(() => {
    if (oldPath && oldPath !== path) db.prepare('DELETE FROM ai_skill_files WHERE skill_id = ? AND path = ?').run(skillId, oldPath);
    db.prepare(`INSERT INTO ai_skill_files (skill_id, path, body) VALUES (?, ?, ?) ON CONFLICT (skill_id, path) DO UPDATE SET body = excluded.body, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(skillId, path, body);
    db.prepare(`UPDATE ai_skills SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(skillId);
  })();
}
export function deleteSkillFile(userId: number, skillId: number, path: string, role = ''): boolean {
  ensure();
  const cur = getSkill(skillId);
  if (!cur || !canEditSkill(userId, cur, role)) return false;
  return db.prepare('DELETE FROM ai_skill_files WHERE skill_id = ? AND path = ?').run(skillId, path).changes > 0;
}

// The team a new install starts with, seeded once when there are none: a main assistant that hands work to three specialists.
// Edit, add or remove them on Agents; nothing here is tied to a business.
function seedAgents() {
  if ((db.prepare('SELECT COUNT(*) AS n FROM ai_agents').get() as { n: number }).n) return;
  for (const [i, a] of SEED_AGENTS.entries()) createAgent(a, null, i === 0);
}
const MODEL = 'claude-cli:claude-sonnet-5-5';
const SEED_AGENTS: AgentInput[] = [
  {
    name: 'Assistant', description: 'Your main agent: answers, plans, and hands work to the right teammate', icon: 'sparkles', color: 'ink', model: MODEL,
    tools: [], use_memory: true,
    instructions: 'You are the team lead. Answer quick questions yourself. Hand longer research to Researcher, writing to Writer, and recurring jobs, tasks and checks to Operations (hand_off or ask_agent), then tell the person who has it.',
    role: { title: 'Team lead', summary: 'First stop for every request; routes work and keeps the person updated.', owns: ['Quick answers', 'Planning', 'Routing work'], not_owns: ['Long research', 'Long-form writing'] },
    starters: ['What can you and the team do?', 'Plan my week from my tasks', 'Make a routine that sends me a summary every morning'],
  },
  {
    name: 'Researcher', description: 'Digs into a topic and comes back with a sourced brief', icon: 'target', color: 'cobalt', model: MODEL,
    tools: [], use_memory: true,
    instructions: 'Research what you are asked. Check Knowledge and memory first, then the web when you have it. Lead with the answer, give sources for every fact, and say what is still unclear. Use /research-brief for the format.',
    role: { title: 'Researcher', summary: 'Finds and checks facts; writes short sourced briefs.', owns: ['Research', 'Fact checks', 'Comparisons'], not_owns: ['Sending anything'] },
    starters: ['Research a topic for me', 'Compare three tools I am choosing between'],
  },
  {
    name: 'Writer', description: 'Drafts emails, posts, docs and summaries in your voice', icon: 'bolt', color: 'violet', model: MODEL,
    tools: [], use_memory: true,
    instructions: 'Write what you are asked: emails, posts, documents, summaries. Short sentences, plain words, one clear ask. Learn their voice from memory and corrections. Draft only; never send.',
    role: { title: 'Writer', summary: 'Drafts and edits anything written.', owns: ['Emails', 'Posts', 'Docs', 'Summaries'], not_owns: ['Sending or posting'] },
    starters: ['Draft an email for me', 'Summarize this file'],
  },
  {
    name: 'Operations', description: 'Runs the routines, the task board and the checks', icon: 'robot', color: 'green', model: MODEL,
    tools: [], use_memory: true,
    instructions: 'You keep things running: make and fix routines, work the task board, check the Inbox, and report what failed and why. Ask before anything that sends a message or changes an outside app.',
    role: { title: 'Operations', summary: 'Owns routines, tasks and the morning and weekly reports.', owns: ['Routines', 'Task board', 'Reports'], not_owns: ['Research', 'Writing'] },
    starters: ['What failed this week?', 'Set up a weekly review routine'],
  },
];

// ─── agent memory (D, 2026-10-12) ───
/** An agent's notebook notes, newest first (stale ones only with `withStale`). */
export function agentNotes(agentId: number, withStale = false): Note[] {
  ensure();
  return db.prepare(`SELECT id, content, created_at, stale FROM ai_memory WHERE agent_id = ? AND kind = 'note'${withStale ? '' : ' AND stale = 0'} ORDER BY id DESC LIMIT 200`).all(agentId) as Note[];
}
/** An agent's daily logs, newest day first. */
export function agentLogs(agentId: number, limit = 30): Note[] {
  ensure();
  return db.prepare("SELECT id, content, created_at, day FROM ai_memory WHERE agent_id = ? AND kind = 'log' ORDER BY day DESC, id DESC LIMIT ?").all(agentId, limit) as Note[];
}
export function addAgentNote(agentId: number, userId: number, content: string, threadId: number | null, kind: 'note' | 'log' = 'note', day = ''): number {
  ensure();
  const text = content.trim().slice(0, kind === 'log' ? 8000 : 1000);
  if (!text) throw new Error('Note is empty.');
  return Number(db.prepare('INSERT INTO ai_memory (user_id, content, thread_id, agent_id, kind, day) VALUES (?, ?, ?, ?, ?, ?)').run(userId, text, threadId, agentId, kind, day).lastInsertRowid);
}
export function deleteAgentNote(id: number, agentId?: number): boolean {
  ensure();
  return agentId ? db.prepare('DELETE FROM ai_memory WHERE id = ? AND agent_id = ?').run(id, agentId).changes > 0
    : db.prepare('DELETE FROM ai_memory WHERE id = ? AND agent_id IS NOT NULL').run(id).changes > 0;
}
export function editAgentNote(id: number, content: string): boolean {
  ensure();
  const text = content.trim().slice(0, 1000);
  if (!text) throw new Error('Note is empty.');
  return db.prepare("UPDATE ai_memory SET content = ?, stale = 0 WHERE id = ? AND agent_id IS NOT NULL AND kind = 'note'").run(text, id).changes > 0;
}
/** Flags notes stale (the nightly pass) or clears the flag (Keep). Agent notes of `agentId`, or one login's own notes. */
export function setStale(ids: number[], stale: boolean, owner: { agentId: number } | { userId: number }): number {
  ensure();
  let n = 0;
  const q = 'agentId' in owner ? db.prepare("UPDATE ai_memory SET stale = ? WHERE id = ? AND agent_id = ? AND kind = 'note'")
    : db.prepare('UPDATE ai_memory SET stale = ? WHERE id = ? AND user_id = ? AND agent_id IS NULL');
  for (const id of ids) n += q.run(stale ? 1 : 0, id, 'agentId' in owner ? owner.agentId : owner.userId).changes;
  return n;
}
/** The agent a conversation belongs to (its own, else the default agent). */
export function threadAgentId(threadId: number): number | null {
  ensure();
  const r = db.prepare('SELECT agent_id FROM ai_threads WHERE id = ?').get(threadId) as { agent_id: number | null } | undefined;
  return r?.agent_id ?? defaultAgent()?.id ?? null;
}
/** The notebook block for an agent's system prompt: its notes and its last three daily logs. */
export const CORE_MAX = 1500;
export function getCore(agentId: number): string {
  ensure();
  return (db.prepare('SELECT body FROM ai_agent_core WHERE agent_id = ?').get(agentId) as { body: string } | undefined)?.body ?? '';
}
export function putCore(agentId: number, body: string) {
  ensure();
  db.prepare(`INSERT INTO ai_agent_core (agent_id, body) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET body = excluded.body, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`)
    .run(agentId, body.trim().slice(0, CORE_MAX));
}
export function notebookPrompt(agent: { id: number; name: string } | undefined): string {
  if (!agent) return '';
  const notes = agentNotes(agent.id).slice(0, 100), logs = agentLogs(agent.id, 3), core = getCore(agent.id);
  return [
    `=== Always remember (${agent.name}) ===`,
    core || '(empty)',
    `Your short core profile: the few things that matter in every conversation (who you work for and how, the rules you must never get wrong). Keep it under ${CORE_MAX} characters; change it with core_memory_append or core_memory_replace only for something lasting.`,
    `=== Your notebook (${agent.name}) ===`,
    'What you have learned about this agency, shared by everyone who uses you. When you learn something lasting about the agency, its rules, its people or how its data works (not a personal preference), save it with note_for_agent; remove a note that turns out wrong with forget_agent_note. Personal preferences of the person you talk with go to remember.',
    notes.length ? `Notes (id: note):\n${notes.map((n) => `- ${n.id}: ${n.content}`).join('\n')}` : 'Notes: none yet.',
    // lessons from people's corrections (lib/ai/lessons.ts, D 2026-10-28): rules to follow every time
    ((ls: { content: string }[]) => ls.length ? `=== Lessons (${agent.name}) ===\nRules people taught you by correcting you. Follow them every time; they win over your own habits.\n${ls.map((l) => `- ${l.content}`).join('\n')}` : '')(
      db.prepare("SELECT content FROM ai_memory WHERE agent_id = ? AND kind = 'lesson' AND stale = 0 ORDER BY id DESC LIMIT 40").all(agent.id) as { content: string }[]),
    goalsPrompt(agent.id, agent.name), // its own goals (lib/ai/goals.ts)
    // daily logs stay out of prompts (D, 2026-10-13): they sum up people's conversations; owners read them on AI › Memory
    void logs,
  ].filter(Boolean).join('\n\n');
}
/** Nightly memory pass bookkeeping: the day it last covered. */
export function memoryRunDone(day: string): boolean { ensure(); return !!db.prepare('SELECT 1 FROM ai_memory_runs WHERE day = ?').get(day); }
export function markMemoryRun(day: string, summary: string) { ensure(); db.prepare('INSERT OR REPLACE INTO ai_memory_runs (day, summary) VALUES (?, ?)').run(day, summary.slice(0, 2000)); }
export function lastMemoryRun(): { day: string; at: string; summary: string } | undefined { ensure(); return db.prepare('SELECT * FROM ai_memory_runs ORDER BY day DESC LIMIT 1').get() as never; }
/** One day's messages of an agent's conversations (UTC bounds), oldest first, with who wrote them. */
export function agentDayMessages(agentId: number, fromIso: string, toIso: string): { thread_id: number; title: string; user_id: number; username: string; role: string; text: string; created_at: string }[] {
  ensure();
  return db.prepare(`SELECT m.thread_id, t.title, t.user_id, COALESCE(u.username, '') AS username, m.role, m.text, m.created_at
    FROM ai_messages m JOIN ai_threads t ON t.id = m.thread_id LEFT JOIN users u ON u.id = t.user_id
    WHERE t.agent_id = ? AND m.created_at >= ? AND m.created_at < ? ORDER BY m.id`).all(agentId, fromIso, toIso) as never;
}
