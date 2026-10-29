// Agent rules that both sides share (D, 2026-10-09): the Fleet tools an agent can be given, its allow-list (enforced in the claude
// --allowedTools list and again in the MCP server), and /skill expansion. Client-safe and pure, so the editor and the tests use it too.

/** Every Fleet tool (lib/ai/tools.ts TOOLS has the same names). `memory`: only when the agent has memory on. */
// The AI agents app keeps the general tools only: the the agency dashboard, contract, ledger, rate card, GoHighLevel and Fleet database
// tools are left out of the catalog (their code stays in tools.ts, unreachable).
export const TOOL_INFO: { name: string; label: string; sub: string; memory?: boolean; change?: boolean; apps?: boolean; write?: boolean }[] = [
  { name: 'slack_read', label: 'Read Slack', sub: 'A channel\'s messages for one day, as the agency\'s Slack bot (read only)' },
  { name: 'memory_graph', label: 'Memory graph', sub: 'Looks up a rep or contract in memory: profile, relationships, who they come up with (read only)' },
  { name: 'search_memory', label: 'Team memory', sub: 'Decisions, facts, past chats, Slack, call reviews and Knowledge, shared by the owner and admins (read only)' },
  { name: 'read_file', label: 'Read attached files', sub: 'Pages through long files attached in the conversation (read only)' },
  { name: 'search_file', label: 'Search attached files', sub: 'Finds lines in files attached in the conversation (read only)' },
  { name: 'workspace_run', label: 'Run code', sub: 'Owner and admins: Python and shell in the agency\'s sandboxed workspace (no internet, no app data or keys)' },
  { name: 'workspace_read', label: 'Read workspace files', sub: 'Owner and admins: reads files in the workspace' },
  { name: 'workspace_write', label: 'Write workspace files', sub: 'Owner and admins: writes files in the workspace' },
  { name: 'workspace_edit', label: 'Edit workspace files', sub: 'Owner and admins: changes text in workspace files' },
  { name: 'workspace_search', label: 'Search the workspace', sub: 'Owner and admins: finds files and lines in the workspace' },
  { name: 'slack_history', label: 'Slack history', sub: 'Owner and admins: a channel\'s raw messages over any window, for scripts and long reads (read only)' },
  { name: 'ai_json', label: 'AI answer (scripts)', sub: 'Workspace scripts only: one JSON answer from the model (ai_structured_output)' },
  { name: 'publish_page', label: 'Publish page', sub: 'Workspace scripts only: an HTML page at a sign-in link' },
  { name: 'publish_image', label: 'Publish image', sub: 'Workspace scripts only: a PNG as a private-link image (html_to_image)' },
  { name: 'list_secrets', label: 'See saved keys', sub: 'Names of the keys saved for the agents (never the values)' },
  { name: 'save_key', label: 'Save keys', sub: 'Saves a key an owner or admin sends, for Call APIs' },
  { name: 'http_request', label: 'Call APIs', sub: 'Calls a web API, with a saved key when needed; a key\'s first use on a site asks first' },
  { name: 'send_file', label: 'Send files', sub: 'Puts a picture, PDF, Office or text file into the conversation' },
  { name: 'create_task', label: 'Add tasks', sub: 'Puts work on the AI task board for an agent' },
  { name: 'list_tasks', label: 'See tasks', sub: 'Reads the AI task board' },
  { name: 'update_task', label: 'Change tasks', sub: 'Moves, reassigns or notes a task on the board' },
  { name: 'list_goals', label: 'See goals', sub: "Each agent's goals and progress" },
  { name: 'set_goal', label: 'Set goals', sub: "Adds or updates an agent's goal" },
  { name: 'slack_people', label: 'Find Slack people', sub: 'Slack ids, names and emails of the agency\'s Slack members (read only)' },
  { name: 'search_knowledge', label: 'Knowledge and Wiki', sub: 'Searches and reads this agency\'s Intelligence documents (read only)' },
  { name: 'read_goals', label: 'Strategy and goals', sub: 'North star, bottleneck, today\'s focus and goals with progress (read only)' },
  { name: 'remember', label: 'Save to memory', sub: 'Keeps a lasting fact for later conversations', memory: true },
  { name: 'recall_memory', label: 'Read memory', sub: 'Lists the saved notes', memory: true },
  { name: 'forget_memory', label: 'Forget a note', sub: 'Deletes a note that is wrong', memory: true },
  { name: 'note_for_agent', label: 'Agent notebook', sub: 'Keeps what the agent learned, for everyone who uses it', memory: true },
  { name: 'forget_agent_note', label: 'Fix the agent notebook', sub: 'Removes a notebook note that is wrong', memory: true },
  { name: 'core_memory_append', label: 'Always remember', sub: 'The agent keeps a short core profile it reads in every conversation', memory: true },
  { name: 'core_memory_replace', label: 'Fix what it always remembers', sub: 'Changes a line of that core profile', memory: true },
  { name: 'propose_skill', label: 'Save skills', sub: 'Saves a new /skill when you ask for one', change: true },
  { name: 'list_skills', label: 'See skills', sub: 'The /skills this person and the team have (read only)' },
  { name: 'read_skill', label: 'Read skills', sub: 'Reads a /skill to follow it (read only)' },
  { name: 'agents_list', label: 'See the team', sub: 'The other agents and what they do' },
  { name: 'ask_agent', label: 'Ask agents', sub: 'Asks another agent and waits for its answer (it answers read only)' },
  { name: 'message_agent', label: 'Message agents', sub: 'Leaves another agent a message; the clock wakes it' },
  { name: 'hand_off', label: 'Hand off work', sub: 'Gives another agent a piece of work; its result comes back here' },
  { name: 'list_routines', label: 'See routines', sub: 'The scheduled routines, their schedule, delivery and last run (read only)' },
  { name: 'inbox', label: 'Read the Inbox', sub: 'Owner and admins: what needs the person asking, and the routine runs (read only)' },
  { name: 'save_routine', label: 'Make routines', sub: 'Creates or changes a scheduled routine when you ask', change: true },
  { name: 'run_routine', label: 'Run routines', sub: 'Runs a routine once now (it delivers where it is set to)', change: true },
  { name: 'propose_strategy', label: 'Update Strategy (asks first)', sub: 'Proposes today\'s focus, the bottleneck, the north star or goal progress; you approve on a card', change: true },
  { name: 'propose_slack_post', label: 'Post to Slack', sub: 'Channels or direct messages when you ask, shown as sent by you via the bot', change: true },
  // the agency's nightly data jobs (D, 2026-10-12): they write Fleet's database, so only an agent that lists them gets them, and only the owner runs them
  // The database and each contract's API with its connector key (D, 2026-10-13: "agents can't pull the API keys to query"): through
  // fleet-run's agent mode like the box agents, so keys stay in the child process. Read only; each call checks the login is owner or admin.
  { name: 'app_search', label: 'Search connected apps', sub: 'Finds tools in the apps picked below', apps: true },
  { name: 'app_run', label: 'Use connected apps', sub: 'Reads at once; sends and changes ask first', apps: true },
];
export const TOOL_NAMES = TOOL_INFO.map((t) => t.name);
export const MEMORY_TOOLS = TOOL_INFO.filter((t) => t.memory).map((t) => t.name);
/** Every agent with memory on keeps its own notebook, whatever its tool list says (D, 2026-10-12). */
export const NOTEBOOK_TOOLS = ['note_for_agent', 'forget_agent_note', 'core_memory_append', 'core_memory_replace'];
/** Every agent can look up how a number is counted (the guide left the prompt, D 2026-10-12). */
export const ALWAYS_TOOLS = ['list_skills', 'read_skill', 'agents_list', 'ask_agent', 'message_agent', 'hand_off', 'read_file', 'search_file', 'read_goals', 'propose_strategy', 'inbox', 'send_file', 'memory_graph', 'list_secrets', 'http_request', 'save_key', 'create_task', 'list_tasks', 'update_task', 'list_goals', 'set_goal']; // every agent can use skills and talk to the team (D, 2026-10-23)
/** Tools that act as soon as they are called, when the person asks (D, 2026-10-22: no confirmation, like a teammate): never in unattended runs. */
export const ASK_IN_CHAT = ['propose_slack_post', 'propose_skill', 'save_routine', 'run_routine'];

/** The tools a run of this agent may call: its allow-list (empty or missing = every tool), known names only, memory tools only with
 *  memory on. */
export const APP_TOOLS = TOOL_INFO.filter((t) => t.apps).map((t) => t.name);
export const WRITE_TOOLS = TOOL_INFO.filter((t) => t.write).map((t) => t.name);
export function agentTools(agent: { tools: string[] | null | undefined; use_memory: boolean | number; apps?: string[] | null }): string[] {
  // write tools never come with "every tool": only an agent that lists them
  const picked = agent.tools?.length ? new Set([...agent.tools, ...NOTEBOOK_TOOLS, ...ALWAYS_TOOLS]) : new Set(TOOL_NAMES.filter((n) => !WRITE_TOOLS.includes(n)));
  return TOOL_NAMES.filter((n) => picked.has(n) && (agent.use_memory ? true : !MEMORY_TOOLS.includes(n)) && (agent.apps?.length ? true : !APP_TOOLS.includes(n)));
}

/** claude --allowedTools entries for those tools (the fleet MCP server's names). */
export const allowedToolsArg = (tools: string[]) => tools.map((n) => `mcp__fleet__${n}`);

/** Keep only the allowed tools of a list (the MCP server's tools/list). */
export function filterTools<T extends { name: string }>(list: readonly T[], allowed: string[]): T[] {
  const ok = new Set(allowed);
  return list.filter((t) => ok.has(t.name));
}

export interface SkillLite { name: string; description?: string; body: string }

/** A skill's slug: lower case words joined by dashes. */
export const skillSlug = (s: string) => s.toLowerCase().replace(/^\/+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** "/slug rest" expands to that skill's body + the rest (slash skills). Returns the prompt Claude gets and the skill used;
 *  an unknown slug or plain text comes back unchanged. */
export function expandSkill(text: string, skills: SkillLite[]): { prompt: string; skill: string | null } {
  const m = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return { prompt: text, skill: null };
  const s = skills.find((x) => x.name === m[1].toLowerCase());
  if (!s) return { prompt: text, skill: null };
  const rest = (m[2] ?? '').trim();
  return { prompt: `Follow the skill "/${s.name}":\n<skill>\n${s.body.trim()}\n</skill>\n\n${rest || 'Run the skill now.'}`, skill: s.name };
}

/** An agent's mark: one of these icons in one of these colours (components/ai/agent-mark.tsx draws them). */
export const AGENT_ICONS = ['sparkles', 'chart', 'cash', 'headset', 'target', 'users', 'bolt', 'robot'];
export const AGENT_COLORS = ['ink', 'cobalt', 'green', 'amber', 'red', 'violet'];
