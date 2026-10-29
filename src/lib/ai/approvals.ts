import 'server-only';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { addMessage, listSkills, saveSkill, saveSkillFile, skillFilePath, skillFolder } from './store';
import { skillSlug } from './catalog';

// Approve cards (D, 2026-10-09: "it asks before changing anything", approval bar). A change tool never changes anything
// itself: it files a proposal here and the chat shows it as a card. Only the person the conversation belongs to can approve; the
// change then runs through the app's own action with that person's rights, and the result lands in the conversation.
const ready = schemaOnce(); // per agency database: a module flag skipped the tables in every agency after the first (2026-10-10)
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, user_id INTEGER NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL,
    summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), decided_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_ai_approvals_thread ON ai_approvals (thread_id, id);`);
  ready.mark();
}
export interface Approval { id: number; thread_id: number; user_id: number; tool: string; args: string; summary: string; status: 'pending' | 'approved' | 'denied' | 'failed'; result: string; created_at: string }

export function propose(userId: number, threadId: number, tool: string, args: Record<string, unknown>, summary: string): number {
  ensure();
  return Number(db.prepare('INSERT INTO ai_approvals (thread_id, user_id, tool, args, summary) VALUES (?, ?, ?, ?, ?)').run(threadId, userId, tool, JSON.stringify(args), summary.slice(0, 400)).lastInsertRowid);
}
export function listApprovals(userId: number, threadId: number): Approval[] {
  ensure();
  return db.prepare('SELECT * FROM ai_approvals WHERE thread_id = ? AND user_id = ? ORDER BY id').all(threadId, userId) as Approval[];
}
/** Every approve card still waiting, newest first (Operations › Fleet health: runs waiting for someone). */
export function pendingApprovals(limit = 100): Approval[] {
  ensure();
  return db.prepare("SELECT * FROM ai_approvals WHERE status = 'pending' ORDER BY id DESC LIMIT ?").all(limit) as Approval[];
}

/** What each change tool does once approved: the app's own action, run as the approver. */
const EXECUTE: Record<string, (userId: number, a: Record<string, unknown>) => Promise<string>> = {
  // a saved key's first trip to a site (lib/ai/secrets.ts): the yes is remembered for that key and host, then the request runs; the answer
  // is scrubbed of every key value before it is stored or posted
  http_request: async (_u, a) => {
    const sec = await import('./secrets');
    const { redactSecrets, secretNeedles, envSecrets } = await import('./tool-guard');
    const req = a as unknown as import('./secrets').HttpReq, host = sec.checkRequest(req);
    for (const n of sec.secretsIn(req)) sec.approveHost(n, host);
    const out = await sec.sendRequest(req);
    return redactSecrets(out, secretNeedles({ ...envSecrets(), ...sec.savedKeyValues() })).text.slice(0, 3000);
  },
  app_run: async (_u, a) => {
    const { runAppTool } = await import('./app-tools');
    const out = await runAppTool(String(a.tool), (a.data ?? {}) as Record<string, unknown>);
    return `Ran ${a.tool}. ${out.slice(0, 300)}`;
  },
  propose_experiment: async (userId, a) => {
    // the agency's experiments log (Operations, 2026-10-10): a new one, or an update to one by id (result, decision, status)
    const { cleanExperiment, getExperiment, saveExperiment } = await import('@/lib/operations/store');
    const id = Number(a.id) || undefined;
    const cur = id ? getExperiment(id) : undefined;
    if (id && !cur) throw new Error('That experiment is gone.');
    const e = cleanExperiment(a, cur);
    if (typeof e === 'string') throw new Error(e);
    const saved = saveExperiment(userId, e, id, 'ai');
    return `${id ? 'Updated' : 'Logged'} the experiment "${saved.title}" (#${saved.id}, ${saved.status}${saved.decision ? `, ${saved.decision}` : ''}). It shows on Intelligence › Experiments.`;
  },
  propose_strategy: async (userId, a) => {
    // Operations › Strategy (D, 2026-10-28: agents update it after asking); each change logs in the page's history as this approver
    const S = await import('@/lib/operations/store');
    const done: string[] = [];
    for (const f of S.STRATEGY_FIELDS) if (typeof a[f] === 'string') { S.setStrategyField(f, a[f] as string, userId); done.push(f.replace('_', ' ')); }
    if (Array.isArray(a.goals) && a.goals.length) {
      const moves = new Map((a.goals as { id: number; progress?: number; title?: string }[]).map((g) => [Number(g.id), g]));
      S.saveGoals(S.listGoals().map((g) => ({ id: g.id, ...(moves.get(g.id) ?? {}) })), userId); // the whole list, in its order, so nothing moves
      done.push(`${moves.size} goal${moves.size === 1 ? '' : 's'}`);
    }
    if (typeof a.new_goal === 'string' && a.new_goal.trim()) { const g = S.addGoal(a.new_goal, userId); if (typeof g === 'string') throw new Error(g); done.push('a new goal'); }
    return `Updated Strategy: ${done.join(', ')}. It shows on Operations › Strategy.`;
  },
  propose_slack_post: async (_u, a) => {
    // the agency's own AI Agents Slack bot (D, 2026-10-10); runs in the approver's agency (decide() is called from their request)
    const { postMessage, dm } = await import('@/lib/slack/post');
    // shown as the person who asked ("Sam (via the AI)", chat:write.customize) when known
    const { slackWithCharts } = await import('@/lib/charts/slack-charts'); // ctrl-chart / ctrl-table blocks go as images (D, 2026-10-23)
    const content = { ...await slackWithCharts(String(a.text ?? ''), a.markdown === true), username: typeof a.as === 'string' && a.as ? a.as : undefined };
    // a person's id posted straight lands in their Slackbot chat, not the bot's DM: open the DM first
    const r = /^[UW]/.test(String(a.channel ?? '')) && !a.thread_ts ? await dm(null, String(a.channel), content)
      : await postMessage(null, String(a.channel ?? ''), content, typeof a.thread_ts === 'string' ? a.thread_ts : null);
    if ('error' in r) throw new Error(r.error);
    return `Posted to Slack ${/^[UW]/.test(String(a.channel)) ? 'as a direct message to ' : '#'}${String(a.channel).replace(/^#/, '')}${a.thread_ts ? ' (in the thread)' : ''}.`;
  },
  save_routine: async (userId, a) => {
    const { canEditRoutine, createRoutine, getRoutine, routineInput, updateRoutine } = await import('./routines');
    const { getGrant } = await import('@/lib/user-access');
    const { describeCron } = await import('./cron');
    const role = getGrant(userId).role, id = Number(a.id) || 0;
    const cur = id ? getRoutine(id) : undefined;
    if (id && !cur) throw new Error(`No routine #${id}.`);
    if (cur && !canEditRoutine(cur, userId, role)) throw new Error('A team routine: only the owner or its maker changes it.');
    const base = cur ? { name: cur.name, prompt: cur.prompt, schedule: cur.schedule, agent_id: cur.agent_id, enabled: cur.enabled, deliver: cur.deliver, condition: cur.condition, script: cur.script, condition_script: cur.condition_script } : {};
    const input = routineInput({ ...base, ...a, enabled: a.enabled ?? (cur ? cur.enabled : true) }, userId, role);
    if (typeof input === 'string') throw new Error(input);
    const r = cur ? updateRoutine(cur.id, input)! : createRoutine({ ...input, shared: input.shared ?? role === 'owner' }, userId);
    return `${cur ? 'Updated' : 'Made'} routine #${r.id} "${r.name}": ${describeCron(r.schedule)}${r.deliver.slack ? `, posts to #${r.deliver.slack}` : ''}${r.enabled ? '' : ' (off)'}. It shows in AI › Routines.`;
  },
  propose_skill: async (userId, a) => {
    const name = skillSlug(String(a.name ?? a.title ?? ''));
    if (name.length < 2 || !String(a.body ?? '').trim()) throw new Error('The skill needs a command and instructions.');
    const share = a.share === 'team' ? 'team' : 'me', agentId = typeof a.agent_id === 'number' ? a.agent_id : null;
    const mine = a.replace ? (listSkills(userId).find((k) => k.name === name && k.user_id === userId)?.id) : undefined;
    const sk = saveSkill(userId, { name, title: String(a.title ?? '').slice(0, 60), ...(a.folder !== undefined ? { folder: skillFolder(a.folder) } : {}), description: String(a.description ?? '').slice(0, 4000), body: String(a.body).slice(0, 200_000), share, agentId }, mine);
    // the skill's other files (D, 2026-10-27: skills as folders), e.g. references/pricing.md
    const files = Array.isArray(a.files) ? (a.files as { path?: unknown; body?: unknown }[]).slice(0, 50) : [];
    const bad = files.filter((f) => !skillFilePath(f.path)).map((f) => String(f.path));
    for (const f of files) if (skillFilePath(f.path)) saveSkillFile(userId, sk.id, skillFilePath(f.path), String(f.body ?? '').slice(0, 200_000));
    return `${mine ? 'Updated' : 'Saved'} the skill /${name}${files.length ? ` with ${files.length - bad.length} file${files.length - bad.length === 1 ? '' : 's'}` : ''}${share === 'team' ? ' for the whole team' : ''}. Type /${name} in any chat to run it.${bad.length ? ` Skipped bad file paths: ${bad.join(', ')}.` : ''}`;
  },
};
export const CHANGE_TOOLS = Object.keys(EXECUTE);

/** Do a change now (D, 2026-10-22: "it should just do it on its own"): the person asked for it in the conversation, so no card. Kept as an approved row, so the change list still shows who did what. Returns what happened, or throws. */
export async function actNow(userId: number, threadId: number, tool: string, args: Record<string, unknown>, summary: string): Promise<string> {
  const id = propose(userId, threadId, tool, args, summary);
  let status: Approval['status'] = 'approved', result = '';
  try { result = await (EXECUTE[tool] ?? (async () => { throw new Error('Unknown change.'); }))(userId, args); }
  catch (e) { status = 'failed'; result = e instanceof Error ? e.message : String(e); }
  db.prepare(`UPDATE ai_approvals SET status = ?, result = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(status, result.slice(0, 600), id);
  if (status === 'failed') throw new Error(result);
  return result;
}

/** actNow: done when asked, also after the turn read Slack posts, GHL notes, calls or a file (D, 2026-10-26: "no more cards at all";
 *  overrides the 2026-10-23 audit card, since Slack has no Approve button and mirroring a Slack board always reads Slack). */
export async function actOrAsk(_untrusted: boolean, userId: number, threadId: number, tool: string, args: Record<string, unknown>, summary: string): Promise<string> {
  return actNow(userId, threadId, tool, args, summary);
}

export async function decide(userId: number, id: number, approve: boolean): Promise<Approval> {
  ensure();
  const a = db.prepare('SELECT * FROM ai_approvals WHERE id = ? AND user_id = ?').get(id, userId) as Approval | undefined;
  if (!a) throw new Error('Not found.');
  if (a.status !== 'pending') return a;
  let status: Approval['status'] = approve ? 'approved' : 'denied', result = approve ? '' : 'Left as it was.';
  if (approve) {
    try { result = await (EXECUTE[a.tool] ?? (async () => { throw new Error('Unknown change.'); }))(userId, JSON.parse(a.args)); }
    catch (e) { status = 'failed'; result = e instanceof Error ? e.message : String(e); }
  }
  db.prepare(`UPDATE ai_approvals SET status = ?, result = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(status, result.slice(0, 600), id);
  addMessage(a.thread_id, 'assistant', status === 'approved' ? `Done: ${result}` : status === 'failed' ? `Could not make the change: ${result}` : `Not changed: ${a.summary}`);
  // a no is a correction: the agent writes one rule for next time (lib/ai/lessons.ts), in the background
  if (status === 'denied') void import('./lessons').then((m) => m.lessonFromDenial({ threadId: a.thread_id, userId, tool: a.tool, summary: a.summary }));
  return { ...a, status, result };
}
