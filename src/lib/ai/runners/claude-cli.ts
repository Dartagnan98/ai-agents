import 'server-only';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeEnv } from '@/lib/ai/claude-env';
import { noteClaudeFailure } from '@/lib/ai/claude-login-alert';
import { allowedToolsArg } from '@/lib/ai/catalog';
import type { Runner, Usage } from './types';

// Claude subscription runner (D, 2026-10-09; on the Claude Agent SDK since 2026-10-12, D: "I want agent SDK"). One query() per message,
// resuming the conversation's own Claude Code session, on the Claude login claudeEnv() picks (the agency's connected token, else the
// box's). Control: our instructions REPLACE Claude Code's default system prompt (a much smaller start), no built-in tools at all
// (tools: []), no settings files or CLAUDE.md (settingSources: []), and the only tools are the agent's Fleet tools over MCP
// (allowedTools names each one; the MCP server filters again by the run key). Anything else is refused (dontAsk). Usage per message
// comes from the result's per-turn `usage`.
// Sessions live under one fixed working folder, so a conversation resumes from the same project every time.
const CWD = path.join(os.tmpdir(), 'fleet-ai');

// a real browser (D 2026-10-28): headless Chromium through Playwright's MCP server in /root/agent-browser, a fresh
// in-memory profile per run (no saved logins), screenshots under /tmp/agent-browser (send_file sends them). Only for runs that already
// have the shell (owner/admin workspace tools): the browser can reach this box's local-only pages, and so can the shell. AI_BROWSER=off.
const BROWSER_BIN = process.env.AI_BROWSER_BIN || '/root/agent-browser/node_modules/.bin/playwright-mcp';
const browserFor = (tools: string[] | null | undefined) => (process.env.AI_BROWSER || '').toLowerCase() !== 'off' && !!tools?.includes('workspace_run') && fs.existsSync(BROWSER_BIN)
  ? { browser: { type: 'stdio' as const, command: BROWSER_BIN, args: ['--headless', '--isolated', '--browser', 'chromium', '--no-sandbox', '--output-dir', '/tmp/agent-browser', '--viewport-size', '1280x900'] } } : null;

/** True when the box has a Claude login for headless runs. */
export const claudeCliAvailable = () => !!claudeEnv();

/** Where Claude Code keeps a session's transcript (its projects folder is named after the working folder). */
export const sessionFile = (id: string, home = os.homedir()) => path.join(home, '.claude', 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);

export const run: Runner = async (input) => {
  const env = claudeEnv();
  if (!env) return { error: 'No Claude login on the server. Connect one in Settings.' };
  fs.mkdirSync(CWD, { recursive: true });
  const ac = new AbortController();
  const abort = () => ac.abort();
  if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, { once: true });
  let context: number | undefined, usage: Usage | undefined, error: string | undefined;
  const started = new Set<string>();
  try {
    // pictures and PDFs: the message goes as one user turn with image / document blocks (the SDK's streaming input)
    const media = input.media ?? [];
    const prompt = media.length ? (async function* () {
      yield { type: 'user' as const, parent_tool_use_id: null, session_id: input.session.id, message: { role: 'user' as const, content: [
        { type: 'text' as const, text: input.prompt },
        ...media.map((m) => (m.kind === 'image'
          ? { type: 'image' as const, source: { type: 'base64' as const, media_type: m.mediaType as 'image/png', data: m.data } }
          : { type: 'document' as const, title: m.name, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: m.data } })),
      ] } };
    })() : input.prompt;
    const browser = browserFor(input.tools);
    const q = query({ prompt, options: {
      model: input.model,
      systemPrompt: input.system,
      tools: [],
      settingSources: [],
      mcpServers: { fleet: { type: 'http', url: input.mcp.url, headers: { Authorization: `Bearer ${input.mcp.key}` } }, ...browser },
      strictMcpConfig: true,
      allowedTools: [...allowedToolsArg(input.tools), ...(browser ? ['mcp__browser'] : [])],
      // bypass (D, 2026-10-26): no built-in tools, only Fleet's MCP, which checks each agent's own tool list (lib/ai/tools.ts callTool)
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      // a session that was never written (compaction gives a new id; the run after it can be cut off) starts fresh under that id
      // instead of failing every later message with "No conversation found" (D, 2026-10-23); the summary rides in the system prompt
      ...(input.session.resume && fs.existsSync(sessionFile(input.session.id)) ? { resume: input.session.id } : { sessionId: input.session.id }),
      cwd: CWD,
      // Fleet's few tools load up front, no extra lookup round before the first tool call
      // MAX_MCP_OUTPUT_TOKENS: a tool answer up to ~100k tokens stays in the conversation (the agency's month worksheets are ~30k; the default
      // 25k cap saved it to a file the agent cannot read, D 2026-10-12)
      // MCP_TOOL_TIMEOUT: the MCP client gives up after 60 s; BETA's month worksheet takes ~70 s to build (2026-10-28, 3 nights unsaved)
      env: { ...env, ENABLE_TOOL_SEARCH: 'false', MAX_MCP_OUTPUT_TOKENS: '100000', MCP_TOOL_TIMEOUT: '900000', CLAUDE_AGENT_SDK_CLIENT_APP: 'ctrl-os-fleet-ai', IS_SANDBOX: '1' /* the app runs as root; the CLI refuses bypass for root without it */ },
      abortController: ac,
    } });
    for await (const m of q as AsyncIterable<SDKMessage>) {
      if (m.type === 'stream_event') {
        const e = m.event;
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta' && e.delta.text) input.onText(e.delta.text);
      } else if (m.type === 'assistant') {
        // how full the conversation is: the last call's input, cache included (compaction reads it)
        const u = m.message.usage;
        if (u) context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
        for (const c of m.message.content) {
          if (c.type !== 'tool_use' || started.has(c.id)) continue;
          started.add(c.id);
          input.onToolStart(c.id, c.name.replace(/^mcp__(fleet|browser)__/, ''), (c.input ?? {}) as Record<string, unknown>);
        }
      } else if (m.type === 'user') {
        const content = m.message.content;
        if (Array.isArray(content)) for (const c of content) if (c.type === 'tool_result') input.onToolEnd(c.tool_use_id, !!c.is_error);
      } else if (m.type === 'result') {
        // this turn's tokens, every model call of the main loop summed (cost per message, D 2026-10-12)
        const u = m.usage;
        usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
        if (m.is_error) error = (m.subtype === 'success' ? m.result : m.subtype).slice(0, 300) || 'Claude stopped with an error';
      }
    }
  } catch (e) {
    if (!input.signal.aborted) error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  } finally {
    input.signal.removeEventListener('abort', abort);
  }
  if (error) noteClaudeFailure(error); // a dead login: Settings badge + one Slack DM to the owners (lib/ai/claude-login-alert.ts)
  return error ? { error, context, usage } : { context, usage };
};
