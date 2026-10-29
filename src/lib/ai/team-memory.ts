import 'server-only';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { getGrant } from '@/lib/user-access';
import { botToken } from '@/lib/slack/app';
import { botChannels, channelDayLines } from '@/lib/slack/read';
import { reportTz } from '@/lib/report-tz';
import { todayIn } from '@/lib/sales-range';
import { acquireLease, releaseLease } from './routines';
import { dot, embed, embedTag, fromBlob, rerank, simFloor, toBlob } from './embed-local';
import { overlaps, timeWindow, type TimeWindow } from './time-window';
import { agencySecretValues } from '@/lib/agency-secrets';
import { graphCards, edgesFor, ensureGraph as ensureGraphTables, entitiesIn, getProfile, linkChunk, linkedChunks, neighbours, refreshEntities, relinkAll } from './team-graph';
import { envSecrets, redactSecrets, secretNeedles } from './tool-guard';

// Team memory (D, 2026-10-22: "a unified memory ... any decisions being made"; "ingest things like we do in CTRL Flow"). One memory per
// agency, read by every agent of the owner and admins (never managers, clients or reps: it holds leadership decisions and Slack):
//  - ai_team_memory: decisions and lasting facts the nightly pass (memory-nightly.ts) takes from owner and admin conversations, with who
//    and when;
//  - ai_mem_chunks: what is ingested every 30 min (owner and admin AI chats, Slack channels the bot is in, call reviews, Knowledge),
//    pieces of at most 1,500 characters, searched by words (SQLite FTS5) and by meaning (local bge-small vectors, cosine in JS: a few
//    thousand pieces at agency scale), merged by reciprocal rank.
// Recall (recallFor) runs before every owner/admin turn with a 2.5 s budget; the search_memory tool digs deeper on demand.
const PIECE = 1500, OVERLAP = 200, BODY_MAX = 6000;
const INGEST_EVERY_MS = 30 * 60_000;
const SLACK_FIRST_DAYS = 14;
export const RECALL_MS = Number(process.env.TEAM_RECALL_MS || 2500);
const RECALL_CHARS = 6000;
// rerank pool and time (phase 2); a decision gets a small lift among near-equal scores (cross-encoder logits run about -11 to +11)
const POOL = 40, RERANK_MS = Number(process.env.TEAM_RERANK_MS || 1200), TEAM_BOOST = 1;

const ready = schemaOnce(); // per agency database
function ensure() {
  if (ready.done()) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_team_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, content TEXT NOT NULL, who TEXT NOT NULL DEFAULT '', day TEXT NOT NULL DEFAULT '',
      thread_id INTEGER, agent_id INTEGER, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE IF NOT EXISTS ai_mem_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL, vec BLOB, vec_hash TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), UNIQUE (kind, ref));
    CREATE VIRTUAL TABLE IF NOT EXISTS ai_mem_fts USING fts5(title, body, content='ai_mem_chunks', content_rowid='id', tokenize='porter unicode61');
    CREATE TRIGGER IF NOT EXISTS ai_mem_ai AFTER INSERT ON ai_mem_chunks BEGIN INSERT INTO ai_mem_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
    CREATE TRIGGER IF NOT EXISTS ai_mem_ad AFTER DELETE ON ai_mem_chunks BEGIN INSERT INTO ai_mem_fts(ai_mem_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); END;
    CREATE TRIGGER IF NOT EXISTS ai_mem_au AFTER UPDATE OF title, body ON ai_mem_chunks BEGIN
      INSERT INTO ai_mem_fts(ai_mem_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
      INSERT INTO ai_mem_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
    CREATE TABLE IF NOT EXISTS ai_mem_state (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS ai_team_commitments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, who TEXT NOT NULL DEFAULT '', what TEXT NOT NULL, due TEXT NOT NULL DEFAULT '', day TEXT NOT NULL DEFAULT '',
      thread_id INTEGER, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE IF NOT EXISTS ai_team_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id INTEGER NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
      who TEXT NOT NULL DEFAULT '', valid_from TEXT NOT NULL DEFAULT '', valid_to TEXT NOT NULL DEFAULT '')`);
  // timeline (D, 2026-10-23: "as of" questions): when a decision was true; a piece's own end day (past decisions)
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols('ai_team_memory').includes('valid_to')) db.exec("ALTER TABLE ai_team_memory ADD COLUMN valid_to TEXT NOT NULL DEFAULT ''");
  if (!cols('ai_mem_chunks').includes('until')) db.exec("ALTER TABLE ai_mem_chunks ADD COLUMN until TEXT NOT NULL DEFAULT ''");
  // private memory per agent (D 2026-10-28): a piece with an agent id is recalled only for that agent (null = shared)
  if (!cols('ai_mem_chunks').includes('agent_id')) db.exec('ALTER TABLE ai_mem_chunks ADD COLUMN agent_id INTEGER');
  // insights (memory-layers.ts, D 2026-10-23): the sources that show one, and how sure the nightly pass is
  if (!cols('ai_team_memory').includes('evidence')) db.exec("ALTER TABLE ai_team_memory ADD COLUMN evidence TEXT NOT NULL DEFAULT '[]'");
  if (!cols('ai_team_memory').includes('confidence')) db.exec('ALTER TABLE ai_team_memory ADD COLUMN confidence REAL');
  ready.mark();
  ensureGraphTables();
}
const state = (k: string) => (db.prepare('SELECT value FROM ai_mem_state WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? '';
const setState = (k: string, v: string) => db.prepare('INSERT INTO ai_mem_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

/** Only the owner and admins have team memory. */
export const hasTeamMemory = (userId: number) => ['owner', 'admin'].includes(getGrant(userId).role);

// ─── team decisions and facts ───

export interface TeamItem { id: number; kind: string; content: string; who: string; day: string; thread_id: number | null; status: string; valid_to?: string; evidence?: string; confidence?: number | null }
const today = () => todayIn(reportTz());
export function addTeamItem(a: { kind: 'decision' | 'fact' | 'insight'; content: string; who: string; day: string; threadId?: number | null; agentId?: number | null }): number | null {
  ensure();
  const content = a.content.trim().slice(0, 600);
  if (!content || db.prepare("SELECT 1 FROM ai_team_memory WHERE content = ? AND status = 'active'").get(content)) return null;
  return Number(db.prepare('INSERT INTO ai_team_memory (kind, content, who, day, thread_id, agent_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(a.kind, content, a.who.slice(0, 80), a.day, a.threadId ?? null, a.agentId ?? null).lastInsertRowid);
}
export function listTeamItems(limit = 60): TeamItem[] {
  ensure();
  return db.prepare("SELECT id, kind, content, who, day, thread_id, status FROM ai_team_memory WHERE status = 'active' ORDER BY id DESC LIMIT ?").all(limit) as TeamItem[];
}
/** Every item for the Memory page: active first, then stale (newest first). */
export function allTeamItems(): TeamItem[] {
  ensure();
  return db.prepare("SELECT id, kind, content, who, day, thread_id, status, valid_to, evidence, confidence FROM ai_team_memory WHERE status IN ('active', 'stale') ORDER BY status = 'stale', id DESC").all() as TeamItem[];
}
/** Memory page edits (owner and admins): search sees them at once, not at the next pass. */
export function editTeamItem(id: number, content: string): boolean {
  ensure();
  const c = content.trim().slice(0, 600);
  if (!c) throw new Error('Write the decision or fact.');
  const cur = db.prepare('SELECT kind, content, who, day FROM ai_team_memory WHERE id = ?').get(id) as { kind: string; content: string; who: string; day: string } | undefined;
  if (!cur) return false;
  if (cur.content === c) return true;
  // the old wording stays, true from its day until today: "as of" questions still find it (timeline)
  db.prepare('INSERT INTO ai_team_versions (team_id, kind, content, who, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?)').run(id, cur.kind, cur.content, cur.who, cur.day, today());
  db.prepare('UPDATE ai_team_memory SET content = ?, day = ? WHERE id = ?').run(c, today(), id);
  syncTeam();
  return true;
}
export function setTeamStatus(id: number, status: 'active' | 'stale'): boolean {
  ensure();
  const ok = db.prepare("UPDATE ai_team_memory SET status = ?, valid_to = ? WHERE id = ? AND status IN ('active', 'stale')").run(status, status === 'stale' ? today() : '', id).changes > 0;
  if (ok) syncTeam();
  return ok;
}
export function deleteTeamItem(id: number): boolean {
  ensure();
  const ok = db.prepare('DELETE FROM ai_team_memory WHERE id = ?').run(id).changes > 0;
  if (ok) syncTeam();
  return ok;
}
/** Team items into the search store now (pieces only: their vectors follow on the next tick). */
export function syncTeam(): void {
  for (const [kind, src] of [['team', teamSources()], ['team_past', pastSources()]] as const) {
    for (const s of src) upsert(s);
    prune(kind, new Set(src.map((s) => s.ref)));
  }
}
/** What is in team memory, per kind, and when the last pass ran. */
export function teamStats(): { kinds: { kind: string; pieces: number; embedded: number }[]; lastIngest: number } {
  ensure();
  return { kinds: db.prepare('SELECT kind, count(*) pieces, sum(vec IS NOT NULL AND vec_hash = hash || ?) embedded FROM ai_mem_chunks GROUP BY kind ORDER BY pieces DESC').all(embedTag()) as never, lastIngest: Number(state('last_ingest') || 0) };
}

export function retireTeamItems(ids: number[]): number {
  ensure();
  let n = 0;
  for (const id of ids) n += db.prepare("UPDATE ai_team_memory SET status = 'stale', valid_to = ? WHERE id = ? AND status = 'active'").run(today(), id).changes;
  return n;
}

// ─── commitments (phase 2): promises made in owner/admin conversations ("I'll send Alex the list by Friday"), found by the nightly pass ───

export interface Commitment { id: number; who: string; what: string; due: string; day: string; thread_id: number | null; status: string }
export function addCommitment(a: { who: string; what: string; due?: string; day: string; threadId?: number | null }): number | null {
  ensure();
  const what = a.what.trim().slice(0, 400);
  if (!what || db.prepare("SELECT 1 FROM ai_team_commitments WHERE what = ? AND status = 'open'").get(what)) return null;
  return Number(db.prepare('INSERT INTO ai_team_commitments (who, what, due, day, thread_id) VALUES (?, ?, ?, ?, ?)')
    .run(a.who.slice(0, 80), what, /^\d{4}-\d{2}-\d{2}$/.test(a.due ?? '') ? a.due : '', a.day, a.threadId ?? null).lastInsertRowid);
}
/** Open first (soonest due first), then the last 30 done. */
export function listCommitments(): Commitment[] {
  ensure();
  return [...db.prepare("SELECT id, who, what, due, day, thread_id, status FROM ai_team_commitments WHERE status = 'open' ORDER BY due = '', due, id").all() as Commitment[],
    ...db.prepare("SELECT id, who, what, due, day, thread_id, status FROM ai_team_commitments WHERE status = 'done' ORDER BY id DESC LIMIT 30").all() as Commitment[]];
}
export function setCommitment(id: number, status: 'open' | 'done'): boolean {
  ensure();
  const ok = db.prepare('UPDATE ai_team_commitments SET status = ? WHERE id = ?').run(status, id).changes > 0;
  if (ok) syncCommitments();
  return ok;
}
export function deleteCommitment(id: number): boolean {
  ensure();
  const ok = db.prepare('DELETE FROM ai_team_commitments WHERE id = ?').run(id).changes > 0;
  if (ok) syncCommitments();
  return ok;
}
function commitmentSources(): Src[] {
  return (db.prepare("SELECT id, who, what, due, day FROM ai_team_commitments WHERE status = 'open'").all() as Commitment[])
    .map((c) => ({ kind: 'commitment', ref: `commitment:${c.id}`, title: `Open commitment${c.who ? ` by ${c.who}` : ''}${c.due ? `, due ${c.due}` : ''}${c.day ? ` (said ${c.day})` : ''}`, body: c.what, at: c.day }));
}
export function syncCommitments(): void {
  const src = commitmentSources();
  for (const x of src) upsert(x);
  prune('commitment', new Set(src.map((x) => x.ref)));
}

// ─── ingest ───

type Src = { kind: string; ref: string; title: string; body: string; at: string; until?: string; agentId?: number | null };
/** A text in pieces of at most PIECE characters, cut at line or sentence ends, with OVERLAP characters carried over. */
export function pieces(text: string): string[] {
  const t = text.slice(0, BODY_MAX * 4);
  if (t.length <= PIECE) return [t];
  const out: string[] = [];
  for (let i = 0; i < t.length;) {
    let end = Math.min(t.length, i + PIECE);
    if (end < t.length) { const cut = Math.max(t.lastIndexOf('\n', end), t.lastIndexOf('. ', end)); if (cut > i + PIECE / 2) end = cut + 1; }
    out.push(t.slice(i, end).trim());
    if (end >= t.length) break;
    i = Math.max(end - OVERLAP, i + 1);
  }
  return out.filter(Boolean);
}

/** Writes one source as pieces (ref#0, ref#1 ...): only changed pieces are rewritten (and so re-embedded); pieces past the end are removed. */
// never a key, token or password in memory (the nightly pass scrubs the same way)
let needles: string[] | null = null;
const scrub = (t: string) => { needles ??= secretNeedles({ ...envSecrets(), ...agencySecretValues() }); return redactSecrets(t, needles).text; };

function upsert(s: Src): number {
  const parts = pieces(scrub(s.body));
  let changed = 0;
  parts.forEach((body, i) => {
    // the end day only counts when there is one (past decisions): every other piece keeps its hash, so nothing re-embeds
    const ref = `${s.ref}#${i}`, hash = sha(`${s.until ? `${s.title}\n${body}\n${s.until}` : `${s.title}\n${body}`}${s.agentId ? `\n@${s.agentId}` : ''}`);
    const cur = db.prepare('SELECT id, hash FROM ai_mem_chunks WHERE kind = ? AND ref = ?').get(s.kind, ref) as { id: number; hash: string } | undefined;
    if (cur?.hash === hash) return;
    if (cur) db.prepare("UPDATE ai_mem_chunks SET title = ?, body = ?, at = ?, until = ?, hash = ?, agent_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(s.title, body, s.at, s.until ?? '', hash, s.agentId ?? null, cur.id);
    const id = cur?.id ?? Number(db.prepare('INSERT INTO ai_mem_chunks (kind, ref, title, body, at, until, hash, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(s.kind, ref, s.title, body, s.at, s.until ?? '', hash, s.agentId ?? null).lastInsertRowid);
    linkChunk(id, `${s.title}\n${body}`); // the reps and contracts it names (team-graph.ts)
    changed++;
  });
  const extra = db.prepare("SELECT id, ref FROM ai_mem_chunks WHERE kind = ? AND ref LIKE ? ESCAPE '\\'").all(s.kind, `${s.ref.replace(/[%_\\]/g, '\\$&')}#%`) as { id: number; ref: string }[];
  for (const r of extra) if (Number(r.ref.slice(r.ref.lastIndexOf('#') + 1)) >= parts.length) { db.prepare('DELETE FROM ai_mem_chunks WHERE id = ?').run(r.id); db.prepare('DELETE FROM ai_mem_links WHERE chunk_id = ?').run(r.id); changed++; }
  return changed;
}
/** A full listing of a kind: sources no longer listed go (their pieces and vectors). */
function prune(kind: string, refs: Set<string>): number {
  let n = 0;
  for (const r of db.prepare('SELECT id, ref FROM ai_mem_chunks WHERE kind = ?').all(kind) as { id: number; ref: string }[]) {
    if (!refs.has(r.ref.slice(0, r.ref.lastIndexOf('#')))) { db.prepare('DELETE FROM ai_mem_chunks WHERE id = ?').run(r.id); db.prepare('DELETE FROM ai_mem_links WHERE chunk_id = ?').run(r.id); n++; }
  }
  return n;
}

function leaders(): Map<number, string> {
  const out = new Map<number, string>();
  for (const u of db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[]) if (hasTeamMemory(u.id)) out.set(u.id, u.username);
  return out;
}

/** Owner and admin AI conversations: one source per conversation, its last 30 messages. */
function chatSources(): Src[] {
  const who = leaders();
  if (!who.size) return [];
  const ids = [...who.keys()];
  // an agent's own WhatsApp conversations (lib/wa/inbound.ts ai_wa_threads) stay that agent's: private pieces
  const wa = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_wa_threads'").get() ? 'EXISTS (SELECT 1 FROM ai_wa_threads w WHERE w.thread_id = t.id)' : '0';
  const threads = db.prepare(`SELECT t.id, t.user_id, t.title, t.updated_at, t.agent_id, ${wa} AS private, a.name agent FROM ai_threads t LEFT JOIN ai_agents a ON a.id = t.agent_id
    WHERE t.user_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number; user_id: number; title: string; updated_at: string; agent_id: number | null; private: number; agent: string | null }[];
  return threads.map((t) => {
    const msgs = (db.prepare('SELECT role, text FROM ai_messages WHERE thread_id = ? ORDER BY id DESC LIMIT 30').all(t.id) as { role: string; text: string }[]).reverse();
    const body = msgs.map((m) => `${m.role === 'user' ? who.get(t.user_id) : t.agent ?? 'the AI'}: ${m.text.slice(0, 1500)}`).join('\n').slice(-BODY_MAX);
    return { kind: 'chat', ref: `thread:${t.id}`, title: `AI chat with ${who.get(t.user_id)}: ${t.title}`, body, at: t.updated_at.slice(0, 10), agentId: t.private ? t.agent_id : null };
  }).filter((s) => s.body.trim());
}

function kbSources(): Src[] {
  // a fresh install has no Knowledge table until someone opens Knowledge or Wiki
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kb_docs'").get()) return [];
  return (db.prepare('SELECT id, space, folder, title, body, updated_at FROM kb_docs').all() as { id: number; space: string; folder: string; title: string; body: string; updated_at: string }[])
    .filter((d) => d.body.trim())
    .map((d) => ({ kind: 'kb', ref: `kb:${d.id}`, title: `${d.space === 'wiki' ? 'Wiki' : 'Knowledge'}: ${[d.folder, d.title].filter(Boolean).join(' / ')}`, body: d.body, at: d.updated_at.slice(0, 10) }));
}

const dayBefore = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
/** Slack channels the bot is in: one source per channel per day; the first pass reads SLACK_FIRST_DAYS back, later passes today and yesterday. */
async function slackSources(): Promise<Src[]> {
  const token = botToken();
  if (!token) return [];
  const today = todayIn(reportTz()), first = !state('slack_first_done');
  const days = Array.from({ length: first ? SLACK_FIRST_DAYS : 2 }, (_, i) => dayBefore(today, i));
  const out: Src[] = [];
  let failed = 0;
  for (const ch of await botChannels(token)) {
    for (const day of days) {
      // paced under Slack's history limit (about 50 a minute); a refused day is read again next pass
      await new Promise((ok) => setTimeout(ok, 1300));
      const lines = await channelDayLines(token, ch.id, day).catch(() => { failed++; return [] as string[]; });
      if (lines.length) out.push({ kind: 'slack', ref: `slack:${ch.id}:${day}`, title: `Slack #${ch.name} ${day}`, body: lines.join('\n'), at: day });
    }
  }
  if (first && !failed) setState('slack_first_done', today);
  return out;
}

function teamSources(): Src[] {
  return listTeamItems(2000).map((t) => ({ kind: 'team', ref: `team:${t.id}`, title: `Team ${t.kind}${t.day ? ` ${t.day}` : ''}${t.who ? ` (${t.who})` : ''}`, body: t.content, at: t.day }));
}
/** Decisions no longer true (retired) and the old wordings of edited ones, with the days they were true: found only by "as of" questions. */
function pastSources(): Src[] {
  const retired = (db.prepare("SELECT id, kind, content, who, day, valid_to FROM ai_team_memory WHERE status = 'stale'").all() as TeamItem[])
    .map((t) => ({ kind: 'team_past', ref: `past:${t.id}`, title: `Earlier team ${t.kind}, true ${t.day || '?'} to ${t.valid_to || '?'}${t.who ? ` (${t.who})` : ''}`, body: t.content, at: t.day, until: t.valid_to ?? '' }));
  const versions = (db.prepare('SELECT id, kind, content, who, valid_from, valid_to FROM ai_team_versions').all() as { id: number; kind: string; content: string; who: string; valid_from: string; valid_to: string }[])
    .map((v) => ({ kind: 'team_past', ref: `version:${v.id}`, title: `Earlier wording of a team ${v.kind}, true ${v.valid_from || '?'} to ${v.valid_to || '?'}${v.who ? ` (${v.who})` : ''}`, body: v.content, at: v.valid_from, until: v.valid_to }));
  return [...retired, ...versions];
}

/** One ingest pass over every source, then embeds what changed (20 s at most). Returns a one-line summary. */
export async function ingestNow(): Promise<string> {
  ensure();
  const counts: string[] = [];
  const entitiesChanged = refreshEntities(); // the roster or contracts changed: every piece is relinked below
  const full = async (kind: string, list: Src[] | Promise<Src[]>) => {
    const src = await list;
    let changed = 0;
    for (const s of src) changed += upsert(s);
    changed += prune(kind, new Set(src.map((s) => s.ref)));
    counts.push(`${kind} ${src.length} (${changed} changed)`);
  };
  await full('chat', chatSources());
  await full('kb', kbSources());
  await full('team', teamSources());
  await full('team_past', pastSources());
  await full('commitment', commitmentSources());
  // conversation summaries (memory-layers.ts): quiet owner and admin conversations get one, then they are searched like the rest
  const layers = await import('./memory-layers'); // it imports this file
  const summed = await layers.summarizeIdle().catch(() => 0);
  await full('summary', layers.summarySources());
  if (summed) counts.push(`summarised ${summed}`);
  // windows: older days and calls are kept, never pruned by a pass that did not list them
  const slack = await slackSources().catch((e: unknown) => { counts.push(`slack failed: ${e instanceof Error ? e.message : String(e)}`); return [] as Src[]; });
  let sl = 0; for (const s of slack) sl += upsert(s); if (slack.length) counts.push(`slack ${slack.length} (${sl} changed)`);
  if (entitiesChanged) counts.push(`relinked ${relinkAll()}`);
  counts.push(`embedded ${await embedPending(20_000)}`);
  return counts.join(' · ');
}

/** Embeds pieces whose vector is missing or stale, 8 at a time, until `budgetMs` runs out. */
export async function embedPending(budgetMs: number): Promise<number> {
  ensure();
  const until = Date.now() + budgetMs;
  let n = 0;
  while (Date.now() < until) {
    // vec_hash = the text's hash plus the model's tag (embed-local.ts embedTag): a new model re-embeds everything, the paid one 32 at a time
    const tag = embedTag();
    const rows = db.prepare('SELECT id, title, body, hash FROM ai_mem_chunks WHERE vec IS NULL OR vec_hash <> hash || ? LIMIT ?').all(tag, tag ? 32 : 8) as { id: number; title: string; body: string; hash: string }[];
    if (!rows.length) break;
    const v = await embed(rows.map((r) => `${r.title}\n${r.body}`), 'doc');
    if (!v) break; // no model: words only for now
    rows.forEach((r, i) => db.prepare('UPDATE ai_mem_chunks SET vec = ?, vec_hash = ? WHERE id = ?').run(toBlob(v[i]), r.hash + tag, r.id));
    n += rows.length;
  }
  if (n) vecCache = null;
  return n;
}

let ingesting = false;
/** From the routine clock (only the copy holding the lease ticks): a pass every 30 minutes. Never throws. */
export async function teamMemoryTick(holder: string, now = Date.now()): Promise<void> {
  if (ingesting || (process.env.TEAM_MEMORY || '').toLowerCase() === 'off') return;
  ensure();
  if (now - Number(state('last_ingest') || 0) < INGEST_EVERY_MS) {
    // between passes: a backlog of pieces without vectors (the first pass, a big Slack day) is embedded 10 s per tick
    if (db.prepare('SELECT 1 FROM ai_mem_chunks WHERE vec IS NULL OR vec_hash <> hash || ? LIMIT 1').get(embedTag()) && acquireLease('team-memory', holder, 15 * 60_000, now)) {
      ingesting = true;
      try { await embedPending(10_000); } catch (e) { console.warn(`[team-memory] embed failed: ${e instanceof Error ? e.message : String(e)}`); }
      finally { ingesting = false; releaseLease('team-memory', holder); } // given back: a restarted copy never waits out a dead holder's 15 min
    }
    return;
  }
  if (!acquireLease('team-memory', holder, 15 * 60_000, now)) return;
  ingesting = true;
  try {
    setState('last_ingest', String(now));
    console.log(`[team-memory] ${await ingestNow()}`);
  } catch (e) { console.warn(`[team-memory] ingest failed: ${e instanceof Error ? e.message : String(e)}`); }
  finally { ingesting = false; releaseLease('team-memory', holder); }
}

// ─── search ───

let vecCache: { key: string; ids: number[]; vecs: Float32Array[]; team: Set<number> } | null = null;
function vectors() {
  const tag = embedTag();
  const key = tag + JSON.stringify(db.prepare('SELECT count(*) n, max(updated_at) m, sum(length(vec)) v FROM ai_mem_chunks WHERE vec IS NOT NULL').get());
  if (vecCache?.key === key) return vecCache;
  const rows = db.prepare('SELECT id, kind, vec FROM ai_mem_chunks WHERE vec IS NOT NULL AND vec_hash = hash || ?').all(tag) as { id: number; kind: string; vec: Buffer }[];
  vecCache = { key, ids: rows.map((r) => r.id), vecs: rows.map((r) => new Float32Array(fromBlob(r.vec))), team: new Set(rows.filter((r) => r.kind === 'team').map((r) => r.id)) };
  return vecCache;
}

/** Words of a query as an FTS5 OR-query (quoted, so punctuation never breaks it). */
export function ftsQuery(q: string): string {
  const words = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []))].filter((w) => !STOP.has(w)).slice(0, 24);
  return words.map((w) => `"${w}"`).join(' OR ');
}
const STOP = new Set('we us me my of to in on at is it an as be by do if no or so up the and for are but not you all any can had her was one our out has him his how its may new now old see two way who did get got let put say she too use what when where which why with this that from they them then than there their about would could should will just like into your yours have been were some more also only very much each other over such'.split(' '));

export interface Hit { id: number; kind: string; title: string; body: string; at: string; score: number; until?: string }
/** Words and meaning, merged by reciprocal rank; team decisions first among near-ties. `waitMs` caps the query vector's wait. */
/** `agentId`: undefined = every piece (the Memory page); a number or null = shared pieces plus that agent's own (private memory). */
export async function searchMemory(q: string, limit = 8, waitMs = RECALL_MS, agentId?: number | null): Promise<Hit[]> {
  ensure();
  const deadline = Date.now() + waitMs;
  const rank = new Map<number, number>();
  const add = (ids: number[]) => ids.forEach((id, i) => rank.set(id, (rank.get(id) ?? 0) + 1 / (60 + i)));
  // timeline: a question that names a time ("as of Oct 10", "last week", "in September") is answered from that time only (time-window.ts)
  const win = timeWindow(q, today());
  if (win) {
    // what was true then: decisions in force then (current and earlier ones) and the pieces dated in the window
    add((db.prepare(`SELECT id FROM ai_mem_chunks WHERE kind IN ('team', 'team_past') AND (at = '' OR at <= ?) AND (until = '' OR until >= ?)`).all(win.to, win.from) as { id: number }[]).map((r) => r.id).slice(0, 15));
    const fqw = ftsQuery(q.replace(/\b(as of|as at|before|since|after|until|last|this|week|month|year|ago|yesterday|in|on)\b/gi, ' '));
    if (fqw) add((db.prepare(`SELECT f.rowid id FROM ai_mem_fts f JOIN ai_mem_chunks c ON c.id = f.rowid WHERE ai_mem_fts MATCH ? AND c.at BETWEEN ? AND ? ORDER BY bm25(ai_mem_fts) LIMIT 30`).all(fqw, win.from, win.to) as { id: number }[]).map((r) => r.id));
  }
  // a rep or contract the question names: its newest linked pieces join the pool (team-graph.ts)
  const named = entitiesIn(q);
  add(linkedChunks(named.map((e) => e.id), 20));
  // and pieces about the entities they are related to (one hop on the relationship graph)
  add(linkedChunks(neighbours(named.map((e) => e.id)), 10));
  const fq = ftsQuery(q);
  if (fq) add((db.prepare('SELECT rowid id FROM ai_mem_fts WHERE ai_mem_fts MATCH ? ORDER BY bm25(ai_mem_fts) LIMIT 30').all(fq) as { id: number }[]).map((r) => r.id));
  const qv = (await embed([q.slice(0, 2000)], 'query', Math.max(50, Math.min(1500, deadline - Date.now()))))?.[0];
  const { ids, vecs, team } = vectors();
  if (qv && (!vecs.length || vecs[0].length === qv.length)) { // one model's vectors only (a key added or failing mid-turn)
    const sims = ids.map((id, i) => ({ id, s: dot(vecs[i], qv) }));
    add(sims.filter((x) => x.s > simFloor()).sort((a, b) => b.s - a.s).slice(0, 30).map((x) => x.id));
    // the closest decisions always reach the rerank pool (a common word like "reps" let wiki pages crowd one out, 2026-10-23)
    add(sims.filter((x) => team.has(x.id)).sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.id));
  }
  if (!rank.size) return [];
  const top = [...rank.entries()].sort((a, b) => b[1] - a[1]).slice(0, POOL * 2);
  const mine = agentId === undefined ? '' : ` AND (agent_id IS NULL${agentId ? ` OR agent_id = ${Number(agentId)}` : ''})`;
  const rows = new Map((db.prepare(`SELECT id, kind, ref, title, body, at, until FROM ai_mem_chunks WHERE id IN (${top.map(() => '?').join(',')})${mine}`).all(...top.map((t) => t[0])) as (Omit<Hit, 'score'> & { ref: string })[])
    // no time named: what is true now (earlier decisions stay out); a time named: only what was true or said then
    .filter((r) => (win ? inWindow(r, win) : r.kind !== 'team_past')).map((r) => [r.id, r]));
  // the best piece of each source only: eight hits are eight different things
  const seen = new Set<string>(), pool: Hit[] = [];
  for (const [id, score] of top.map(([id, s]) => [id, s + (rows.get(id)?.kind === 'team' ? 0.002 : 0)] as const).sort((a, b) => b[1] - a[1])) {
    const r = rows.get(id);
    if (!r) continue;
    const src = `${r.kind}:${r.ref.slice(0, r.ref.lastIndexOf('#'))}`;
    if (seen.has(src)) continue;
    seen.add(src);
    pool.push({ id: r.id, kind: r.kind, title: r.title, body: r.body, at: r.at, until: r.until, score });
    if (pool.length >= POOL) break;
  }
  // rerank (phase 2): a cross-encoder reads the question with each candidate; whatever time is left, at most RERANK_MS; else the merge order
  const left = Math.min(RERANK_MS, deadline - Date.now());
  if (pool.length > limit && left > 100 && (process.env.TEAM_RERANK || '').toLowerCase() !== 'off') {
    const scores = await rerank(q.slice(0, 500), pool.map((h) => `${h.title}. ${h.body.replace(/\s+/g, ' ').slice(0, 900)}`), left);
    if (scores) return pool.map((h, i) => ({ ...h, score: scores[i] + (h.kind === 'team' ? TEAM_BOOST : 0) })).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  return pool.slice(0, limit);
}

/** A piece belongs to a time window: a decision in force at some point in it, anything else dated in it (undated Knowledge always). */
function inWindow(r: { kind: string; at: string; until?: string }, win: TimeWindow): boolean {
  if (r.kind === 'team' || r.kind === 'team_past') return overlaps(r.at, r.until ?? '', win);
  if (r.kind === 'kb') return true;
  return !r.at || (r.at >= win.from && r.at <= win.to);
}

export const formatHits = (hits: Hit[], max = RECALL_CHARS) => {
  let out = '';
  for (const h of hits) { const line = `- [${h.title}] ${h.body.replace(/\s+/g, ' ').slice(0, 900)}\n`; if (out.length + line.length > max) break; out += line; }
  return out.trim();
};

/** The recall block for an owner or admin turn ('' for anyone else, or when nothing matches in time). Never throws. */
export async function recallFor(userId: number, text: string, agentId: number | null = null): Promise<string> {
  return (await recallWithSource(userId, text, null, agentId)).text;
}

// Query rewriting (D, 2026-10-28, default "entities" mode, no model call): a short or leaning message ("what about him?",
// "and that deal?") is searched together with the person's previous message in the conversation, so the names it leans on are found.
const LEANS = /\b(he|she|they|him|her|them|his|their|it|its|that|this|those|these|there|same|again|also)\b/i;
export function searchText(text: string, prev: string): string {
  const t = text.trim();
  if (!prev.trim() || (t.length >= 80 && !LEANS.test(t))) return t;
  return `${prev.trim().slice(0, 600)}\n${t}`;
}
function previousAsk(threadId: number, text: string): string {
  const rows = db.prepare("SELECT text FROM ai_messages WHERE thread_id = ? AND role = 'user' ORDER BY id DESC LIMIT 3").all(threadId) as { text: string }[];
  return rows.map((r) => r.text).find((t) => t.trim() !== text.trim()) ?? '';
}

/** recallFor, and whether any of it is text other people wrote (Slack posts, calls, profiles built from them): see tools.ts markRunUntrusted.
 *  `threadId`: the conversation, so a message that leans on the one before is searched with it. */
export async function recallWithSource(userId: number, text: string, threadId?: number | null, agentId: number | null = null): Promise<{ text: string; outside: boolean }> {
  const none = { text: '', outside: false };
  if (!hasTeamMemory(userId) || !text.trim() || (process.env.TEAM_MEMORY || '').toLowerCase() === 'off') return none;
  try {
    const t0 = Date.now();
    const q = threadId ? searchText(text, previousAsk(threadId, text)) : text;
    const hits = await Promise.race([searchMemory(q, 8, RECALL_MS - 300, agentId), new Promise<Hit[]>((ok) => setTimeout(() => ok([]), RECALL_MS))]);
    const win = timeWindow(text, today());
    // the profile of each rep the question names comes first (built nightly from their linked pieces)
    const profiles = entitiesIn(q).filter((e) => e.kind === 'person').map((e) => ({ e, p: getProfile(e.id) })).filter((x) => x.p).slice(0, 3)
      .map((x) => `- [Profile of ${x.e.name}, ${x.p!.updated_at.slice(0, 10)}] ${x.p!.body.replace(/\s+/g, ' ').slice(0, 1200)}`).join('\n');
    // how the named people and contracts relate (drawn nightly from the pieces), with the day each was last seen
    const named = entitiesIn(q);
    const rels = edgesFor(named.map((e) => e.id), 6).map((x) => `- [Relationship${x.day ? `, ${x.day}` : ''}] ${x.from} ${x.rel} ${x.to}`).join('\n');
    let cards = ''; try { cards = graphCards(q); } catch { /* cards are extra: never lose recall over them */ } // who each named rep or contract is mentioned with most (D 2026-10-28)
    const head = [profiles, rels, cards].filter(Boolean).join('\n');
    const body = [head, formatHits(hits, RECALL_CHARS - head.length)].filter(Boolean).join('\n');
    if (!body) return none;
    const outside = !!profiles || hits.some((h) => h.kind === 'slack' || h.kind === 'call');
    const when = win ? `; the question asks about ${win.label} (${win.from === '2000-01-01' ? `up to ${win.to}` : win.from === win.to ? win.from : `${win.from} to ${win.to}`}): these are what was true or said then, earlier decisions marked with the days they were true` : '';
    return { outside, text: `=== Team memory (shared by the agency's owner and admins; recalled for this message in ${Date.now() - t0} ms${when}; may be out of date: check numbers with the tools) ===\n${body}` };
  } catch { return none; }
}
