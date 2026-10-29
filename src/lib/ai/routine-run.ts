import 'server-only';
import { strategyPrompt } from '@/lib/ai/agency-values';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { getGrant } from '@/lib/user-access';
import { teamPrompt } from './comms';
import { addMessage, canUseAgent, createThread, defaultAgent, deleteThread, getAgent, listMemory, listSkills, type Agent, type Step, notebookPrompt, roleBlock } from './store';
import { mintRunKey, mintScriptRunKey, revokeRunKey, setRunTest, stepTitle } from './tools';
import { lastLine, logWorkspace, runInWorkspace, syncTeamSkills } from './workspace';
import { isMultiTenant } from '@/lib/platform/mode';
import { currentAgencySync } from '@/lib/platform/tenant-db';
import { agentTools, ASK_IN_CHAT, expandSkill, MEMORY_TOOLS } from './catalog';
import { modelOrDefault } from './models';
import { RUNNERS } from './runners';
import { describeCron } from './cron';
import { overBudget, recordTurn } from './usage';
import { claimRun, finishRun, getRoutine, routinePrompt, skipReason, type Routine } from './routines';
import { sendSlack, sendTelegram } from './routine-deliver';
import { getBrand } from '@/lib/brand';
import { reportTz, tzName } from '@/lib/report-tz';
import { todayIn } from '@/lib/sales-range';
import { usageReport } from './usage-report';

// One routine run (D, 2026-10-09): the same runner and Fleet tools the chat uses, as the routine's creator, in a new conversation
// titled "<routine> · <date>" so the result reads in the AI list. The system prompt mirrors the chat's (app/api/ai/chat systemPrompt,
// which that route keeps to itself): the agents rules + the agent's instructions + memory + the metric guide, plus a line that nobody is
// watching. "Only run if": the agent checks it first and answers SKIP; a skipped run drops its conversation and sends nothing.
const RUN_LIMIT_MS = 15 * 60_000;

/** The port this app copy serves on (Next sets PORT; prod copy 1 has none = 3000): the MCP server is called on the same copy. */
const appPort = () => process.env.PORT || '3000';

function systemPrompt(name: string, r: Routine, notes: { id: number; content: string }[], agent: Agent | undefined, tools: string[], uid: number) {
  const memory = MEMORY_TOOLS.some((t) => tools.includes(t));
  return [
    `You are ${agent?.name ?? 'the Assistant'}, an AI agent in ${getBrand().short}, a team of AI agents. You are running the routine "${r.name}" for ${name}, an owner or admin.`,
    `Today is ${todayIn(reportTz())} (${tzName(reportTz())}). This is a scheduled routine (${describeCron(r.schedule)}) run with nobody watching: do the work with your tools, then write the report as your final answer. It is read later in the AI conversation list${r.deliver.telegram ? ' and sent on Telegram' : ''}${r.deliver.slack ? ' and posted to Slack' : ''}, so make it complete on its own. Do not ask questions; if something is missing, say what and carry on.`,
    'Never invent facts or numbers: use your tools and say where an answer comes from. If you cannot find it, say so.',
    'For the team\'s own facts, search Knowledge with search_knowledge when you have that tool. For the direction (north star, focus, goals), use read_goals; propose_strategy changes it after the user approves.',
    'Keep it short and plain: the answer first, then a few bullets. Never use em dashes.',
    'Rich views: the chat draws fenced code blocks whose language is ctrl-table, ctrl-chart, ctrl-cards or ctrl-actions, with JSON inside (valid JSON). ctrl-table {"title","columns":[{"key","label","type":"text|number|money|percent|date"}],"rows":[{...}]}; ctrl-chart {"type":"bar|line|pie","title","x","series":[...],"data":[{...}]}. Use them only for real numbers from the tools. In a Slack delivery each ctrl-chart and ctrl-table is posted as an image under the text.',
    // D, 2026-10-27: routines update things through the API keys too ("we need it to update things on the API")
    'When you change something (through http_request with a saved key, or the workspace), list every change you made in the report. Anything you have no tool for: say exactly what needs changing and where.',
    memory && notes.length ? `What you remember about ${name} (memory notes, id: note):\n${notes.map((n) => `- ${n.id}: ${n.content}`).join('\n')}` : '',
    memory ? notebookPrompt(agent) : '',
    teamPrompt(agent, uid),
    memory ? 'If this run taught you something lasting about the agency (a rule, a recurring problem, how a number behaves), save it with note_for_agent before you write the report.' : '',
    roleBlock(agent),
    `Your tools: ${tools.join(', ') || 'none'}. Without the metrics tool you cannot read numbers; say so instead of guessing.`,
    strategyPrompt(),
  ].filter(Boolean).join('\n\n');
}

/** Sends a report where the routine delivers (Telegram, Slack), each on its own; a test run sends it to the tester only, saying where it would have gone. */
async function deliverTo(r: Routine, report: string, test: { slackTo: string } | undefined, delivered: string[], problems: string[]) {
  if (test) {
    const where = [r.deliver.slack ? `Slack ${r.deliver.slack}` : '', r.deliver.telegram ? `Telegram ${r.deliver.telegram}` : ''].filter(Boolean).join(' and ') || 'nowhere (conversation only)';
    const o = await sendSlack(test.slackTo, `[TEST · would deliver to ${where}]\n${report}`);
    if ('ok' in o) delivered.push('test Slack'); else problems.push(o.error);
    return;
  }
  if (r.deliver.telegram) { const o = await sendTelegram(r.deliver.telegram, report); if ('ok' in o) delivered.push('Telegram'); else problems.push(o.error); }
  if (r.deliver.slack) { const o = await sendSlack(r.deliver.slack, report); if ('ok' in o) delivered.push('Slack'); else problems.push(o.error); }
}

export interface RunOutcome { status: 'ok' | 'skipped' | 'error'; summary: string; threadId: number | null; delivered: string[] }

/** Runs one routine now. `how`: the scheduler or Run now. Refuses (returns { refused }) when it is still running or two are going. */
/** test (D, 2026-10-28: "test them with me"): every Slack post and the delivery go to test.slackTo marked with where they would have gone,
 *  and no change is made (tools.ts testGate). */
export async function runRoutine(id: number, how: 'schedule' | 'manual', test?: { slackTo: string }): Promise<RunOutcome | { refused: string }> {
  const claim = claimRun(id, how);
  if ('refused' in claim) return claim;
  const r = getRoutine(id)!;
  let threadId: number | null = null;
  const end = (o: Omit<RunOutcome, 'threadId' | 'delivered'> & { delivered?: string[]; output?: string }): RunOutcome => {
    finishRun(id, claim.runId, { status: o.status, summary: test ? `[test] ${o.summary}` : o.summary, threadId, output: o.output });
    return { ...o, threadId, delivered: o.delivered ?? [] };
  };
  try {
    const uid = r.created_by;
    const role = getGrant(uid).role;
    if (role !== 'owner' && role !== 'admin') return end({ status: 'error', summary: 'Its creator no longer has AI access (owner or admin).' });
    // script routines and condition scripts (D, 2026-10-28; docs/AGENT_WORKSPACE.md): a command in the agency's workspace as the creator,
    // its scripts reaching Fleet with a key that has the routine agent's tools (Slack posts included: the creator saved this script)
    if (r.script.trim() || r.condition_script.trim()) {
      const agency = isMultiTenant() ? currentAgencySync().id : undefined;
      const picked0 = getAgent(r.agent_id), agent0 = picked0 && canUseAgent(picked0, uid) ? picked0 : defaultAgent();
      const tools0 = agent0 ? agentTools(agent0) : agentTools({ tools: [], use_memory: true });
      const syncErr = await syncTeamSkills(agency, uid);
      if (syncErr) return end({ status: 'error', summary: syncErr });
      const inWorkspace = async (command: string, seconds: number, tag: string) => {
        const key = mintScriptRunKey(uid, tools0, agent0?.apps ?? [], seconds, test);
        try {
          const x = await runInWorkspace(agency, ['/bin/bash', '-c', command], { seconds, runKey: key });
          logWorkspace(uid, null, tag, `${r.name}: ${command}`, x.code, x.ms);
          return x;
        } finally { revokeRunKey(key); }
      };
      if (r.condition_script.trim()) {
        const c = await inWorkspace(r.condition_script, 120, 'routine_condition');
        if (c.code !== 0) return end({ status: 'skipped', summary: lastLine(c.out) || `The condition script said no (exit ${c.code ?? 'none'}).`, output: c.out });
      }
      if (r.script.trim()) {
        const x = await inWorkspace(r.script, 3600, 'routine_script');
        const ok = x.code === 0, last = lastLine(x.out);
        const delivered: string[] = [], problems: string[] = [];
        // most scripts post for themselves; a Slack or Telegram delivery set on the routine gets the output's end
        const report = `${r.name}\n\n${x.out.trim().slice(-3500) || '(no output)'}`;
        if (ok) await deliverTo(r, report, test, delivered, problems);
        const summary = ok ? last || 'Done (no output).' : x.timedOut ? 'Stopped after 1 hour.' : `Failed (exit ${x.code ?? 'none'}): ${last}`;
        return end({ status: ok ? 'ok' : 'error', summary: [summary, ...problems.map((p) => `Not sent: ${p}`)].join(' · '), output: x.out, delivered });
      }
    }
    let cond = r.condition.trim();
    // condition @usage-report (D, 2026-10-13): a plain report from the AI's own usage records, no AI run
    if (cond === '@usage-report') {
      const report = usageReport(reportTz());
      if (!report) return end({ status: 'skipped', summary: 'Nothing wrong.' });
      const delivered: string[] = [], problems: string[] = [];
      await deliverTo(r, report, test, delivered, problems);
      return end({ status: problems.length && !delivered.length ? 'error' : 'ok', summary: [report.split('\n')[1] ?? '', ...problems.map((x) => `Not sent: ${x}`)].join(' · '), delivered });
    }
    // when:<event> (lib/ai/triggers.ts): what happened goes into the prompt; a scheduled wake with nothing new is skipped
    if (cond.startsWith('when:')) {
      const happened = (await import('./triggers')).takeEvent(r.id);
      if (!happened && how === 'schedule') return end({ status: 'skipped', summary: 'Nothing happened.' });
      cond = happened ? `this happened (${cond.slice(5).replace(/_/g, ' ')}):\n${happened}` : `${cond.slice(5).replace(/_/g, ' ')} (run by hand: check for it yourself)`;
    }
    const picked = getAgent(r.agent_id);
    const agent = picked && canUseAgent(picked, uid) ? picked : defaultAgent();
    const model = modelOrDefault(agent?.model);
    const runner = RUNNERS[model.provider];
    if (!runner) return end({ status: 'error', summary: `${model.label} is not connected.` });
    const capped = overBudget(agent?.id); // the agent's own daily cap (usage.ts)
    if (capped) return end({ status: 'error', summary: capped });
    // nobody is watching a routine to say yes: the ask-first tools that act at once (Slack posts, skills) never run here; delivery posts
    // a test run keeps propose_slack_post (testGate sends it to the tester), so it shows where the routine would post
    const tools = (agent ? agentTools(agent) : agentTools({ tools: [], use_memory: true })).filter((t) => (test && t === 'propose_slack_post') || !ASK_IN_CHAT.includes(t));
    const { prompt } = expandSkill(r.prompt, listSkills(uid));
    const name = (db.prepare('SELECT username FROM users WHERE id = ?').get(uid) as { username?: string } | undefined)?.username ?? 'the owner';

    const date = new Date().toLocaleDateString('en-US', { timeZone: reportTz(), month: 'short', day: 'numeric' });
    const thread = createThread(uid, `${r.name} · ${date}`, crypto.randomUUID(), agent?.id ?? null);
    threadId = thread.id;
    addMessage(thread.id, 'user', `${cond ? `Only run if: ${cond}\n\n` : ''}${r.prompt}\n\n(Routine "${r.name}", ${how === 'manual' ? 'run by hand' : describeCron(r.schedule)})`);

    const key = mintRunKey(uid, thread.id, tools, agent?.apps ?? [], { depth: 0, chain: agent ? [agent.id] : [], ownerStarted: false }); // nobody typed it: its hand-offs never act outside
    if (test) setRunTest(key, test);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RUN_LIMIT_MS);
    // reply = everything it wrote (the conversation keeps it); tail = what it wrote after its last tool call, the report that is sent
    let reply = '', tail = '';
    const steps: Step[] = [], byId = new Map<string, number>();
    const res = await runner({
      system: systemPrompt(name, r, listMemory(uid), agent, tools, uid), prompt: routinePrompt(prompt, cond),
      session: { id: thread.session_id, resume: false }, model: model.wire, tools, signal: ac.signal,
      mcp: { url: `http://127.0.0.1:${appPort()}/api/ai/mcp`, key },
      onText: (d) => { reply += d; tail += d; },
      onToolStart: (tid, tool, input) => {
        if (byId.has(tid)) return;
        byId.set(tid, steps.push({ name: tool, title: stepTitle(tool, input), status: 'running' }) - 1);
        tail = '';
        if (reply && !reply.endsWith('\n\n')) reply += '\n\n';
      },
      onToolEnd: (tid, isError) => { const n = byId.get(tid); if (n !== undefined) steps[n].status = isError ? 'error' : 'done'; },
    }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    clearTimeout(timer); revokeRunKey(key);
    const error = res.error ?? (ac.signal.aborted ? 'Stopped after 15 minutes.' : undefined);
    recordTurn({ threadId: thread.id, userId: uid, agentId: agent?.id ?? null, model: model.id, source: 'routine', context: 'context' in res ? res.context : undefined, usage: 'usage' in res ? res.usage : undefined, ok: !error });
    const text = reply.trim();

    const skip = !error ? skipReason(text) : null;
    if (skip !== null) {
      // a skipped run leaves no conversation behind (an hourly check would fill the list); the runs history keeps the reason
      deleteThread(uid, thread.id); threadId = null;
      return end({ status: 'skipped', summary: skip });
    }
    addMessage(thread.id, 'assistant', text || (error ? `(stopped: ${error})` : '(no answer)'), steps, (await import('./send-file')).takeSentFiles(thread.id));
    if (error) return end({ status: 'error', summary: error });

    // send results to: Telegram and Slack, each on its own (one failing never stops the other or fails the run)
    const delivered: string[] = [], problems: string[] = [];
    // a report that starts with its own bold title line (a Slack post written to an exact format, D 2026-10-12) goes out as written
    const final = tail.trim() || text;
    const report = /^\*[^*\n]+\*/.test(final) ? final : `${r.name}\n\n${final}`;
    await deliverTo(r, report, test, delivered, problems);
    const first = final.replace(/```[\s\S]*?```/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    return end({ status: 'ok', summary: [first, ...problems.map((p) => `Not sent: ${p}`)].filter(Boolean).join(' · '), delivered });
  } catch (e) {
    return end({ status: 'error', summary: e instanceof Error ? e.message : String(e) });
  }
}
