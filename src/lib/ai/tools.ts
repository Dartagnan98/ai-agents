import 'server-only';
import { zoneMidnight } from '@/lib/tz';
import crypto from 'crypto';
import { getGrant } from '@/lib/user-access';
import { aiTierOf, type AiTier } from './access';
import { addAgentNote, addMemory, deleteAgentNote, deleteMemory, getAgent, listMemory, listSkills, threadAgentId } from './store';
import { actOrAsk, propose } from './approvals';
import { formatHits, hasTeamMemory, searchMemory } from './team-memory';
import { fileText, readFileLines, searchFileLines, threadAttachments } from './attachments';
import { TOOL_INFO } from './catalog';
import { clip, describeRun, editArgs, logWorkspace, readArgs, runInWorkspace, searchArgs, syncTeamSkills, writeArgs } from './workspace';
import { db } from '@/lib/db';
import { getBrand } from '@/lib/brand';
import { appOfTool, isReadTool, runAppTool, searchAppTools } from './app-tools';
import { isMultiTenant } from '@/lib/platform/mode';
import { runWithTenant } from '@/lib/platform/context';
import { currentAgencySync } from '@/lib/platform/tenant-db';
import { reportTz } from '@/lib/report-tz';
import { getDoc, isSpace, searchDocs } from '@/lib/knowledge/docs';
import { cleanExperiment, EXP_STATUSES, getExperiment, getStrategy, goalHistory, listExperiments, listGoals, type ExpStatus, type Experiment } from '@/lib/operations/store';
import { tzAbbr } from '@/lib/tz';
import { botToken } from '@/lib/slack/app';
import { botChannels, channelDayLines, channelHistory, slackPeople } from '@/lib/slack/read';
import { saveChartPng } from '@/lib/charts/slack-charts';
import { pageName, savePage } from './published-pages';
import { agencySecretValues } from '@/lib/agency-secrets';
import { CONN_KINDS, connSecret } from './connections';
import { envSecrets, guardToolOutput } from './tool-guard';
import { savedKeyValues } from './secrets';

// the agents tools (the server half of app/api/ai/mcp): what headless Claude can reach, as the person who asked. Every read goes through
// the same code the pages use (the metrics snapshot = every card and table), so the AI's numbers match the screen. Each run holds a
// short-lived key tied to one login and one conversation; an admin only reaches the contracts their login can open. Step 1 is read
// only plus memory notes; changes come with Approve cards next.

// ─── run keys (one per message, gone after 15 minutes; this app copy only, which is the one that started the run) ───
// The key also carries the agent's tool allow-list (D, 2026-10-09: agents): tools/list and tools/call only see those.
// agency (D, 2026-10-09, multi-agency mode): the run's agency, so the tool server (a loopback call with no cookie) acts as it
// comms (D, 2026-10-23): where this run sits in an agent chain (comms.ts); a chat run is step 0, started by the person typing
export type RunKey = { userId: number; threadId: number; tools: string[]; exp: number; agency?: string; apps?: string[]; comms?: { depth: number; chain: number[]; ownerStarted: boolean };
  /** text other people wrote came into this turn (Slack, GHL, calls, apps, files): act-at-once changes become cards (audit 2026-10-23) */
  untrusted?: boolean;
  /** a key a workspace script holds (mintChildRunKey): the run that started it, told when the script reads outside text */
  parentRun?: RunKey;
  /** a script routine's key (mintScriptRunKey): fixed code its owner/admin saved, not a model a read could steer, so reads never make it untrusted */
  fixedScript?: boolean;
  /** a test run (D, 2026-10-28: "test them with me"): every Slack post goes to this Slack id (DM or channel) marked with where it would
   *  have gone, and every change (API writes, change tools) is reported, not made */
  test?: { slackTo: string; posted?: number } };
const g = globalThis as unknown as { __fleetAiKeys?: Map<string, RunKey> };
const keys = (g.__fleetAiKeys ??= new Map());
/** One page of a long skill or skill file (D 2026-10-28): 20,000 characters, a tool answer carries it whole. */
const SKILL_PAGE = 20_000;
export function skillPage(body: string, off: number): string {
  const page = body.slice(off, off + SKILL_PAGE), next = off + page.length;
  return next < body.length ? `${page}\n\n[part ${Math.floor(off / SKILL_PAGE) + 1} of ${Math.ceil(body.length / SKILL_PAGE)}: call read_skill again with offset ${next} (next_offset ${next})]` : page;
}

export function mintRunKey(userId: number, threadId: number, tools: string[], apps: string[] = [], comms?: RunKey['comms']): string {
  for (const [k, v] of keys) if (v.exp < Date.now()) keys.delete(k);
  const key = `fai_${crypto.randomBytes(24).toString('hex')}`;
  keys.set(key, { userId, threadId, tools, apps, comms, exp: Date.now() + 15 * 60_000, ...(isMultiTenant() ? { agency: currentAgencySync().id } : {}) });
  return key;
}
export function revokeRunKey(key: string) { keys.delete(key); }
/** Makes a run a test run (RunKey.test). */
export function setRunTest(key: string, test: RunKey['test']) { const v = keys.get(key); if (v) v.test = test; }
/** A Slack id a test run may post to: a person (U...), a DM (D...) or a channel (C.../G...). */
export const TEST_SLACK = /^[UDCG][A-Z0-9]{6,15}$/;
// in a test run nothing changes: these report what they would do (memory notes still save)
const TEST_BLOCKED = new Set(TOOL_INFO.filter((t) => (t.change || t.write) && t.name !== 'propose_slack_post').map((t) => t.name));
/** A test run's gate: a string = the answer instead of running the tool; null = go on (a Slack post's args are moved to the test target). */
export function testGate(run: RunKey, name: string, args: Record<string, unknown>): string | null {
  if (!run.test) return null;
  const json = (v: unknown) => JSON.stringify(v ?? {}).slice(0, 600);
  if (name === 'propose_slack_post') {
    const to = String(args.channel ?? ''), thread = typeof args.thread_ts === 'string' ? ' as a thread reply' : '';
    // a test starts without the script's saved state, so it may think everything is new: 5 posts reach the tester, the rest are listed
    run.test.posted = (run.test.posted ?? 0) + 1;
    if (run.test.posted > 5) return `[TEST: not sent, over 5 test posts] to ${to}${thread}: ${String(args.text ?? '').slice(0, 200)}`;
    args.text = `[TEST · would post to ${to}${thread}]\n${String(args.text ?? '')}`;
    args.channel = run.test.slackTo;
    delete args.thread_ts;
    return null;
  }
  if (TEST_BLOCKED.has(name)) return `[TEST: not done] ${name} ${json(args)}`;
  return null;
}
/** A key for a script routine's command (D, 2026-10-28): its creator, the given tools minus the workspace ones, no conversation. */
export function mintScriptRunKey(userId: number, tools: string[], apps: string[], seconds: number, test?: RunKey['test']): string {
  const key = `fai_${crypto.randomBytes(24).toString('hex')}`;
  keys.set(key, { userId, threadId: 0, tools: [...tools.filter((t) => !t.startsWith('workspace_')), 'publish_image', 'publish_page', 'ai_json'], apps, fixedScript: true, exp: Date.now() + (seconds + 60) * 1000, test,
    comms: { depth: 0, chain: [], ownerStarted: false }, ...(isMultiTenant() ? { agency: currentAgencySync().id } : {}) });
  return key;
}
/** A key for the scripts of one workspace command: the same person, conversation and tools minus the workspace ones (a script cannot
 *  start more sandboxes), gone when the command ends. */
export function mintChildRunKey(run: RunKey, seconds: number): string {
  const key = `fai_${crypto.randomBytes(24).toString('hex')}`;
  keys.set(key, { ...run, tools: [...run.tools.filter((t) => !t.startsWith('workspace_')), 'publish_image', 'publish_page', 'ai_json'], parentRun: run, exp: Date.now() + (seconds + 60) * 1000 });
  return key;
}
/** The turn read text other people wrote (recalled Slack/call pieces, an attached file): see RunKey.untrusted. */
export function markRunUntrusted(key: string) { const v = keys.get(key); if (v) v.untrusted = true; }
// tools whose answer carries text other people wrote (a prompt injection could ride in on it)
const OUTSIDE_TEXT = new Set(['http_request', 'slack_read', 'slack_history', 'search_memory', 'memory_graph', 'app_run', 'read_file', 'search_file']);
export function runKeyUser(key: string): RunKey | null {
  const v = keys.get(key);
  return v && v.exp > Date.now() ? v : null;
}

/** What each login's AI may use: the owner and admins every tool; other logins only their own notes and the files they attach. */
const PAGE_TIER_TOOLS = new Set(['remember', 'recall_memory', 'forget_memory', 'read_file', 'search_file']);
const CLIENT_TIER_TOOLS = new Set(['remember', 'recall_memory', 'forget_memory', 'read_file', 'search_file']);
export function toolAllowedFor(tier: AiTier, name: string): boolean {
  return tier === 'full' || (tier === 'client' ? CLIENT_TIER_TOOLS : PAGE_TIER_TOOLS).has(name);
}
const tierOf = (userId: number) => aiTierOf(getGrant(userId).role);

export const TOOLS = [
  {
    name: 'search_knowledge',
    description: 'Search the Knowledge documents (Intelligence › Knowledge: offers, scripts, SOPs, team notes). Returns ranked matches with ids and snippets; pass id to read a document in full. Read only.',
    input_schema: { type: 'object', properties: {
      query: { type: 'string', description: 'Words to look for' },
      space: { type: 'string', description: 'knowledge or wiki (default both)' },
      id: { type: 'number', description: 'Read this document in full instead of searching' },
    } },
  },
  {
    name: 'read_goals',
    description: 'This agency\'s Strategy page (Operations › Strategy): north star, current bottleneck, today\'s focus, the goals in priority order with progress, '
      + 'and the latest changes. Read only.',
    input_schema: { type: 'object', properties: { history: { type: 'number', description: 'How many recent changes to include (default 10, max 50)' } } },
  },
  {
    name: 'read_experiments',
    description: 'This agency\'s experiments log (Intelligence › Experiments): each test\'s hypothesis, metric, dates, status, result and keep or discard. '
      + 'Filter by status, or pass id for one in full. Read only.',
    input_schema: { type: 'object', properties: {
      status: { type: 'string', description: 'planned, running or done (default all)' },
      id: { type: 'number', description: 'Read this experiment in full' },
    } },
  },
  {
    name: 'remember',
    description: 'Save a lasting fact or preference about this user or their business, to read in every later conversation. One short sentence. Never secrets.',
    input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
  },
  {
    name: 'recall_memory',
    description: 'List the memory notes saved for this user (optionally only those containing some words).',
    input_schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    name: 'forget_memory',
    description: 'Delete one memory note by id (from recall_memory) when the user says it is wrong or no longer true.',
    input_schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'slack_read',
    description: 'Read one Slack channel\'s messages for one day (the agency\'s day), as the agency\'s Slack bot, oldest first, with who posted each (name and Slack id) and thread replies. '
      + 'The bot must be in the channel. Read only: posting goes through propose_slack_post or a routine\'s Slack delivery. Use it for live counts the dashboard has not synced yet, such as deal posts.',
    input_schema: { type: 'object', properties: {
      channel: { type: 'string', description: 'Channel id, e.g. C09DK48DTDK' },
      day: { type: 'string', description: 'YYYY-MM-DD' },
      replies: { type: 'boolean', description: 'Also read the replies in each thread (slower)' },
    }, required: ['channel', 'day'] },
  },
  {
    name: 'slack_history',
    description: 'Owner and admins: a Slack channel\'s raw messages over any window, oldest first, as JSON {messages: [{ts, user (Slack id), text, thread_ts, reply_count}], next_oldest}: '
      + 'call again with since = next_oldest for the next page. For scripts and long reads (slack_read is one day, formatted). Channels only; the bot must be in it.',
    input_schema: { type: 'object', properties: { channel: { type: 'string', description: 'Channel id (C...) or #name' },
      since: { type: 'string', description: 'Slack ts (1730000000.000100) or YYYY-MM-DD (@TZ midnight); messages after it' },
      until: { type: 'string', description: 'Same forms; default now' }, limit: { type: 'number', description: 'Default 1000, at most 5000' },
      threads: { type: 'boolean', description: 'Also thread replies (slower)' } }, required: ['channel', 'since'] },
  },
  {
    name: 'ai_json',
    description: 'Workspace scripts only: one model answer as a JSON object that fits output_schema (a JSON Schema), from prompt + input_text. '
      + 'Returns {result} or {error}. The sdk\'s ai_structured_output calls this.',
    input_schema: { type: 'object', properties: { prompt: { type: 'string' }, output_schema: { type: 'object' }, input_text: { type: 'string' } }, required: ['prompt'] },
  },
  {
    name: 'publish_image',
    description: 'Workspace scripts only: publishes a PNG (base64) as a private-link image and returns {url} for a Slack post or a message. '
      + 'The sdk\'s html_to_image calls this; anyone with the link sees that one image, kept 90 days.',
    input_schema: { type: 'object', properties: { png_base64: { type: 'string' }, title: { type: 'string' } }, required: ['png_base64'] },
  },
  {
    name: 'publish_page',
    description: 'Workspace scripts only: publishes an HTML page at a stable link {url} under this app. '
      + 'Publishing the same name replaces it. Everyone needs an agency sign-in; access "specific_members" opens it to owners, admins and the given Slack members only.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, html: { type: 'string' }, access: { type: 'string', enum: ['public', 'workspace', 'specific_members'] },
      members: { type: 'array', items: { type: 'string' }, description: 'Slack user ids (specific_members)' } }, required: ['name', 'html'] },
  },
  {
    name: 'slack_people',
    description: 'Find people in this agency\'s Slack by name or email: their Slack id (for a direct message with propose_slack_post), name, title and email. Active members only. Read only.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Part of a name or an email, e.g. "Dart"' }, all: { type: 'boolean', description: 'Workspace scripts only: every active member as JSON (no query)' } } },
  },
  {
    name: 'memory_graph',
    description: 'The memory graph: the reps and client contracts found in memory, and how they connect. name = look one up: what it is, its profile, its relationships, '
      + 'who or what it is mentioned with most, and the newest memory about it. No name = list what the graph knows (optionally one kind: rep or contract). Read only.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'Who or what to look up, e.g. Alex Kim or ACME' },
      kind: { type: 'string', description: 'When listing: rep or contract' }, limit: { type: 'number', description: 'When listing: how many (default 60)' } } },
  },
  {
    name: 'search_memory',
    description: 'Search the agency\'s team memory: decisions and lasting facts from the owner and admins\' conversations (who and when), their past AI chats, '
      + 'Slack channels the bot is in, call reviews and Knowledge. By meaning and by words. Use it for "what did we decide about", "when did we change", '
      + '"what did X say in Slack about". The most relevant few are already given to you each turn as Team memory; this digs deeper. Read only.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for, in plain words' }, limit: { type: 'number', description: 'How many (default 10, at most 25)' } }, required: ['query'] },
  },
  {
    name: 'read_file',
    description: 'Reads a file the person attached in this conversation (text, CSV, Excel as CSV per sheet, Word, PowerPoint), by line: from_line and lines, '
      + 'up to 40,000 characters a call; the answer says the next from_line. Long files show only their start in the message: page through the rest with this. '
      + 'Without file it lists the conversation\'s files. Read only.',
    input_schema: { type: 'object', properties: { file: { type: 'string', description: 'The file id from the message, or its name' },
      from_line: { type: 'number', description: 'First line, 1-based (default 1)' }, lines: { type: 'number', description: 'How many lines (default 400, at most 2000)' } } },
  },
  {
    name: 'search_file',
    description: 'Finds the lines of a file attached in this conversation that contain every word of the query (any case), with line numbers to read_file around. Read only.',
    input_schema: { type: 'object', properties: { file: { type: 'string', description: 'The file id from the message, or its name' }, query: { type: 'string', description: 'Words to find' },
      max: { type: 'number', description: 'How many lines (default 100, at most 500)' } }, required: ['file', 'query'] },
  },
  // Agent workspace (D, 2026-10-27; lib/ai/workspace.ts): the agency's own folder where commands run sandboxed
  {
    name: 'workspace_run',
    description: 'Owner and admins: runs a shell command in this agency\'s workspace, a private folder on the server seen as /work '
      + '(skills/ = every team skill with its files, kept in step; state/ data/ temp/ out/ tmp/ are yours). Python 3 (dateutil, openpyxl, fitz, weasyprint) and the usual Unix tools. '
      + 'Scripts reach Fleet with `import fleet` (fleet.ghl.get/post, fleet.zoom.get, fleet.slack.post/history/people, fleet.numbers, fleet.sql, fleet.call(tool, ...)): '
      + 'as this person, keys never visible; Sandboxed: no internet, no access to the app, its database or keys, 1 GB memory, '
      + 'up to 15 minutes. Files persist between runs. Returns the exit code and the output (long output keeps its start and end).',
    input_schema: { type: 'object', properties: { command: { type: 'string', description: 'The command, run with bash -c from the workspace folder, e.g. "python3 skills/x/run.py --day 2026-10-27"' },
      timeout_sec: { type: 'number', description: 'Seconds before it is stopped (default 120, at most 900)' } }, required: ['command'] },
  },
  {
    name: 'workspace_read',
    description: 'Owner and admins: reads a file in the workspace by line (from_line, lines; up to 40,000 characters a call; the answer says the next from_line).',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Path inside the workspace, e.g. skills/x/SKILL.md' },
      from_line: { type: 'number' }, lines: { type: 'number', description: 'Default 400, at most 2000' } }, required: ['path'] },
  },
  {
    name: 'workspace_write',
    description: 'Owner and admins: writes a whole file in the workspace (makes its folders; replaces the file if it exists). Put files to hand back in out/.',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'workspace_edit',
    description: 'Owner and admins: replaces exact text in a workspace file. old_text must appear once (or set all to replace every one).',
    input_schema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, all: { type: 'boolean' } },
      required: ['path', 'old_text', 'new_text'] },
  },
  {
    name: 'workspace_search',
    description: 'Owner and admins: with query, the lines in workspace files that contain it (any case, 50 per file); without query, the files (optionally under a folder and matching name, e.g. "*.py").',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, under: { type: 'string', description: 'A folder, e.g. skills/x' }, name: { type: 'string', description: 'File name pattern, e.g. *.py' } } },
  },
  {
    name: 'note_for_agent',
    description: 'Save something you learned about this agency to YOUR notebook (shared by everyone who uses you, read at the start of every run): a rule, how a number works, who does what, a recurring problem. One short sentence. Never secrets, never one person\'s preference (use remember for that).',
    input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
  },
  {
    name: 'forget_agent_note',
    description: 'Remove one note from your notebook by id when it is wrong or no longer true.',
    input_schema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  // "Always remember" (D, 2026-10-23; lib/ai/memory-layers.ts): the agent's own core profile, in every prompt
  {
    name: 'core_memory_append',
    description: 'Add one line to your "Always remember" core profile: only something that matters in every conversation (who you work for and how, a rule you must never get wrong). Most facts go in the notebook (note_for_agent) instead.',
    input_schema: { type: 'object', properties: { text: { type: 'string', description: 'One short line' } }, required: ['text'] },
  },
  {
    name: 'core_memory_replace',
    description: 'Change a line of your "Always remember" core profile: old = the exact text now in it, new = what replaces it ("" removes it).',
    input_schema: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] },
  },
  // change tools (D, 2026-10-09): they only file a proposal; the user approves it on a card in the chat (lib/ai/approvals.ts)
  {
    name: 'app_search',
    description: 'Search the tools of the apps this agent is connected to (Slack, Gmail, Google Sheets...). Returns tool slugs with a recommended plan. Use before app_run.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What you want to do, e.g. "send a message to a channel"' } }, required: ['query'] },
  },
  {
    name: 'app_run',
    description: 'Run one app tool by slug (from app_search) with its arguments. Reading (find, list, get, search) runs at once; anything that sends or changes something files an Approve card for the user first.',
    input_schema: { type: 'object', properties: { tool: { type: 'string', description: 'Tool slug, e.g. SLACK_FIND_CHANNELS' }, data: { type: 'object', description: 'The tool arguments' }, why: { type: 'string' } }, required: ['tool'] },
  },
  {
    name: 'propose_skill',
    description: 'Save a reusable skill (a /command with instructions) for this user. It acts at once (no approval card): when the person asks for one, just save it, then tell them the /command is saved. '
      + 'Ask only when what it should do is genuinely unclear.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'command, lower-case-with-dashes' }, title: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' },
      folder: { type: 'string', description: 'Sidebar folder on the Skills page, e.g. Reports or Reports/Weekly (put it with skills like it)' }, files: { type: 'array', description: 'Other files of the skill besides its body (SKILL.md), like a Claude skill folder: references, examples, templates', items: { type: 'object', properties: { path: { type: 'string', description: 'e.g. references/pricing.md' }, body: { type: 'string' } }, required: ['path', 'body'] } }, share: { type: 'string', enum: ['me', 'team'], description: 'team = every owner, admin and agent can use it (default for skills an agent writes for the team); me = only this person' },
      replace: { type: 'boolean', description: 'true = update the skill of that name you made before' } }, required: ['name', 'body'] },
  },
  // capacity and routines (D, 2026-10-23: "fill the gaps" so the AI can run the 72-hour snapshot itself)
  {
    name: 'inbox',
    description: 'The Inbox of the person you are talking with (owner and admins): what needs them (AI approvals, reps\' deal and rate requests, setter suggestions, lessons, notes that disagree, money, process and data alerts) and routine runs. '
      + 'No key: the list. key: one item in full. Read only.',
    input_schema: { type: 'object', properties: { key: { type: 'string', description: 'One item, e.g. claim:12' }, all: { type: 'boolean', description: 'Include the updates, not only what needs them' } } },
  },
  {
    name: 'list_routines',
    description: 'The scheduled routines this person can see: id, name, agent, schedule (in the agency\'s zone), where it delivers, on or off, last run and next run. Read only.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'save_routine',
    description: 'Create a scheduled routine, or change one (with id). It acts at once (no approval card): when the person asks for a daily post or a recurring job, just make it, then say what it does and when. '
      + 'The prompt is what the agent does on each run (a /skill name expands, e.g. "/72h-snapshot"); a routine runs with nobody watching, read only except its Slack delivery. '
      + 'Schedule is a 5-field cron in the agency\'s time zone, e.g. "0 7 * * *" = every day at 7:00, "0 7 * * 1-5" = weekdays. Slack: a channel id (C...) or name; the final answer is posted there. '
      + 'On new posts (e.g. "when a post comes in from #channel, sort it"): leave schedule empty ("") and put that channel\'s id (C...) in condition, e.g. "there is a new post in C09NCFGT32M"; '
      + 'it then runs only when a new top-level post lands there, within about 20 seconds, never on a timer. Have the prompt read only the last few minutes of the channel. '
      + 'Slack is already wired for this: the the AI Slack app sends every post in channels it is a member of, so never send the person to Slack app settings or ask for a developer; '
      + 'if the AI is not in that channel yet, ask them to add it there (/invite @the AI).',
    input_schema: { type: 'object', properties: {
      id: { type: 'number', description: 'An existing routine to change (from list_routines); leave out for a new one' },
      name: { type: 'string' }, prompt: { type: 'string', description: 'What to do each run, complete on its own' }, schedule: { type: 'string', description: '5-field cron, agency time zone; "" = only on new posts in the channel named in condition' },
      agent: { type: 'string', description: 'Agent name that runs it (default: the main agent)' }, slack: { type: 'string', description: 'Channel id or name to post the result to ("" = no Slack)' },
      enabled: { type: 'boolean', description: 'On (default true for a new one)' }, condition: { type: 'string', description: 'Optional: only deliver when this is true, e.g. "there is a new leaderboard"' },
      script: { type: 'string', description: 'Owner/admin: a command to run in the workspace instead of an agent turn, e.g. "python3 skills/x/scripts/report.py" (cwd /work, no AI, cheap; its output is the run log). "" makes it an agent routine again' },
      condition_script: { type: 'string', description: 'Owner/admin: a command run first in the workspace; exit 0 = run, anything else = skip (e.g. "python3 skills/x/scripts/watch_condition.py")' },
    }, required: [] },
  },
  {
    name: 'run_routine',
    description: 'Run a routine once now (by id) and wait for it (a few minutes at most). It delivers where it is set to (Slack too), so say so when testing.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, test_to: { type: 'string', description: 'A test run: every Slack post and the delivery go to this Slack id (the person\'s own U... id from slack_people) marked with where they would have gone, and no change is made (API writes and change tools are reported, not done). For trying a routine safely.' } }, required: ['id'] },
  },
  // skills agents pick up themselves (D, 2026-10-23): the list is in every prompt, these read one in full
  {
    name: 'list_skills',
    description: 'The /skills this person and the team have (name, what it is for, who made it). Read one with read_skill before doing a task it covers.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Words to filter by, optional' } } },
  },
  // saved keys (D 2026-10-28; lib/ai/secrets.ts)
  {
    name: 'list_secrets',
    description: 'The names of the API keys saved for the agents (never their values). Use a name in http_request as {{secret:NAME}}.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Part of a name, e.g. CALENDLY' } } },
  },
  {
    name: 'save_key',
    description: 'Save an API key or token an owner or admin sent you and asked you to keep (only they can, in a conversation they started). It is stored on this server, then usable in http_request as {{secret:NAME}}. Reply with the name and last 4 characters only, never the value, and test it with one read-only call when you can.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'CAPITALS_WITH_UNDERSCORES, e.g. CALENDLY_TOKEN' }, value: { type: 'string' } }, required: ['name', 'value'] },
  },
  {
    name: 'http_request',
    description: 'Call a web API. Put a saved key in a header, the body or the URL path/query as {{secret:NAME}} (list_secrets); never in the host. The first time a key goes to a site it waits for the person\'s approve card (say so in one line); after that it runs at once. Answers the status and body (keys hidden). No private network addresses.',
    input_schema: { type: 'object', properties: { method: { type: 'string', description: 'GET (default), POST, PUT, PATCH, DELETE' }, url: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: { type: 'string', description: 'Raw body; JSON as a string' } }, required: ['url'] },
  },
  {
    name: 'send_file',
    description: 'Put a file into this conversation (shown under your answer): a picture (PNG, JPG, GIF, WebP), PDF, Excel/Word/PowerPoint or text file (CSV, MD, TXT, JSON), up to 10 MB. Give `content` + `name` for a file you wrote (a CSV of numbers, a draft), a public `url`, or a `path` on this server in the agents\' folders (the workspace /work, browser screenshots). Use it when the person asks for a file, a list to download, or a picture.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'File name with extension, e.g. no-shows-october.csv' }, content: { type: 'string' }, url: { type: 'string' }, path: { type: 'string' }, type: { type: 'string', description: 'Optional media type' } } },
  },
  {
    name: 'read_skill',
    description: 'Read a /skill\'s full instructions (its SKILL.md) by name, then follow them. A skill can also have other files (references, examples); they are listed at the end; read one with file. A long one comes in pages: when the answer ends with next_offset, call again with that offset until it is all read.',
    input_schema: { type: 'object', properties: { name: { type: 'string', description: 'The skill name without the slash' }, file: { type: 'string', description: 'One of the skill\'s files, e.g. references/pricing.md (default: SKILL.md)' }, offset: { type: 'number', description: 'Where to continue a long skill or file (next_offset from the last page)' } }, required: ['name'] },
  },
  // agents talk to each other (D, 2026-10-23; lib/ai/comms.ts)
  {
    name: 'agents_list',
    description: 'The other agents on the team: name, role, work handed to them, unread messages. Use it to pick who to ask or hand work to.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ask_agent',
    description: 'Ask another agent a question and wait for its answer (up to 3 minutes). It answers read only, with its own tools and notebook. Use it when another agent knows the area better. '
      + 'Say in your reply which agent the answer came from.',
    input_schema: { type: 'object', properties: { agent: { type: 'string', description: 'Agent name (from agents_list)' }, question: { type: 'string', description: 'The full question with the context it needs; it does not see this conversation' } }, required: ['agent', 'question'] },
  },
  {
    name: 'message_agent',
    description: 'Leave a message for another agent (async). It reads it at the start of its next run; the clock wakes it within a minute or so. Use reply_to to answer a message you got.',
    input_schema: { type: 'object', properties: { agent: { type: 'string' }, text: { type: 'string' }, reply_to: { type: 'number', description: 'The message number you answer, optional' } }, required: ['agent', 'text'] },
  },
  {
    name: 'hand_off',
    description: 'Give another agent a piece of work (async). It runs with its own tools within a minute and its result is posted back into this conversation, credited to it. Tell the person who has it.',
    input_schema: { type: 'object', properties: { agent: { type: 'string' }, brief: { type: 'string', description: 'What to do, the context, and what done looks like; it does not see this conversation' } }, required: ['agent', 'brief'] },
  },
  {
    name: 'create_task',
    description: 'Put a task on the AI task board (AI › Tasks), assigned to an agent (yourself or another; leave agent out and the main agent takes it). The agent starts it within a minute in its own conversation; the result shows on the card. Use it for work that should be tracked on the board.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string', description: 'What to do, the context, and what done looks like' }, agent: { type: 'string', description: 'Agent name (from agents_list)' },
      priority: { type: 'string', enum: ['critical', 'urgent', 'high', 'normal', 'low'] } }, required: ['title'] },
  },
  {
    name: 'list_tasks',
    description: 'The AI task board: each task, its agent, status (pending, in_progress, blocked, completed), priority and result. Read only.',
    input_schema: { type: 'object', properties: { status: { type: 'string', description: 'Only this status, optional' } } },
  },
  {
    name: 'update_task',
    description: 'Change a task on the board: status (pending = run it again, blocked, completed), the agent, priority, or add a note.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, status: { type: 'string', enum: ['pending', 'blocked', 'completed'] }, agent: { type: 'string' }, priority: { type: 'string' }, note: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_goals',
    description: 'Goals per agent: what each one works toward, with metric, target, due date, status and latest progress. Leave agent out for every agent. Read only. (The agency north star is read_goals.)',
    input_schema: { type: 'object', properties: { agent: { type: 'string', description: 'Agent name, optional' }, all: { type: 'boolean', description: 'Include done and dropped goals' } } },
  },
  {
    name: 'set_goal',
    description: 'Add a goal (no id: goal, plus metric, target and due when you can) or update one (id: progress, status active/done/dropped, or any field). For yourself by default; agent = a teammate whose goals you lead. Keep goals measurable.',
    input_schema: { type: 'object', properties: { id: { type: 'number' }, agent: { type: 'string' }, goal: { type: 'string' }, metric: { type: 'string', description: 'How it is measured, e.g. BETA show rate' },
      target: { type: 'string', description: 'e.g. 70%' }, due: { type: 'string', description: 'YYYY-MM-DD' }, status: { type: 'string', enum: ['active', 'done', 'dropped'] }, progress: { type: 'string', description: 'Where it stands now, with the number and date' } } },
  },
  {
    name: 'propose_experiment',
    description: 'Propose logging an experiment in this agency\'s experiments log, or (with id) updating one: its status, result and keep or discard decision. '
      + 'Nothing is saved until the user clicks Approve.',
    input_schema: { type: 'object', properties: {
      id: { type: 'number', description: 'An existing experiment to update (from read_experiments); leave out for a new one' },
      title: { type: 'string' }, hypothesis: { type: 'string' }, metric: { type: 'string', description: 'The number that decides it' },
      business: { type: 'string', description: 'Contract or area, optional' }, owner: { type: 'string', description: 'Who runs it' },
      started_on: { type: 'string', description: 'YYYY-MM-DD' }, ended_on: { type: 'string', description: 'YYYY-MM-DD' },
      status: { type: 'string', description: 'planned, running or done' }, result: { type: 'string' }, decision: { type: 'string', description: 'keep or discard' },
    } },
  },
  {
    name: 'propose_strategy',
    description: 'Propose a change to this agency\'s Strategy page (Operations › Strategy): today\'s focus, the current bottleneck, the north star, '
      + 'a goal\'s progress (id from read_goals), or a new goal. Give only what changes and say why. Nothing is saved until the user clicks Approve.',
    input_schema: { type: 'object', properties: {
      daily_focus: { type: 'string', description: 'The one thing the team works on today' },
      bottleneck: { type: 'string', description: 'What most slows the team down now' },
      north_star: { type: 'string', description: 'Where the agency is going, in one line' },
      goals: { type: 'array', description: 'Goals to update', items: { type: 'object', properties: { id: { type: 'number' }, progress: { type: 'number', description: '0 to 100' }, title: { type: 'string' } }, required: ['id'] } },
      new_goal: { type: 'string', description: 'A goal to add at the end' },
      why: { type: 'string', description: 'One line: what you saw that calls for this' },
    }, required: ['why'] },
  },
  {
    name: 'propose_slack_post',
    description: 'Post a Slack message from this agency\'s Slack bot, shown as sent by the person asking ("<name> (via the AI)"): to a channel (C... id or #name, the bot must be in it), '
      + 'a reply in a thread, or a direct message to one person (their U... id from slack_people). '
      + 'It acts at once (no approval card): when the person asks you to message someone or post, just do it, like a teammate would, then say in one line what you sent '
      + 'and to whom. Ask only when who it goes to or what it should say is genuinely unclear. '
      + 'Charts and tables: put ctrl-chart or ctrl-table blocks (the same JSON as in chat) in the text and they are posted as images under it.',
    input_schema: { type: 'object', properties: {
      channel: { type: 'string', description: 'Channel id (C0123ABC), #name, or a person\'s Slack id (U0123ABC) for a direct message' }, text: { type: 'string', description: 'The message, Slack mrkdwn' },
      thread_ts: { type: 'string', description: 'Reply in this thread (the parent message ts), optional' }, why: { type: 'string' },
      markdown: { type: 'boolean', description: 'The text is standard Markdown (### headings, **bold**, [text](url)), drawn as Slack\'s markdown block' },
    }, required: ['channel', 'text'] },
  },
] as const;

/** Runs one tool as this run's user; returns the text Claude reads. Throws a plain reason the AI can repeat. */
/** The tool list for a run, its examples filled from the run's agency (HARDCODE_AUDIT B12, D 2026-10-10): one of its own contract keys
 *  and its zone, never another agency's contracts or a real person's key. */
export function toolsFor(run: RunKey): typeof TOOLS {
  const build = () => {
    const tz = tzAbbr(reportTz());
    const tier = tierOf(run.userId);
    const tools = TOOLS.filter((t) => toolAllowedFor(tier, t.name));
    return JSON.parse(JSON.stringify(tools).replaceAll('@TZ', tz)) as typeof TOOLS;
  };
  if (!isMultiTenant()) return build();
  if (!run.agency) throw new Error('This run has no agency.');
  return runWithTenant(run.agency, build);
}

/** The agency's named secret values for the output guard: its keys (Settings, connectors), its AI connections and the app's own env. In memory only, per call. */
function agencySecretsForGuard(): Record<string, string | null | undefined> {
  const out: Record<string, string | null | undefined> = { ...envSecrets() };
  for (const k of CONN_KINDS) { try { out[`AI_CONN_${k.toUpperCase().replace(/-/g, '_')}_SECRET`] = connSecret(k); } catch { /* none */ } }
  try { Object.assign(out, savedKeyValues()); } catch { /* no vault yet */ }
  return { ...out, ...agencySecretValues() };
}

// Every tool result and error goes through the output guard (D, 2026-10-10: agents use keys without seeing them; lib/ai/tool-guard.ts).
export async function callTool(run: RunKey, name: string, args: Record<string, unknown>): Promise<string> {
  // clients never get links (D, 2026-10-13): every URL in a tool's answer is cut before the model sees it
  const go = async () => {
    const out = await guardToolOutput(() => callToolNow(run, name, args), agencySecretsForGuard);
    return tierOf(run.userId) === 'client' ? out.replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[link removed]') : out;
  };
  if (!isMultiTenant()) return go();
  if (!run.agency) throw new Error('This run has no agency.');
  return runWithTenant(run.agency, go);
}

async function callToolNow(run: RunKey, name: string, args: Record<string, unknown>): Promise<string> {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : undefined);
  if (!run.tools.includes(name)) throw new Error(`This agent does not have the ${name} tool.`);
  if (!toolAllowedFor(tierOf(run.userId), name)) throw new Error(`The ${name} tool is for the owner and admins.`);
  const tested = testGate(run, name, args);
  if (tested !== null) return tested;
  if (OUTSIDE_TEXT.has(name) && !run.fixedScript) { run.untrusted = true; if (run.parentRun) run.parentRun.untrusted = true; }
  if (name === 'app_search' || name === 'app_run') {
    const apps = run.apps ?? [];
    if (!apps.length) throw new Error('This agent has no connected apps. Add some in the agent editor.');
    if (name === 'app_search') return searchAppTools(str('query') ?? '', apps);
    const slug = (str('tool') ?? '').toUpperCase();
    if (!/^[A-Z0-9_]{3,80}$/.test(slug) || !appOfTool(slug, apps)) throw new Error(`${slug || 'That tool'} is not one of this agent's apps (${apps.join(', ')}).`);
    const data = (args.data && typeof args.data === 'object' ? args.data : {}) as Record<string, unknown>;
    if (isReadTool(slug)) return runAppTool(slug, data);
    const id = propose(run.userId, run.threadId, 'app_run', { tool: slug, data }, `Run ${slug} ${JSON.stringify(data).slice(0, 160)}${str('why') ? ` (${str('why')})` : ''}`);
    return `Asked the user to approve change #${id}: run ${slug}. Nothing is sent until they say yes. Ask them in one plain line whether to go ahead (no card, no change number); their yes runs it, no drops it.`;
  }
  // the Inbox, deal rates and deal/rate requests (D, 2026-10-28: "they need access to this but only by person"): always the person the run
  // is for (run.userId; a Slack ask is the login that Slack account is linked to), with that login's own rights
  if (name === 'inbox') {
    const role = getGrant(run.userId).role;
    if (role !== 'owner' && role !== 'admin') throw new Error('The Inbox is for owners and admins.');
    const { inboxFor } = await import('./inbox');
    const items = await inboxFor(run.userId);
    if (str('key')) { const it = items.find((x) => x.key === str('key')); return it ? JSON.stringify(it).slice(0, 12_000) : 'No such item (it may be done already).'; }
    const list = items.filter((x) => args.all === true || x.needsYou);
    return list.length ? JSON.stringify(list.slice(0, 60).map((x) => ({ key: x.key, kind: x.kind, needsYou: x.needsYou, title: x.title, sub: x.sub, at: x.at }))) : 'Nothing needs them.';
  }
  if (name === 'list_routines') {
    const { listRoutines } = await import('./routines'), { describeCron } = await import('./cron');
    const list = listRoutines(run.userId);
    return list.length ? JSON.stringify(list.map((r) => ({ id: r.id, name: r.name, agent: getAgent(r.agent_id)?.name ?? 'main agent', schedule: r.schedule, when: describeCron(r.schedule), on: r.enabled,
      slack: r.deliver.slack ?? null, team: r.shared, last: r.last_run_at ? { at: new Date(r.last_run_at).toISOString(), status: r.last_status } : null, next: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
      prompt: r.prompt.slice(0, 600), ...(r.script ? { script: r.script } : {}), ...(r.condition_script ? { condition_script: r.condition_script } : {}) }))) : 'No routines yet.';
  }
  if (name === 'save_routine') {
    const a: Record<string, unknown> = { ...args };
    delete a.agent; delete a.slack;
    if (str('agent')) {
      const c = await import('./comms'), ag = c.findAgent(str('agent')!, run.userId);
      if (!ag) throw new Error(`No agent called ${str('agent')}.`);
      a.agent_id = ag.id;
    }
    if (typeof args.slack === 'string') {
      const cur = Number(args.id) ? (await import('./routines')).getRoutine(Number(args.id)) : undefined;
      a.deliver = { ...(cur?.deliver ?? {}), slack: str('slack') || null };
    }
    const summary = `${args.id ? `Change routine #${args.id}` : `Make the routine "${str('name') ?? ''}"`}${str('schedule') ? ` (${str('schedule')})` : ''}`;
    return actOrAsk(!!run.untrusted, run.userId, run.threadId, name, a, summary); // done when asked, no card (D, 2026-10-23), kept in the change list
  }
  if (name === 'run_routine') {
    const { getRoutine, canSeeRoutine } = await import('./routines');
    const r = getRoutine(Number(args.id));
    if (!r || !canSeeRoutine(r, run.userId)) throw new Error(`No routine #${args.id}.`);
    const { runRoutine } = await import('./routine-run');
    const testTo = str('test_to');
    if (testTo && !TEST_SLACK.test(testTo)) throw new Error('test_to is a Slack id: a person (U...), a DM (D...) or a channel (C...).');
    const out = await runRoutine(r.id, 'manual', testTo ? { slackTo: testTo } : undefined);
    if ('refused' in out) throw new Error(out.refused);
    return `Ran "${r.name}": ${out.status}${out.delivered.length ? `, sent to ${out.delivered.join(', ')}` : ''}. ${out.summary.slice(0, 1500)}`;
  }
  // saved keys belong to owners and admins: every key tool runs only as one of them (also in routines, which skip the tier filter)
  if ((name === 'list_secrets' || name === 'http_request' || name === 'save_key') && !['owner', 'admin'].includes(getGrant(run.userId).role)) return 'Saved keys are for owners and admins only.';
  if (name === 'list_secrets') return (await import('./secrets')).listSecrets(str('query'));
  if (name === 'save_key') {
    // an owner or admin, in their own conversation that read no outside text (never a routine, a Slack post or another agent's ask)
    const role = getGrant(run.userId).role;
    if ((role !== 'owner' && role !== 'admin') || !run.comms?.ownerStarted || run.untrusted || run.comms.depth > 0) return 'Only an owner or admin can have me save a key, in a conversation they started. Ask them.';
    const n = (str('name') ?? '').toUpperCase();
    return `Saved ${n} (ends ${(await import('./secrets')).saveKey(n, str('value') ?? '')}). Use it as {{secret:${n}}}.`;
  }
  if (name === 'http_request') {
    const sec = await import('./secrets');
    const req = { method: str('method'), url: str('url') ?? '', headers: (args.headers && typeof args.headers === 'object' ? Object.fromEntries(Object.entries(args.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {}), body: typeof args.body === 'string' ? args.body : args.body !== undefined ? JSON.stringify(args.body) : undefined };
    const names = sec.secretsIn(req), need = sec.unapproved(req);
    if (names.length && (need.length || run.untrusted)) {
      const host = sec.checkRequest(req);
      const id = propose(run.userId, run.threadId, 'http_request', req, `Send ${names.join(', ')} to ${host} (${(req.method || 'GET').toUpperCase()} ${req.url.replace(/\{\{secret:[A-Z0-9_]+\}\}/g, '***').slice(0, 120)})`);
      return `Waiting for approval (change #${id}): ${need.length ? `first time ${need.join(', ')} goes to ${host}` : 'this conversation read outside text'}. It shows as a card under your reply; once approved the request runs and its answer is posted here. Tell them in one line.`;
    }
    return sec.sendRequest(req);
  }
  if (name === 'create_task' || name === 'list_tasks' || name === 'update_task') {
    const T = await import('./tasks'), c = await import('./comms');
    const agentRef = str('agent');
    const agent = agentRef ? c.findAgent(agentRef, run.userId) : undefined;
    if (agentRef && !agent) throw new Error(`No agent called ${agentRef}. See agents_list.`);
    if (name === 'list_tasks') {
      const want = str('status');
      return JSON.stringify(T.boardTasks().filter((t) => !want || t.status === want).slice(0, 80).map((t) => ({ id: t.id, title: t.title, agent: t.agent, status: t.status, priority: t.priority, result: t.result.slice(0, 600), updated: t.updated_at })));
    }
    if (name === 'create_task') {
      const r = T.createTask({ title: str('title') ?? '', description: str('description'), agentId: agent?.id ?? null, priority: str('priority'), createdBy: run.userId, createdByAgent: threadAgentId(run.threadId) });
      if (typeof r === 'string') throw new Error(r);
      return `Task #${r.id} "${r.title}" is on the board${agent ? `, assigned to ${agent.name}` : ', for the main agent'}; it starts within a minute.`;
    }
    const r = T.updateTask(Number(args.id), { status: str('status'), agentId: agent?.id, priority: str('priority'), note: str('note') });
    if (typeof r === 'string') throw new Error(r);
    return `Task #${r.id} is now ${r.status}${r.agent_id ? ` (agent ${getAgent(r.agent_id)?.name})` : ''}.`;
  }
  if (name === 'list_goals' || name === 'set_goal') {
    const G = await import('./goals'), c = await import('./comms');
    const ref = str('agent'), me = threadAgentId(run.threadId);
    const who = ref ? c.findAgent(ref, run.userId) : undefined;
    if (ref && !who) throw new Error(`No agent called ${ref}. See agents_list.`);
    const names = new Map((await import('./store')).listAgents().map((x) => [x.id, x.name]));
    if (name === 'list_goals') return JSON.stringify(G.listGoals(who?.id, args.all === true).map((g) => ({ ...g, agent: names.get(g.agent_id) })));
    const r = G.setGoal({ id: Number(args.id) || undefined, agentId: who?.id ?? me ?? undefined, goal: str('goal'), metric: str('metric'), target: str('target'), due: str('due'), status: str('status'), progress: str('progress'), by: names.get(me ?? 0) ?? 'an agent' });
    if (typeof r === 'string') throw new Error(r);
    return `Goal #${r.id} for ${names.get(r.agent_id)}: ${r.goal} (${r.status}${r.progress ? `, now: ${r.progress}` : ''}).`;
  }
  if (name === 'send_file') return (await import('./send-file')).sendFile(run, { name: str('name'), content: typeof args.content === 'string' ? args.content : undefined, url: str('url'), path: str('path'), type: str('type') });
  if (name === 'list_skills' || name === 'read_skill') {
    const all = listSkills(run.userId);
    if (name === 'read_skill') {
      const sk = all.find((k) => k.name === (str('name') ?? '').replace(/^\//, '').toLowerCase());
      if (!sk) throw new Error(`No skill /${str('name')}. See list_skills.`);
      const want = (str('file') ?? '').replace(/^\/+/, '');
      const off = Math.max(0, Math.floor(Number(args.offset) || 0));
      if (want && !/^skill\.md$/i.test(want)) {
        const f = sk.files?.find((x) => x.path === want);
        if (!f) throw new Error(`/${sk.name} has no file ${want}. Its files: ${(sk.files ?? []).map((x) => x.path).join(', ') || 'none'}.`);
        return `${off ? '' : `/${sk.name} · ${f.path}\n`}${skillPage(f.body, off)}`;
      }
      const list = (sk.files ?? []).map((x) => x.path), body = skillPage(sk.body, off);
      return `${off ? '' : `/${sk.name}${sk.title ? ` (${sk.title})` : ''}\n`}${body}${list.length && !/next_offset \d+\]$/.test(body) ? `\n\nFiles in this skill (read one with read_skill name=${sk.name} file=<path>): ${list.join(', ')}` : ''}`;
    }
    const q = (str('query') ?? '').toLowerCase();
    const hits = all.filter((k) => !q || `${k.name} ${k.title} ${k.description}`.toLowerCase().includes(q));
    return hits.map((k) => `/${k.name}: ${k.description || k.title || ''}${k.share === 'team' ? ' (team)' : ''}${k.agent_id ? ` (written by ${getAgent(k.agent_id)?.name ?? 'an agent'})` : ''}`).join('\n') || 'No skills match.';
  }
  if (name === 'agents_list' || name === 'ask_agent' || name === 'message_agent' || name === 'hand_off') {
    const c = await import('./comms'); // comms.ts imports this file
    const me = threadAgentId(run.threadId), ctx = run.comms ?? { depth: 0, chain: me ? [me] : [], ownerStarted: true };
    if (name === 'agents_list') return JSON.stringify(c.roster(me));
    const to = c.findAgent(str('agent') ?? '', run.userId);
    if (!to) throw new Error(`No agent called ${str('agent')}. See agents_list.`);
    if (name === 'ask_agent') return c.askAgent({ fromAgent: me, to, userId: run.userId, question: str('question') ?? '', originThread: run.threadId, ctx });
    if (name === 'message_agent') {
      const id = c.messageAgent({ fromAgent: me, to, userId: run.userId, text: str('text') ?? '', replyTo: typeof args.reply_to === 'number' ? args.reply_to : null, originThread: run.threadId, ctx });
      return `Message #${id} left for ${to.name}. It reads it on its next run (the clock wakes it within a minute or so).`;
    }
    const id = c.handOff({ fromAgent: me, to, userId: run.userId, brief: str('brief') ?? '', originThread: run.threadId, ctx });
    return `Handed to ${to.name} (#${id}). It starts within a minute and its result is posted into this conversation. Tell the person in one line.`;
  }
  if (name === 'propose_skill') {
    const summary = `Save the skill /${str('name')}${str('title') ? ` (${str('title')})` : ''}`;
    return actOrAsk(!!run.untrusted, run.userId, run.threadId, name, { ...args, agent_id: threadAgentId(run.threadId) }, summary); // done when asked, no card
  }
  if (name === 'propose_slack_post') {
    // the agency's own Slack bot (D, 2026-10-10, docs/SLACK_APP.md): only a card; lib/ai/approvals.ts posts after Approve
    const channel = (str('channel') ?? '').replace(/^#/, ''), text = str('text') ?? '', thread = str('thread_ts');
    if (!botToken()) throw new Error('Slack is not connected for this agency (Settings › Agency › Agency tools › Slack).');
    if (!/^[A-Za-z0-9._-]{2,80}$/.test(channel)) throw new Error('Pass a channel id (C0123ABC) or #name.');
    if (!text) throw new Error('Pass the text to post.');
    if (thread && !/^\d{6,12}\.\d{1,8}$/.test(thread)) throw new Error('thread_ts looks like 1712345678.123456.');
    const summary = `Post to Slack #${channel}${thread ? ' (thread reply)' : ''}: ${text.slice(0, 200)}${str('why') ? ` (${str('why')})` : ''}`;
    // done when asked, no card (D, 2026-10-22); shown as the person who asked
    const as = `${(db.prepare('SELECT username FROM users WHERE id = ?').get(run.userId) as { username?: string } | undefined)?.username ?? 'the agency'} (via ${getBrand().short} AI)`;
    // a test run's post goes to the tester only (testGate moved it): no card needed
    return actOrAsk(!!run.untrusted && !run.test, run.userId, run.threadId, name, { channel, text: text.slice(0, 39_000), as, ...(thread ? { thread_ts: thread } : {}), ...(args.markdown === true ? { markdown: true } : {}) }, summary);
  }
  if (name === 'search_knowledge') {
    const id = Number(args.id);
    if (id) {
      const d = getDoc(id);
      if (!d) return 'No document with that id.';
      const body = d.body.length > 60_000 ? `${d.body.slice(0, 60_000)}\n[cut at 60,000 characters]` : d.body;
      return `# ${d.title}\n(${d.space}${d.folder ? `, folder ${d.folder}` : ''}, updated ${d.updated_at})\n\n${body}`;
    }
    const q = str('query') ?? '';
    if (!q) throw new Error('Pass query (or id).');
    const space = isSpace(str('space')) ? (str('space') as 'knowledge' | 'wiki') : undefined;
    const hits = searchDocs(q, { space, limit: 10 });
    if (!hits.length) return `Nothing in Knowledge matches "${q}".`;
    return [
      ...hits.map((h) => `[${h.id}] ${h.title} (${h.space}${h.folder ? `, ${h.folder}` : ''}): ${h.snippet.replace(/\[\[|\]\]/g, '')}`),
    ].join('\n');
  }
  if (name === 'read_goals') {
    // the run's agency only (callTool runs inside it): its own Strategy rows (Operations per agency, D 2026-10-10)
    const s = getStrategy(), goals = listGoals();
    const hist = goalHistory(Math.min(Math.max(Number(args.history) || 10, 0), 50));
    return [
      `North star: ${s.north_star || '(not set)'}`, `Bottleneck: ${s.bottleneck || '(not set)'}`,
      `Today's focus: ${s.daily_focus || '(not set)'}${s.daily_focus && s.daily_focus_set_at ? ` (set ${s.daily_focus_set_at})` : ''}`,
      goals.length ? `Goals in priority order:\n${goals.map((g, i) => `${i + 1}. ${g.title}: ${g.progress}%`).join('\n')}` : 'Goals: none yet.',
      hist.length ? `Recent changes:\n${hist.map((h) => `- ${h.timestamp} ${h.change}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
  }
  if (name === 'read_experiments') {
    const line = (e: Experiment) => `[${e.id}] ${e.title} (${e.status}${e.decision ? `, ${e.decision}` : ''}${e.started_on ? `, from ${e.started_on}` : ''}${e.ended_on ? ` to ${e.ended_on}` : ''})${e.metric ? ` metric: ${e.metric}` : ''}`;
    const id = Number(args.id);
    if (id) {
      const e = getExperiment(id);
      if (!e) return 'No experiment with that id.';
      return [line(e), e.hypothesis && `Hypothesis: ${e.hypothesis}`, e.business && `Contract or area: ${e.business}`, e.owner && `Runs it: ${e.owner}`,
        e.result && `Result: ${e.result}`, `Logged by ${e.source === 'ai' ? 'an agent' : 'a person'}, updated ${e.updated_at}`].filter(Boolean).join('\n');
    }
    const st = str('status');
    const list = listExperiments(EXP_STATUSES.includes(st as ExpStatus) ? st as ExpStatus : undefined);
    return list.length ? list.slice(0, 60).map(line).join('\n') : `No experiments${st ? ` with status ${st}` : ''} yet.`;
  }
  if (name === 'propose_experiment') {
    const id = Number(args.id) || undefined;
    const cur = id ? getExperiment(id) : undefined;
    if (id && !cur) throw new Error('No experiment with that id.');
    const e = cleanExperiment(args, cur);
    if (typeof e === 'string') throw new Error(e);
    const summary = id ? `Update the experiment "${e.title}": ${e.status}${e.decision ? `, ${e.decision}` : ''}${e.result ? `, result: ${e.result.slice(0, 120)}` : ''}`
      : `Log the experiment "${e.title}"${e.metric ? ` (metric: ${e.metric})` : ''}`;
    const pid = propose(run.userId, run.threadId, name, { ...e, ...(id ? { id } : {}) }, summary);
    return `Asked the user to approve change #${pid}: ${summary}. Nothing is saved until they say yes. Ask them in one plain line whether to go ahead (no card, no change number); their yes runs it, no drops it.`;
  }
  if (name === 'propose_strategy') {
    const p = strategyChange(args);
    if (typeof p === 'string') throw new Error(p);
    const pid = propose(run.userId, run.threadId, name, p.args, p.summary);
    return `Asked the user to approve change #${pid}: ${p.summary}. Nothing is saved until they say yes. Ask them in one plain line whether to go ahead (no card, no change number); their yes runs it, no drops it.`;
  }
  if (name === 'remember') {
    const id = addMemory(run.userId, str('fact') ?? '', run.threadId);
    return `Saved as memory note ${id}.`;
  }
  if (name === 'recall_memory') {
    const q = (str('query') ?? '').toLowerCase();
    const notes = listMemory(run.userId).filter((n) => !q || n.content.toLowerCase().includes(q));
    return notes.length ? notes.map((n) => `${n.id}: ${n.content}`).join('\n') : 'No memory notes.';
  }
  if (name === 'forget_memory') {
    return deleteMemory(run.userId, Number(args.id)) ? 'Deleted.' : 'No note with that id.';
  }
  if (name.startsWith('workspace_')) {
    const role = getGrant(run.userId).role;
    if (role !== 'owner' && role !== 'admin') throw new Error('The workspace is for the owner and admins.');
    let job: { argv: string[]; stdin?: string }, seconds = 60, detail: string;
    if (name === 'workspace_run') {
      const command = str('command') ?? '';
      if (!command) throw new Error('Pass the command to run.');
      job = { argv: ['/bin/bash', '-c', command] }; seconds = Math.min(900, Math.max(5, Number(args.timeout_sec) || 120)); detail = command;
    } else if (name === 'workspace_read') { job = readArgs(str('path') ?? ''); detail = str('path') ?? '';
    } else if (name === 'workspace_write') {
      if (typeof args.content !== 'string') throw new Error('Pass content (the whole file).');
      job = writeArgs(str('path') ?? '', args.content); detail = `${str('path')} (${args.content.length} chars)`;
    } else if (name === 'workspace_edit') {
      if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string' || !args.old_text) throw new Error('Pass old_text and new_text.');
      job = editArgs(str('path') ?? '', args.old_text, args.new_text, args.all === true); detail = str('path') ?? '';
    } else { job = searchArgs(str('query') ?? '', str('under') ?? '', str('name') ?? ''); detail = `${str('query') ?? ''} ${str('under') ?? ''} ${str('name') ?? ''}`.trim(); }
    const syncErr = await syncTeamSkills(run.agency, run.userId);
    if (syncErr) throw new Error(syncErr);
    const child = name === 'workspace_run' ? mintChildRunKey(run, seconds) : undefined;
    let r;
    try { r = await runInWorkspace(run.agency, job.argv, { seconds, stdin: job.stdin, runKey: child }); } finally { if (child) revokeRunKey(child); }
    logWorkspace(run.userId, run.threadId, name, detail, r.code, r.ms);
    if (name === 'workspace_read') {
      if (r.code !== 0) throw new Error(clip(r.out, 2000) || 'Could not read that file.');
      return readFileLines(r.out, Number(args.from_line) || 1, Number(args.lines) || 400);
    }
    if (name === 'workspace_search' && r.code === 1 && !r.out) return 'Nothing found.';
    return describeRun(r, seconds);
  }
  if (name === 'read_file' || name === 'search_file') {
    const file = str('file');
    if (!file) {
      const list = threadAttachments(run.userId, run.threadId);
      return list.length ? list.map((f) => `${f.id}: ${f.name} (${f.size.toLocaleString('en-US')} bytes)`).join('\n') : 'No text, Excel, Word or PowerPoint files in this conversation.';
    }
    const f = fileText(run.userId, run.threadId, file);
    if (!f) throw new Error(`No file "${file}" in this conversation. Call read_file without file to list them.`);
    return name === 'read_file' ? readFileLines(f.text, Number(args.from_line) || 1, Number(args.lines) || 400)
      : searchFileLines(f.text, str('query') ?? '', Math.min(500, Math.max(1, Number(args.max) || 100)));
  }
  if (name === 'memory_graph') {
    if (!hasTeamMemory(run.userId)) throw new Error('Team memory is for the owner and admins.');
    const G = await import('./team-graph');
    return str('name') ? G.graphLookup(str('name')!, threadAgentId(run.threadId) ?? null) : G.graphList(str('kind') ?? undefined, Math.min(200, Math.max(5, Number(args.limit) || 60)));
  }
  if (name === 'search_memory') {
    const q = (str('query') ?? '').trim();
    if (q.length < 2) throw new Error('Pass what to look for.');
    if (!hasTeamMemory(run.userId)) throw new Error('Team memory is for the owner and admins.');
    const hits = await searchMemory(q, Math.min(25, Math.max(1, Number(args.limit) || 10)), 4000, threadAgentId(run.threadId) ?? null);
    return hits.length ? formatHits(hits, 12_000) : `Nothing in team memory matches "${q}".`;
  }
  if (name === 'ai_json') {
    if (!run.fixedScript && !run.parentRun) throw new Error('Only workspace scripts use ai_json.');
    const { askJson } = await import('./memory-layers');
    const schema = args.output_schema && typeof args.output_schema === 'object' ? JSON.stringify(args.output_schema).slice(0, 20_000) : '';
    const result = await askJson<Record<string, unknown>>(`${str('prompt') ?? ''}\n\nAnswer with ONE JSON object and nothing else.${schema ? ` It must fit this JSON Schema: ${schema}` : ''}`,
      (str('input_text') ?? '').slice(0, 400_000) || '(no input)');
    return JSON.stringify(result ? { result } : { error: 'The model gave no JSON answer (or AI is not connected).' });
  }
  if (name === 'publish_image') {
    if (!run.fixedScript && !run.parentRun) throw new Error('Only workspace scripts publish images.');
    const png = Buffer.from(str('png_base64') ?? '', 'base64'), base = (process.env.APP_URL || '').replace(/\/$/, '');
    if (png.length < 8 || png.length > 8_000_000 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('png_base64 is a PNG of at most 8 MB.');
    if (!base) throw new Error('This app has no public address (APP_URL), so it cannot publish images.');
    return JSON.stringify({ url: `${base}/api/chart-img/${saveChartPng(png)}` });
  }
  if (name === 'publish_page') {
    if (!run.fixedScript && !run.parentRun) throw new Error('Only workspace scripts publish pages.');
    const base = (process.env.APP_URL || '').replace(/\/$/, ''), html = str('html') ?? '';
    if (!base) throw new Error('This app has no public address (APP_URL), so it cannot publish pages.');
    if (!html.trim()) throw new Error('html is empty.');
    // test runs publish beside the live page, never over it
    const page = `${run.test ? 'test-' : ''}${pageName(str('name') ?? '')}`.slice(0, 80);
    if (!pageName(str('name') ?? '')) throw new Error('name is empty.');
    const ids = Array.isArray(args.members) ? (args.members as unknown[]).map(String).filter((id) => /^[UW][A-Z0-9]{6,15}$/.test(id)) : [];
    let emails: string[] = [];
    if (str('access') === 'specific_members' && ids.length) {
      const token = botToken();
      if (!token) throw new Error('Slack is not connected (Settings › Agency › Agency tools › Slack), so members cannot be matched.');
      const want = new Set(ids);
      emails = (await slackPeople(token)).filter((p) => want.has(p.id) && p.email).map((p) => p.email);
    }
    const meta = savePage(page, html, str('access') === 'specific_members' ? 'members' : 'workspace', emails);
    return JSON.stringify({ url: `${base}/p/${meta.name}`, name: meta.name, members_matched: emails.length });
  }
  if (name === 'slack_history') {
    const token = botToken();
    if (!token) throw new Error('Slack is not connected (Settings › Agency › Agency tools › Slack).');
    let channel = (str('channel') ?? '').trim();
    if (!/^[CG][A-Z0-9]{6,15}$/.test(channel)) {
      const want = channel.replace(/^#/, '').toLowerCase();
      channel = (await botChannels(token)).find((c) => c.name.toLowerCase() === want)?.id ?? '';
      if (!channel) throw new Error(`The bot is in no channel called #${want}.`);
    }
    const when = (v: string | undefined, fallback: string) => {
      if (!v) return fallback;
      if (/^\d{9,11}(\.\d{1,6})?$/.test(v)) return v;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return String(Date.parse(zoneMidnight(v, reportTz())) / 1000);
      throw new Error('since and until are a Slack ts or YYYY-MM-DD.');
    };
    const r = await channelHistory(token, channel, when(str('since'), ''), when(str('until'), String(Date.now() / 1000)),
      Math.min(5000, Math.max(1, Number(args.limit) || 1000)), args.threads === true);
    return JSON.stringify(r);
  }
  if (name === 'slack_people') {
    if (args.all === true) { // scripts: every active member as JSON
      if (!run.fixedScript && !run.parentRun) throw new Error('all is for workspace scripts; pass a query.');
      const token = botToken();
      if (!token) throw new Error('Slack is not connected (Settings › Agency › Agency tools › Slack).');
      return JSON.stringify((await slackPeople(token)).map((p) => ({ id: p.id, name: p.name, real_name: p.real, display_name: p.display, title: p.title, email: p.email })));
    }
    const q = (str('query') ?? '').trim().toLowerCase();
    if (q.length < 2) throw new Error('Pass at least 2 letters of a name or an email.');
    const token = botToken();
    if (!token) throw new Error('Slack is not connected (Settings › Agency › Agency tools › Slack).');
    const hits = (await slackPeople(token)).filter((p) => [p.name, p.real, p.display, p.email].some((v) => v.toLowerCase().includes(q))).slice(0, 10);
    return hits.length ? hits.map((p) => `${p.id}: ${p.real || p.name}${p.display && p.display !== p.real ? ` (${p.display})` : ''}${p.title ? `, ${p.title}` : ''}${p.email ? `, ${p.email}` : ''}`).join('\n')
      : `Nobody active in Slack matches "${q}".`;
  }
  if (name === 'slack_read') {
    const channel = (str('channel') ?? '').replace(/^#/, ''), day = str('day') ?? '';
    if (!/^[CG][A-Z0-9]{6,15}$/.test(channel)) throw new Error('Pass the channel id (C... or G...), not its name.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day is YYYY-MM-DD.');
    const token = botToken();
    if (!token) throw new Error('Slack is not connected (Settings › Agency › Agency tools › Slack).');
    const out = await channelDayLines(token, channel, day, args.replies === true), tz = reportTz();
    return out.length ? `${channel} on ${day} (${tz}), ${out.length} lines:\n${out.join('\n')}` : `No messages in ${channel} on ${day}.`;
  }
  if (name === 'core_memory_append' || name === 'core_memory_replace') {
    const agentId = threadAgentId(run.threadId);
    if (!agentId) throw new Error('This conversation has no agent.');
    if (run.comms && !run.comms.ownerStarted) throw new Error('Your core profile changes only in a conversation a person started.');
    const L = await import('./memory-layers');
    return name === 'core_memory_append' ? L.coreAppend(agentId, str('text') ?? '', 'agent', run.userId, run.threadId)
      : L.coreReplace(agentId, str('old') ?? '', typeof args.new === 'string' ? args.new : '', 'agent', run.userId, run.threadId);
  }
  if (name === 'note_for_agent' || name === 'forget_agent_note') {
    const agentId = threadAgentId(run.threadId);
    if (!agentId) throw new Error('This conversation has no agent.');
    if (name === 'forget_agent_note') return deleteAgentNote(Number(args.id), agentId) ? 'Removed from your notebook.' : 'No notebook note with that id.';
    return `Saved to your notebook as note ${addAgentNote(agentId, run.userId, str('fact') ?? '', run.threadId)}.`;
  }
  throw new Error(`Unknown tool ${name}.`);
}

/** Step titles shown in the chat while a tool runs. */
export function stepTitle(name: string, args: Record<string, unknown>): string {
  const a = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  if (name === 'send_file') return `Sending ${a('name') || 'a file'}`;
  if (name === 'create_task') return `Putting "${a('title')}" on the task board`;
  if (name === 'list_tasks') return 'Looking at the task board';
  if (name === 'update_task') return `Updating task #${args.id}`;
  if (name === 'list_goals') return 'Reading goals';
  if (name === 'set_goal') return args.id ? `Updating goal #${args.id}` : `Adding a goal: ${a('goal')}`;
  if (name === 'list_secrets') return 'Listing saved keys';
  if (name === 'save_key') return `Saving key ${String(args.name ?? '')}`;
  if (name === 'http_request') return `Calling ${(() => { try { return new URL(String(args.url ?? '').replace(/\{\{secret:[A-Z0-9_]+\}\}/g, 'x')).hostname; } catch { return 'an API'; } })()}`;
  if (name === 'search_knowledge') return args.id ? 'Reading a knowledge document' : `Searching knowledge: ${a('query')}`;
  if (name === 'remember') return 'Saving to memory';
  if (name === 'recall_memory') return 'Reading memory';
  if (name === 'forget_memory') return 'Forgetting a memory note';
  if (name === 'slack_read') return `Reading Slack ${a('channel')}`;
  if (name === 'slack_people') return `Finding ${a('query')} in Slack`;
  if (name === 'memory_graph') return args.name ? `Looking up ${a('name')} in the memory graph` : 'Listing the memory graph';
  if (name === 'search_memory') return `Searching team memory: ${a('query')}`;
  if (name === 'read_file') return a('file') ? `Reading the attached file${args.from_line ? ` from line ${args.from_line}` : ''}` : 'Listing the attached files';
  if (name === 'search_file') return `Searching the attached file: ${a('query')}`;
  if (name === 'slack_history') return `Reading Slack history: ${a('channel')}`;
  if (name === 'workspace_run') return `Running: ${a('command').slice(0, 120)}`;
  if (name === 'workspace_read') return `Reading ${a('path')}`;
  if (name === 'workspace_write') return `Writing ${a('path')}`;
  if (name === 'workspace_edit') return `Editing ${a('path')}`;
  if (name === 'workspace_search') return a('query') ? `Searching the workspace: ${a('query')}` : `Listing workspace files${a('under') ? ` in ${a('under')}` : ''}`;
  if (name === 'propose_slack_post') return `Posting to Slack ${a('channel')}`;
  if (name === 'propose_skill') return `Saving /${a('name')}`;
  if (name === 'read_skill') return `Reading /${a('name')}`;
  if (name === 'list_routines') return 'Looking at the routines';
  if (name === 'inbox') return a('key') ? `Reading inbox item ${a('key')}` : 'Reading the Inbox';
  if (name === 'save_routine') return args.id ? `Changing routine #${args.id}` : `Making the routine ${a('name')}`;
  if (name === 'run_routine') return `Running routine #${args.id}`;
  if (name === 'list_skills') return 'Looking at the skills';
  if (name === 'agents_list') return 'Looking at the team';
  if (name === 'ask_agent') return `Asking ${a('agent')}`;
  if (name === 'message_agent') return `Messaging ${a('agent')}`;
  if (name === 'hand_off') return `Handing to ${a('agent')}`;
  if (name === 'note_for_agent') return 'Writing in the notebook';
  if (name === 'core_memory_append' || name === 'core_memory_replace') return 'Updating what it always remembers';
  if (name === 'forget_agent_note') return 'Fixing the notebook';
  if (name === 'read_goals') return 'Reading the strategy and goals';
  if (name === 'read_experiments') return args.id ? 'Reading an experiment' : 'Reading the experiments log';
  if (name === 'propose_skill' || name === 'propose_experiment' || name === 'propose_strategy' || name === 'propose_slack_post') return 'Asking you to approve a change';
  if (name === 'app_search') return `Searching app tools: ${a('query')}`;
  if (name === 'app_run') return `Running ${a('tool')}`;
  return name;
}


/** A propose_strategy call checked against the page as it is now: only real changes, goals that exist, progress 0 to 100. The summary is
 *  what the approval card says. Exported for tests. */
export function strategyChange(a: Record<string, unknown>): { args: Record<string, unknown>; summary: string } | string {
  const cur = getStrategy(), goals = listGoals();
  const text = (k: string) => (typeof a[k] === 'string' ? (a[k] as string).trim().slice(0, 500) : undefined);
  const out: Record<string, unknown> = {}, said: string[] = [];
  for (const [k, label] of [['daily_focus', "Today's focus"], ['bottleneck', 'Bottleneck'], ['north_star', 'North star']] as const) {
    const v = text(k);
    if (v !== undefined && v !== cur[k]) { out[k] = v; said.push(v ? `${label}: ${v}` : `clear the ${label.toLowerCase()}`); }
  }
  const moves: { id: number; progress?: number; title?: string }[] = [];
  for (const g of Array.isArray(a.goals) ? a.goals as Record<string, unknown>[] : []) {
    const have = goals.find((x) => x.id === Number(g.id));
    if (!have) return `There is no goal ${g.id}. Read the goals with read_goals first.`;
    const progress = g.progress === undefined ? undefined : Math.max(0, Math.min(100, Math.round(Number(g.progress) || 0)));
    const title = typeof g.title === 'string' && g.title.trim() ? g.title.trim().slice(0, 200) : undefined;
    if ((progress === undefined || progress === have.progress) && (!title || title === have.title)) continue;
    moves.push({ id: have.id, ...(progress !== undefined ? { progress } : {}), ...(title ? { title } : {}) });
    said.push(`${title ?? have.title}${progress !== undefined && progress !== have.progress ? ` ${have.progress}% to ${progress}%` : ''}`);
  }
  if (moves.length) out.goals = moves;
  const add = text('new_goal');
  if (add) { out.new_goal = add.slice(0, 200); said.push(`new goal: ${out.new_goal}`); }
  if (!said.length) return 'Nothing in that would change the Strategy page.';
  return { args: out, summary: `Strategy: ${said.join('; ')}${text('why') ? ` (${text('why')})` : ''}` };
}
