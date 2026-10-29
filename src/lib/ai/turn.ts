import 'server-only';
import { getBrand } from '@/lib/brand';
import { strategyPrompt } from '@/lib/ai/agency-values';
import { db } from '@/lib/db';
import { getGrant } from '@/lib/user-access';
import { agentTools, expandSkill } from './catalog';
import { recallWithSource } from './team-memory';
import { teamPrompt } from './comms';
import { learnAfterTurn } from './memory-layers';
import { modelOrDefault } from './models';
import { RUNNERS } from './runners';
import { addMessage, canUseAgent, createThread, defaultAgent, getAgent, getThread, listMemory, listSkills, setThreadContext, threadHistory, type Agent, notebookPrompt, roleBlock } from './store';
import { markRunUntrusted, mintRunKey, revokeRunKey, toolAllowedFor } from './tools';
import { aiTierOf, type AiTier } from './access';
import { guardrails, whoLabel } from './guardrails';
import { reportTz, tzName } from '@/lib/report-tz';
import { overBudget, recordTurn } from './usage';
import { todayIn } from '@/lib/sales-range';

// One AI turn without a browser (D, 2026-10-09): Telegram and other channels call this. Same rules as the chat: owner/admin only,
// the agent's instructions, model and tools, memory, skills, one continuous conversation (the Claude CLI resumes its session; API
// runners replay history). Returns the reply as text.
const appPort = () => process.env.PORT || (process.env.NODE_ENV === 'production' ? '3000' : '3107');

function system(name: string, agent: Agent | undefined, tools: string[], channel: string, notes: { id: number; content: string }[], tier: AiTier, uid: number) {
  return [
    `You are ${agent?.name ?? 'the Assistant'}, an AI agent in ${getBrand().short}, a team of AI agents. You are talking with ${name} (${whoLabel(tier)}) on ${channel}. Today is ${todayIn(reportTz())} (${tzName(reportTz())}).`,
    guardrails(tier),
    'Never invent facts or numbers: use your tools. Keep replies short: they are read on a phone. No tables wider than 3 columns; prefer short lines. Never use em dashes.',
    'Changes: Slack posts and direct messages (propose_slack_post), saving a skill (propose_skill) and making, changing or running a routine (save_routine, run_routine) happen as soon as you call the tool. When the person asks you to message someone, post somewhere, save a skill or set up a scheduled job, just do it (no confirmation step, D 2026-10-22: act like a teammate); ask only when who it goes to or what to say is genuinely unclear, then say in one line what you did. To message a person, find their Slack id with slack_people. Every other propose_ tool waits for approval in the app (say so; it does not show here). Never name the software the dashboard runs on.',
    roleBlock(agent),
    agent?.use_memory !== false && notes.length ? `What you remember about ${name}:\n${notes.map((n) => `- ${n.id}: ${n.content}`).join('\n')}` : '',
    agent?.use_memory !== false && tier === 'full' ? notebookPrompt(agent) : '', // the shared notebook comes from owner and admin chats
    tier === 'full' ? teamPrompt(agent, uid) : '',
    `Your tools: ${tools.join(', ') || 'none'}.`,
    tier === 'full' ? strategyPrompt() : '',
  ].filter(Boolean).join('\n\n');
}

export async function runTurn(input: { userId: number; threadId: number | null; agentId: number | null; text: string; channel: string; title: string }): Promise<{ reply: string; threadId: number; error?: string }> {
  const role = getGrant(input.userId).role, tier = aiTierOf(role);
  // the same people and limits as the app chat (D, 2026-10-13): owner, admins, managers (their pages), clients (their revenue)
  if (role !== 'owner' && role !== 'admin' && role !== 'manager' && role !== 'client') return { reply: 'This login has no AI access.', threadId: input.threadId ?? 0, error: 'no access' };
  let thread = input.threadId ? getThread(input.userId, input.threadId) : undefined;
  const picked = getAgent(input.agentId ?? thread?.agent_id);
  const agent = tier === 'full' && picked && canUseAgent(picked, input.userId) ? picked : defaultAgent();
  const model = modelOrDefault(agent?.model);
  const runner = RUNNERS[model.provider];
  if (!runner) return { reply: `${model.label} is not connected.`, threadId: thread?.id ?? 0, error: 'not connected' };
  const capped = overBudget(agent?.id); // the agent's own daily cap (usage.ts)
  if (capped) return { reply: capped, threadId: thread?.id ?? 0, error: 'daily cap' };
  const tools = (agent ? agentTools(agent) : agentTools({ tools: [], use_memory: true })).filter((t) => toolAllowedFor(tier, t));
  const { prompt } = expandSkill(input.text, listSkills(input.userId));
  const resume = !!thread;
  thread ??= createThread(input.userId, input.title, crypto.randomUUID(), agent?.id ?? null);
  const past = model.provider === 'claude-cli' || !resume ? [] : threadHistory(thread.id);
  addMessage(thread.id, 'user', input.text);
  const name = (db.prepare('SELECT username FROM users WHERE id = ?').get(input.userId) as { username?: string } | undefined)?.username ?? 'the user';
  const key = mintRunKey(input.userId, thread.id, tools, agent?.apps ?? []);
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 10 * 60_000);
  let reply = '';
  const { text: recall, outside } = await recallWithSource(input.userId, input.text, thread.id, agent?.id ?? null); // team memory: owner and admins only, at most 2.5 s
  if (outside) markRunUntrusted(key);
  const res = await runner({
    system: `${system(name, agent, tools, input.channel, listMemory(input.userId), tier, input.userId)}${thread.summary ? `\n\n=== Summary of this conversation so far ===\n${thread.summary}` : ''}${recall ? `\n\n${recall}` : ''}`,
    prompt, history: past, session: { id: thread.session_id, resume }, model: model.wire, tools, signal: ac.signal,
    mcp: { url: `http://127.0.0.1:${appPort()}/api/ai/mcp`, key },
    onText: (d) => { reply += d; }, onToolStart: () => { if (reply && !reply.endsWith('\n\n')) reply += '\n\n'; }, onToolEnd: () => {},
  }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e), context: undefined, usage: undefined }));
  clearTimeout(timer); revokeRunKey(key);
  // Telegram and Slack turns count in Operations › Analytics too (D, 2026-10-12)
  recordTurn({ threadId: thread.id, userId: input.userId, agentId: agent?.id ?? null, model: model.id, source: 'chat', context: res.context, usage: res.usage, ok: !res.error });
  if (res.context) setThreadContext(thread.id, res.context);
  const text = reply.trim() || (res.error ? `(stopped: ${res.error})` : '(no answer)');
  addMessage(thread.id, 'assistant', text, [], (await import('./send-file')).takeSentFiles(thread.id)); // files show in the app's copy of the conversation
  if (!res.error && tier === 'full') void learnAfterTurn({ agent, userId: input.userId, threadId: thread.id, question: input.text, reply: text }); // memory-layers.ts
  return { reply: text, threadId: thread.id, error: res.error };
}
