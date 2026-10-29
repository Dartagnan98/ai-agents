import { takeSentFiles } from '@/lib/ai/send-file';
import { recallWithSource } from '@/lib/ai/team-memory';
import { teamPrompt } from '@/lib/ai/comms';
import { learnAfterTurn } from '@/lib/ai/memory-layers';
import { recordTurn } from '@/lib/ai/usage';
import { claimAttachments, forRunner, withTextFiles } from '@/lib/ai/attachments';
import { strategyPrompt } from '@/lib/ai/agency-values';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { aiChatUser, aiDenied, type AiTier } from '@/lib/ai/access';
import { toolAllowedFor } from '@/lib/ai/tools';
import { guardrails, whoLabel } from '@/lib/ai/guardrails';
import { teamRoutineThreadOwner } from '@/lib/ai/routines';
import { addMessage, canUseAgent, compactThread, createThread, setThreadContext, threadHistory, defaultAgent, getAgent, getThread, listMemory, listMessages, listSkills, listThreads, liveOf, endStaleLive, requestStop, setLive, stopRequested, deleteThread, renameThread, setThreadAgent, type Agent, type Step, notebookPrompt, roleBlock } from '@/lib/ai/store';
import { markRunUntrusted, mintRunKey, revokeRunKey, stepTitle } from '@/lib/ai/tools';
import { agentTools, expandSkill, MEMORY_TOOLS } from '@/lib/ai/catalog';
import { COMPACT_AT, CONTEXT_WINDOW, resolveModel } from '@/lib/ai/models';
import { RUNNERS } from '@/lib/ai/runners';
import { limitRequest, POLICIES } from '@/lib/ops/rate-limit';
import { getBrand } from '@/lib/brand';
import { reportTz, tzName } from '@/lib/report-tz';
import { todayIn } from '@/lib/sales-range';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

// the agents chat (D, 2026-10-09): one run per message, resuming the conversation's own session, so a conversation is one continuous
// session. The agent picked (body.agent, else the conversation's, else the default) sets the added instructions, the model and the
// tool allow-list; a message starting with /<skill> expands that skill. The run itself is the model provider's runner (lib/ai/runners;
// the Claude subscription CLI today). Streams NDJSON: {t:'thread'}, {t:'text',d} pieces of the reply, {t:'step',...} tool steps,
// {t:'done',thread} or {t:'error',m}. Owner and admins only (the chat sees money and commissions).

let running = 0;

// GET: this login's conversations (?q= searches titles and messages), or one conversation's messages (?thread=)
export async function GET(req: NextRequest) {
  const me = await aiChatUser();
  if (!me) return aiDenied();
  const id = Number(req.nextUrl.searchParams.get('thread'));
  if (id) {
    // yours, or a team routine's run (read only for others: a reply starts a new conversation of yours)
    const owner = getThread(me.uid, id) ? me.uid : me.tier === 'full' ? teamRoutineThreadOwner(id) : null; // routine runs hold team numbers
    const t = owner ? getThread(owner, id) : undefined;
    // live: the run still answering here (it keeps going after a reload), so the page shows it and picks up the answer
    // a reply cut off by an app restart: keep what it had, and say so
    const dead = t ? endStaleLive(t.id) : null;
    if (t && dead) addMessage(t.id, 'assistant', `${dead.reply.trim()}\n\n(stopped: the agency restarted during this answer. Send your message again.)`.trim(),
      dead.steps.map((x) => (x.status === 'running' ? { ...x, status: 'error' } : x)));
    return t ? Response.json({ thread: t, messages: listMessages(t.id), live: liveOf(t.id) }) : Response.json({ error: 'Not found' }, { status: 404 });
  }
  return Response.json({ threads: listThreads(me.uid, req.nextUrl.searchParams.get('q') ?? '') });
}

// PATCH ?thread= {title}: rename a conversation
export async function PATCH(req: NextRequest) {
  const me = await aiChatUser();
  if (!me) return aiDenied();
  const body = await req.json().catch(() => ({})) as { title?: string };
  return renameThread(me.uid, Number(req.nextUrl.searchParams.get('thread')), String(body.title ?? ''))
    ? Response.json({ ok: true }) : Response.json({ error: 'Not found' }, { status: 404 });
}

export async function DELETE(req: NextRequest) {
  const me = await aiChatUser();
  if (!me) return aiDenied();
  deleteThread(me.uid, Number(req.nextUrl.searchParams.get('thread')));
  return Response.json({ ok: true });
}

// an example path with one of this agency's own contracts (HARDCODE_AUDIT B12): the agency's first contract is acme, as the prompt always said
function systemPrompt(name: string, where: string, notes: { id: number; content: string }[], agent: Agent | undefined, tools: string[], tier: AiTier = 'full', uid = 0) {
  const memory = MEMORY_TOOLS.some((t) => tools.includes(t));
  return [
    `You are ${agent?.name ?? 'the Assistant'}, an AI agent in ${getBrand().short}, a team of AI agents. You are talking with ${name}, ${whoLabel(tier)}.`,
    guardrails(tier),
    `Today is ${todayIn(reportTz())} (${tzName(reportTz())}). They are looking at: ${where || 'the app'}.`,
    'Never invent facts or numbers: use your tools (files, the workspace, web APIs, memory, Knowledge) and say where an answer comes from. If you cannot find it, say so.',
    'For the team\'s own facts (notes, SOPs, references), search Knowledge with search_knowledge when you have that tool. For the direction (north star, focus, goals), use read_goals.',
    'Keep answers short and plain: the answer first, then a few bullets. Never use em dashes.',
    // rich blocks the chat draws (components/ai/blocks.ts, G14 convention; D, 2026-10-09)
    'Rich views: the chat draws fenced code blocks whose language is ctrl-table, ctrl-chart, ctrl-cards or ctrl-actions, with JSON inside (valid JSON, double quotes, no comments). Use them for real numbers from the tools, with one or two short lines of prose around them. ' +
      'ctrl-table {"title","columns":[{"key","label","type":"text|number|money|percent|date"}],"rows":[{...}]} for lists people may sort (more than about 5 rows or 3 columns; a small list can be a markdown table). Numbers go in as plain numbers (1234.5, not "$1,234.50"); the type formats them. ' +
      'ctrl-chart {"type":"bar|line|pie","title","x":"<category key>","series":["<number key>"],"data":[{...}]} when they ask for a trend, a comparison or a split. ' +
      'ctrl-cards {"cards":[{"type":"person|link","title","subtitle","status","url","fields":[{"label","value"}]}]} for the few records you are talking about; url is an in-app path when you know it. ' +
      `ctrl-actions {"actions":[{"label","prompt"} or {"label","url"}]} for one to three next steps at the end: a prompt is sent to you as their next message (for example {"label":"Compare with last month","prompt":"Compare these numbers with last month"}); a url is an in-app path that opens a page (for example /ai/tasks). ` +
      'Never invent rows, numbers or paths; only use a path you have seen in the address or a tool result.',
    'Changes: Slack posts and direct messages (propose_slack_post), saving a skill (propose_skill) and making, changing or running a routine (save_routine, run_routine) happen as soon as you call the tool. When the person asks you to message someone, post somewhere, save a skill or set up a scheduled job, just do it (no confirmation step, D 2026-10-22: act like a teammate); ask only when who it goes to or what to say is genuinely unclear, then say in one line what you did. To message a person, find their Slack id with slack_people. Every other propose_ tool files the change and the user approves it on a card under your reply. For any other change, say exactly what to change and where in Settings.',
    memory ? 'Memory: when they tell you a lasting preference or fact about their work, save it with remember. Never save secrets.' : '',
    memory && notes.length ? `What you remember about ${name} (memory notes, id: note):\n${notes.map((n) => `- ${n.id}: ${n.content}`).join('\n')}` : '',
    memory && tier === 'full' ? notebookPrompt(agent) : '', // the agent's shared notebook comes from owner and admin chats
    tier === 'full' ? teamPrompt(agent, uid) : '', // the team, skills and messages from other agents (lib/ai/comms.ts)
    roleBlock(agent),
    `Your tools: ${tools.join(', ') || 'none'}. `,
    tier === 'full' ? strategyPrompt() : '', // the agency's direction: owner and admins only
  ].filter(Boolean).join('\n\n');
}

export async function POST(req: NextRequest) {
  const me = await aiChatUser();
  if (!me) return aiDenied();
  // rate limit per login (P5 helper, D 2026-10-09)
  const limited = limitRequest(req, 'ai-chat', POLICIES.aiChat, me.uid); if (limited) return limited;
  // ?stop=<thread>: Stop (a dropped connection no longer stops a run); the run sees it within a second
  const stopId = Number(req.nextUrl.searchParams.get('stop'));
  if (stopId) { if (!getThread(me.uid, stopId)) return Response.json({ error: 'Not found' }, { status: 404 }); requestStop(stopId); return Response.json({ ok: true }); }
  const body = await req.json().catch(() => ({})) as { thread?: number; text?: string; where?: string; agent?: number; model?: string; files?: unknown };
  const text = String(body.text ?? '').trim();
  // files and pictures uploaded first to /api/ai/attachments (D, 2026-10-23); a message may be only files
  const fileIds = Array.isArray(body.files) ? body.files : [];
  if ((!text && !fileIds.length) || text.length > 30_000) return Response.json({ error: 'Type a message (under 30,000 characters).' }, { status: 400 });
  if (running >= 4) return Response.json({ error: 'Four answers are already running. Try again in a moment.' }, { status: 429 });

  let thread = body.thread ? getThread(me.uid, body.thread) : undefined;
  const usable = (a: ReturnType<typeof getAgent>) => (a && canUseAgent(a, me.uid) ? a : undefined);
  // managers and clients talk to the default agent only (team agents carry instructions and notes written for the owner)
  const agent = me.tier === 'full' ? usable(getAgent(body.agent)) ?? usable(getAgent(thread?.agent_id)) ?? defaultAgent() : defaultAgent();
  // the composer's pick: Auto (the agent's model, Opus for long asks) or one model (D, 2026-10-09)
  const model = resolveModel(body.model, agent?.model, text.length);
  const runner = RUNNERS[model.provider];
  if (!runner) return Response.json({ error: `${model.label} is not connected.` }, { status: 503 });
  const tools = (agent ? agentTools(agent) : agentTools({ tools: [], use_memory: true })).filter((t) => toolAllowedFor(me.tier, t));
  const { prompt: typed } = expandSkill(text || 'Here are the attached files.', listSkills(me.uid));

  let resume = !!thread;
  const compactOnly = text === '/compact';
  if (compactOnly && !thread) return Response.json({ error: 'Nothing to compact yet.' }, { status: 400 });
  // one run per conversation: a stopped one ends within a second or two (Steer sends right after Stop)
  for (let i = 0; thread && liveOf(thread.id) && i < 20; i++) await new Promise((r) => setTimeout(r, 250));
  if (thread && liveOf(thread.id)) return Response.json({ error: 'This conversation is still answering. Wait for it, or press Stop.' }, { status: 409 });
  thread ??= createThread(me.uid, text || 'Attached files', crypto.randomUUID(), agent?.id ?? null);
  if (resume && agent && thread.agent_id !== agent.id) setThreadAgent(thread.id, agent.id);
  // runners without a session replay the turns since the last compaction (taken before this message is saved)
  const past = model.provider === 'claude-cli' || !resume ? [] : threadHistory(thread.id);
  const files = compactOnly ? [] : claimAttachments(me.uid, thread.id, fileIds);
  if (!compactOnly) addMessage(thread.id, 'user', text, [], files);
  // pictures and PDFs go to the model as images / documents, text files inside the prompt
  const sent = forRunner(me.uid, files), media = sent.filter((f) => f.kind !== 'text') as NonNullable<Parameters<typeof runner>[0]['media']>;
  const prompt = withTextFiles(typed, sent);

  const name = me.session?.user?.name ?? 'the user';
  const key = mintRunKey(me.uid, thread.id, tools, agent?.apps ?? []);
  const port = process.env.PORT || (process.env.NODE_ENV === 'production' ? '3000' : new URL(req.url).port || '3000');
  const system = systemPrompt(name, String(body.where ?? '').slice(0, 1200), listMemory(me.uid), agent, tools, me.tier, me.uid);

  running++;
  const threadId = thread.id;
  let sessionId = thread.session_id;
  const needsCompact = resume && (compactOnly || (thread.context_tokens ?? 0) > COMPACT_AT);
  let summary = thread.summary ?? '';
  const enc = new TextEncoder();
  const ac = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (o: unknown) => { try { controller.enqueue(enc.encode(`${JSON.stringify(o)}\n`)); } catch { /* client gone: the run keeps going */ } };
      send({ t: 'thread', thread: threadId, agent: agent?.id ?? null });
      let reply = '';
      const steps: Step[] = [], byId = new Map<string, number>();
      // every second: save the reply so far (a reloaded page reads it) and look for Stop (it may come in on another app copy)
      setLive(threadId, { reply, steps });
      const tick = setInterval(() => { try { if (stopRequested(threadId)) ac.abort(); setLive(threadId, { reply, steps }); } catch { /* next second */ } }, 1000);
      try {
      // Compaction (D, 2026-10-09, CTRL Flow's): past COMPACT_AT tokens (or on /compact) the session writes its own summary, and the
      // conversation carries on in a fresh session that starts from it; the messages stay in the list as before.
      if (needsCompact) {
        steps.push({ name: 'compact', title: 'Compacting the conversation', status: 'running' });
        send({ t: 'step', i: 0, ...steps[0] });
        let text2 = '';
        const r = await runner({
          system, prompt: 'Write a summary of this whole conversation for yourself to continue from: the questions asked, the numbers and answers given (exact figures, dates, contracts), decisions, preferences the user stated, and anything still open. Plain bullet points, no preamble.',
          session: { id: sessionId, resume: true }, history: past, model: model.wire, tools: [], signal: ac.signal, mcp: { url: `http://127.0.0.1:${port}/api/ai/mcp`, key },
          onText: (d) => { text2 += d; }, onToolStart: () => {}, onToolEnd: () => {},
        }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
        steps[0].status = r.error || !text2.trim() ? 'error' : 'done';
        send({ t: 'step', i: 0, ...steps[0] });
        if (!r.error && text2.trim()) { summary = text2.trim(); sessionId = crypto.randomUUID(); compactThread(threadId, sessionId, summary); resume = false; send({ t: 'context', used: 0, window: CONTEXT_WINDOW }); }
        if (compactOnly) {
          running--; revokeRunKey(key);
          addMessage(threadId, 'assistant', r.error ? `(could not compact: ${r.error})` : 'Compacted: the conversation carries on from a summary.', steps);
          send(r.error ? { t: 'error', m: r.error } : { t: 'text', d: 'Compacted: the conversation carries on from a summary.' });
          send({ t: 'done', thread: threadId });
          try { controller.close(); } catch { /* closed */ }
          return;
        }
      }
      // team memory (lib/ai/team-memory.ts): owner and admins only, at most 2.5 s, '' when nothing matches
      const { text: recall, outside } = await recallWithSource(me.uid, text, threadId, agent?.id ?? null);
      if (outside || sent.length) markRunUntrusted(key);
      const sys0 = summary ? `${system}\n\n=== Summary of this conversation so far (it was compacted) ===\n${summary}` : system;
      const sys = recall ? `${sys0}\n\n${recall}` : sys0;
      const { error, context, usage } = await runner({
        system: sys, prompt, media, session: { id: sessionId, resume }, history: needsCompact ? [] : past, model: model.wire, tools, signal: ac.signal,
        mcp: { url: `http://127.0.0.1:${port}/api/ai/mcp`, key },
        onText: (d) => { reply += d; send({ t: 'text', d }); },
        onToolStart: (id, tool, input) => {
          if (byId.has(id)) return;
          byId.set(id, steps.push({ name: tool, title: stepTitle(tool, input), status: 'running' }) - 1);
          send({ t: 'step', i: byId.get(id), ...steps[byId.get(id)!] });
          if (reply && !reply.endsWith('\n\n')) { reply += '\n\n'; send({ t: 'text', d: '\n\n' }); }
        },
        onToolEnd: (id, isError) => {
          const n = byId.get(id); if (n === undefined) return;
          steps[n].status = isError ? 'error' : 'done';
          send({ t: 'step', i: n, ...steps[n] });
        },
      }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e), context: undefined, usage: undefined }));
      running--; revokeRunKey(key);
      if (context) { setThreadContext(threadId, context); send({ t: 'context', used: context, window: CONTEXT_WINDOW }); }
      // Operations › Analytics (2026-10-10): the answer's agent, model, context size and (2026-10-12) tokens and API-price cost; never fails the turn
      recordTurn({ threadId, userId: me.uid, agentId: agent?.id ?? null, model: model.id, source: 'chat', context, usage, ok: !error });
      const sentFiles = takeSentFiles(threadId); // send_file (lib/ai/send-file.ts): shown under this answer
      if (reply.trim() || steps.length || sentFiles.length) addMessage(threadId, 'assistant', reply.trim() || (error ? `(stopped: ${error})` : ''), steps, sentFiles);
      // learning after each answer (lib/ai/memory-layers.ts): owner and admins, not awaited, never fails the turn
      if (!error && me.tier === 'full') void learnAfterTurn({ agent, userId: me.uid, threadId, question: text, reply });
      send(error ? { t: 'error', m: error } : { t: 'done', thread: threadId });
      try { controller.close(); } catch { /* closed */ }
      } finally { clearInterval(tick); setLive(threadId, null); }
    },
    // no cancel(): a reload, a closed tab or a sleeping phone must not stop the run (D, 2026-10-23); Stop is ?stop=
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
