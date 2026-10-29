import 'server-only';
import crypto from 'crypto';
import { reportTz } from '@/lib/report-tz';
import { zoneMidnight } from '@/lib/tz';
import { todayIn } from '@/lib/sales-range';
import { agencySecretValues } from '@/lib/agency-secrets';
import { modelOrDefault } from './models';
import { RUNNERS } from './runners';
import { mintRunKey, revokeRunKey } from './tools';
import { envSecrets, redactSecrets, secretNeedles } from './tool-guard';
import { acquireLease } from './routines';
import { addCommitment, addTeamItem, hasTeamMemory, listTeamItems, retireTeamItems } from './team-memory';
import { markRelationsRead, profilesDue, relationsDue, saveEdge, saveProfile } from './team-graph';
import { db } from '@/lib/db';
import { addAgentNote, addMemory, agentDayMessages, defaultAgent, agentNotes, listAgents, listMemory, markMemoryRun, memoryRunDone, setStale, type Agent } from './store';

// The nightly memory pass (D, 2026-10-12: "we need this", the legacy agents' daily memory files and nightly tidy-up). Once a day, after
// 03:00 in the agency's zone, for yesterday: each agent with memory on reads its conversations of that day (chats and routine runs),
// writes its daily log, adds what it learned to its notebook and flags notebook notes the day showed are no longer true; for each person
// it talked with, it adds lasting personal notes and flags theirs that went stale. Stale notes are kept and shown on AI › Memory (Keep
// or Delete there), never read into prompts again. One model call per agent that had conversations; no tools; secrets scrubbed.
const RUN_AFTER_HOUR = 3;
const MAX_TRANSCRIPT = 60_000;
const appPort = () => process.env.PORT || (process.env.NODE_ENV === 'production' ? '3000' : '3107');

/** Yesterday (YYYY-MM-DD) in `tz`, and its UTC bounds. */
export function dayWindow(tz: string, now = new Date()): { day: string; from: string; to: string; hour: number } {
  const today = todayIn(tz, now);
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
  const day = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return { day, from: zoneMidnight(day, tz), to: zoneMidnight(today, tz), hour };
}

const scrub = (() => {
  let needles: string[] | null = null;
  return (t: string) => { needles ??= secretNeedles({ ...envSecrets(), ...agencySecretValues() }); return redactSecrets(t, needles).text; };
})();

type Out = { log?: string; agent_notes?: string[]; agent_stale?: number[]; personal?: { user: number; notes?: string[]; stale?: number[] }[];
  team?: { kind?: string; content?: string; who?: string; thread?: number }[]; team_stale?: number[];
  commitments?: { who?: string; what?: string; due?: string; thread?: number }[] };

async function passForAgent(agent: Agent, day: string, from: string, to: string): Promise<string | null> {
  const msgs = agentDayMessages(agent.id, from, to);
  if (!msgs.length) return null;
  const model = modelOrDefault(agent.model);
  const runner = RUNNERS[model.provider];
  if (!runner) return `${agent.name}: ${model.label} not connected`;
  let transcript = '', last = -1;
  for (const m of msgs) {
    if (m.thread_id !== last) { transcript += `\n\n## Conversation "${m.title}" (thread ${m.thread_id}) with ${m.username || `user ${m.user_id}`} (user ${m.user_id}${hasTeamMemory(m.user_id) ? ', LEAD' : ''})\n`; last = m.thread_id; }
    transcript += `${m.role === 'user' ? m.username || 'User' : agent.name}: ${m.text.slice(0, 4000)}\n`;
  }
  transcript = scrub(transcript.length > MAX_TRANSCRIPT ? `(earlier part cut)\n${transcript.slice(-MAX_TRANSCRIPT)}` : transcript);
  const users = [...new Set(msgs.map((m) => m.user_id))];
  const notebook = agentNotes(agent.id), team = listTeamItems(60);
  const personal = users.map((u) => ({ u, name: msgs.find((m) => m.user_id === u)?.username ?? `user ${u}`, notes: listMemory(u) }));
  const prompt = [
    `You are ${agent.name}. Below are all your conversations of ${day} (chats and scheduled routine runs). Do your end-of-day memory work and answer with ONE JSON object, nothing else:`,
    '{"log": "<your daily log for the day: the questions about the agency (not who asked them), what you found (exact numbers with their dates and contracts), what was decided, what is still open; short paragraphs or bullets, under 250 words>",',
    ' "agent_notes": ["<new lasting facts about the agency, its rules, people or data that you should know in every later run; one sentence each; only ones not already in your notebook; [] if none>"],',
    ' "agent_stale": [<ids of notebook notes the day showed are wrong or no longer true; [] if none>],',
    ' "personal": [{"user": <user id>, "notes": ["<lasting preferences or facts about that person, not already in their notes>"], "stale": [<ids of their notes that are no longer true>]}],',
    ' "team": [{"kind": "decision" | "fact", "content": "<one sentence: what was decided or established, with the exact names, numbers, dates and contracts>", "who": "<the person who decided it>", "thread": <thread id>}],',
    ' "team_stale": [<ids of team memory items below that the day showed are no longer true>],',
    ' "commitments": [{"who": "<the person who promised>", "what": "<what they will do, one sentence, with names and amounts>", "due": "<YYYY-MM-DD if a date was said, else empty>", "thread": <thread id>}]}',
    'Commitments: only promises a person in a LEAD conversation made to do something ("I\'ll send Alex the list by Friday", "we\'ll pay Riley on the 1st"), not questions or things the AI was asked to do right away. [] if none.',
    'Team memory is the agency leadership\'s shared memory (owner and admins): put in "team" only decisions and lasting facts from conversations marked LEAD (never from anyone else\'s), each once, not ones already in team memory. A decision is a choice that changes how the agency works or counts something (a rule, a policy, who does what, a setting, a client change); a fact is lasting knowledge (how a number behaves, where data comes from). Not one-off numbers, questions or to-dos. [] if none.',
    'Privacy: each person\'s conversations are private. The log and the agency notes hold what was found and decided about the agency and its data, never who asked what, what a person said, or anything from one person\'s chat that another should not see; personal notes go only under that person. Rules: never put secrets, passwords, keys or tokens in any field. Do not save one-off numbers as notes (they go in the log). Do not invent anything that is not in the conversations. Never use em dashes.',
    `=== Your notebook now (id: note) ===\n${notebook.map((n) => `${n.id}: ${n.content}`).join('\n') || '(empty)'}`,
    `=== Team memory now, newest first (id: [kind day who] item) ===\n${team.map((t) => `${t.id}: [${t.kind} ${t.day} ${t.who}] ${t.content}`).join('\n') || '(empty)'}`,
    ...personal.map((p) => `=== ${p.name}'s notes now (user ${p.u}; id: note) ===\n${p.notes.map((n) => `${n.id}: ${n.content}`).join('\n') || '(empty)'}`),
    `=== Conversations of ${day} ===${transcript}`,
  ].join('\n\n');
  const key = mintRunKey(users[0], 0, []);
  let text = '';
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 5 * 60_000);
  const res = await runner({
    system: 'You keep an AI agent\'s memory: a daily log, a notebook of lasting facts, and personal notes per person. Answer with JSON only.',
    prompt, session: { id: crypto.randomUUID(), resume: false }, model: model.wire, tools: [], signal: ac.signal,
    mcp: { url: `http://127.0.0.1:${appPort()}/api/ai/mcp`, key },
    onText: (d) => { text += d; }, onToolStart: () => {}, onToolEnd: () => {},
  }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  clearTimeout(timer); revokeRunKey(key);
  if (res.error) return `${agent.name}: ${res.error}`;
  let out: Out;
  try { out = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Out; } catch { return `${agent.name}: the answer was not JSON`; }
  const clean = (s: unknown) => (typeof s === 'string' ? scrub(s).trim() : '');
  const owner = agent.created_by ?? users[0];
  let added = 0, stale = 0;
  if (clean(out.log)) addAgentNote(agent.id, owner, clean(out.log), null, 'log', day);
  for (const n of out.agent_notes ?? []) if (clean(n)) { addAgentNote(agent.id, owner, clean(n), null); added++; }
  stale += setStale((out.agent_stale ?? []).map(Number).filter((id) => notebook.some((n) => n.id === id)), true, { agentId: agent.id });
  for (const p of out.personal ?? []) {
    const u = Number(p.user); if (!users.includes(u)) continue;
    for (const n of p.notes ?? []) if (clean(n)) { addMemory(u, clean(n), null); added++; }
    stale += setStale((p.stale ?? []).map(Number), true, { userId: u });
  }
  // team memory: only from LEAD conversations (owner and admins), with who and the thread it came from
  const leadThreads = new Set(msgs.filter((m) => hasTeamMemory(m.user_id)).map((m) => m.thread_id));
  let teamAdded = 0;
  for (const t of out.team ?? []) {
    const thread = Number(t.thread);
    if (!clean(t.content) || !leadThreads.has(thread)) continue;
    if (addTeamItem({ kind: t.kind === 'decision' ? 'decision' : 'fact', content: clean(t.content), who: clean(t.who), day, threadId: thread, agentId: agent.id })) teamAdded++;
  }
  stale += retireTeamItems((out.team_stale ?? []).map(Number).filter((id) => team.some((t) => t.id === id)));
  let promised = 0;
  for (const c of out.commitments ?? []) {
    const thread = Number(c.thread);
    if (!clean(c.what) || !leadThreads.has(thread)) continue;
    if (addCommitment({ who: clean(c.who), what: clean(c.what), due: clean(c.due), day, threadId: thread })) promised++;
  }
  return `${agent.name}: log, ${added} new notes, ${teamAdded} team, ${promised} commitments, ${stale} flagged stale`;
}

/** Relationships (team memory, D 2026-10-23): pieces that name 2+ reps or contracts, newest first, 15 per model call and at most 10 calls a
 *  night; the model writes how the named entities relate, only between the names given (team-graph.ts saveEdge checks every name). */
async function relationPass(day: string): Promise<string | null> {
  const due = relationsDue(150);
  if (!due.length) return null;
  const agent = defaultAgent(), model = modelOrDefault(agent?.model), runner = RUNNERS[model.provider];
  if (!runner) return `relationships: ${model.label} not connected`;
  let saved = 0, read = 0;
  for (let i = 0; i < due.length && i / 15 < 10; i += 15) { // at most 10 model calls a night
    const batch = due.slice(i, i + 15);
    const names = [...new Set(batch.flatMap((b) => b.names))];
    const prompt = [
      'From the numbered sources below, list the relationships they STATE between these people and contracts (use the names exactly as written here):',
      names.join('; '),
      'Answer with ONE JSON object: {"relations": [{"from": "<name from the list>", "rel": "<short verb phrase, e.g. team lead of, closer for, set calls for, coaches, replaced, client of>", "to": "<name from the list>", "source": <source number>}]}.',
      'Only relationships a source says or clearly shows (who works on which contract, who leads, sets for, closes for, coaches or replaced whom). Never guess, never one-off events like a single shared call. [] when none. Never use em dashes.',
      batch.map((b, j) => `## Source ${j + 1}: ${b.title}${b.at ? ` (${b.at})` : ''}\n${scrub(b.body.slice(0, 1200))}`).join('\n\n'),
    ].join('\n\n');
    const key = mintRunKey(agent?.created_by ?? 1, 0, []);
    let text = '';
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 3 * 60_000);
    const res = await runner({ system: 'You extract relationships between known people and contracts for an agency\'s team memory. Answer with JSON only.', prompt,
      session: { id: crypto.randomUUID(), resume: false }, model: model.wire, tools: [], signal: ac.signal, mcp: { url: `http://127.0.0.1:${appPort()}/api/ai/mcp`, key },
      onText: (t) => { text += t; }, onToolStart: () => {}, onToolEnd: () => {} }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    clearTimeout(timer); revokeRunKey(key);
    if (res.error) break; // tried again next night
    try {
      const out = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { relations?: { from?: string; rel?: string; to?: string; source?: number }[] };
      for (const r of out.relations ?? []) {
        const src = batch[Number(r.source) - 1];
        if (src && r.from && r.to && r.rel && saveEdge(r.from, r.rel, r.to, src.id, src.at || day)) saved++;
      }
    } catch { /* not JSON: these pieces are read again next night */ continue; }
    markRelationsRead(batch);
    read += batch.length;
  }
  return `relationships: ${saved} from ${read} pieces`;
}

/** Rep profiles (team memory phase 2): reps whose linked memory changed get a short profile, at most 8 a night, one model call each, from
 *  their newest 25 pieces only (team-graph.ts). Recall shows a rep's profile when a question names them. */
async function profilePass(): Promise<string | null> {
  const due = profilesDue(3, 8);
  if (!due.length) return null;
  const agent = defaultAgent(), model = modelOrDefault(agent?.model), runner = RUNNERS[model.provider];
  if (!runner) return `profiles: ${model.label} not connected`;
  let made = 0;
  for (const d of due) {
    const pieces = d.chunkIds.map((id) => db.prepare('SELECT title, body, at FROM ai_mem_chunks WHERE id = ?').get(id) as { title: string; body: string; at: string } | undefined)
      .filter(Boolean).map((p) => `## ${p!.title}${p!.at ? ` (${p!.at})` : ''}\n${p!.body.slice(0, 900)}`).join('\n\n');
    const prompt = [
      `Write a short profile of ${d.entity.name}, a member of the agency's sales team, from the sources below only. Answer with ONE JSON object: {"profile": "<under 150 words>"}.`,
      'Cover: their role and contracts, how they are doing lately (only numbers the sources state, with dates), strengths, what to watch, and notable recent events or decisions about them. Plain sentences, no headings, never invent anything, never use em dashes. Use their name or "they", never he or she unless a source says it.',
      `=== Sources (newest first) ===\n${scrub(pieces)}`,
    ].join('\n\n');
    const key = mintRunKey(agent?.created_by ?? 1, 0, []);
    let text = '';
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 3 * 60_000);
    const res = await runner({ system: 'You write short factual profiles of people for an agency\'s team memory. Answer with JSON only.', prompt, session: { id: crypto.randomUUID(), resume: false },
      model: model.wire, tools: [], signal: ac.signal, mcp: { url: `http://127.0.0.1:${appPort()}/api/ai/mcp`, key }, onText: (t) => { text += t; }, onToolStart: () => {}, onToolEnd: () => {} })
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    clearTimeout(timer); revokeRunKey(key);
    if (res.error) continue;
    try {
      const p = (JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { profile?: string }).profile;
      if (p && p.trim()) { saveProfile(d.entity.id, scrub(p.trim()), d.sources); made++; }
    } catch { /* not JSON: tried again next night */ }
  }
  return `profiles: ${made} of ${due.length}`;
}

let running = false;
/** Runs the pass for yesterday if it is past 03:00 and not done yet (`force`: now, even if done; `day`: that past day instead). Returns its summary, or null. */
export async function nightlyMemory(opts: { force?: boolean; holder?: string; day?: string } = {}): Promise<string | null> {
  if (running) return null;
  const { day, from, to, hour } = dayWindow(reportTz(), opts.day ? new Date(Date.parse(`${opts.day}T12:00:00Z`) + 86_400_000) : undefined);
  if (!opts.force && (hour < RUN_AFTER_HOUR || memoryRunDone(day))) return null;
  if (!opts.force && !acquireLease('memory', opts.holder ?? `memory-${process.pid}`, 30 * 60_000)) return null;
  running = true;
  try {
    // claim the day first, so a second copy (or a crash loop) never runs it twice; the summary is filled in at the end
    markMemoryRun(day, 'running');
    const lines: string[] = [];
    for (const a of listAgents().filter((x) => x.use_memory)) {
      const r = await passForAgent(a, day, from, to).catch((e: unknown) => `${a.name}: ${e instanceof Error ? e.message : String(e)}`);
      if (r) lines.push(r);
    }
    // the notebook cleanup (memory-tidy.ts, D 2026-10-28): copies, merges, notes that disagree, the cap
    const tidy = await (await import('./memory-tidy')).tidyPass().catch((e: unknown) => `tidy: ${e instanceof Error ? e.message : String(e)}`);
    if (tidy) lines.push(tidy);
    const rel = await relationPass(day).catch((e: unknown) => `relationships: ${e instanceof Error ? e.message : String(e)}`);
    if (rel) lines.push(rel);
    const prof = await profilePass().catch((e: unknown) => `profiles: ${e instanceof Error ? e.message : String(e)}`);
    if (prof) lines.push(prof);
    const ins = await (await import('./memory-layers')).insightPass(day).catch((e: unknown) => `insights: ${e instanceof Error ? e.message : String(e)}`);
    if (ins) lines.push(ins);
    const summary = lines.join(' · ') || 'no conversations';
    markMemoryRun(day, summary);
    console.log(`[memory] ${day}: ${summary}`);
    return summary;
  } finally { running = false; }
}

