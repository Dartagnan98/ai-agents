import Anthropic from '@anthropic-ai/sdk';
import 'server-only';
import { connSecret, planCredential, planHeaders, markConnection, type PlanKind } from '@/lib/ai/connections';
import type { Runner, RunInput, Usage } from './types';

// API-key and plan runners (D, 2026-10-09: AI connections). One turn = a small agent loop: call the model with the conversation so
// far and the agent's Fleet tools, run any tool calls through the same Fleet tool server the Claude runs use (so the run key's
// allow-list applies in one place), feed the results back, until the model answers. Anthropic's Messages API for Claude keys;
// the OpenAI Responses API for OpenAI keys, xAI keys and the experimental ChatGPT / SuperGrok plans (plan-stream.ts).
const MAX_ROUNDS = 12;
type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };

async function mcp(input: RunInput, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(input.mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.mcp.key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: input.signal });
  const j = await res.json().catch(() => ({})) as { result?: Record<string, unknown>; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message || 'Tool server error');
  return j.result ?? {};
}
async function listTools(input: RunInput): Promise<Tool[]> {
  if (!input.tools.length) return [];
  const r = await mcp(input, 'tools/list');
  return ((r.tools as Tool[]) ?? []).filter((t) => input.tools.includes(t.name));
}
async function callTool(input: RunInput, id: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  input.onToolStart(id, name, args);
  try {
    const r = await mcp(input, 'tools/call', { name, arguments: args });
    const text = ((r.content as { text?: string }[]) ?? []).map((c) => c.text ?? '').join('\n');
    input.onToolEnd(id, !!r.isError);
    return { text, isError: !!r.isError };
  } catch (e) {
    input.onToolEnd(id, true);
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
async function* sse(res: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body!.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* skip */ }
    }
  }
}
const history = (input: RunInput) => (input.history ?? []).filter((m) => m.text.trim());

// ─── Claude through an Anthropic API key (official SDK, D 2026-10-12) ───
// One turn = a manual tool loop: stream a model call, run its tool_use blocks through the Fleet tool server, append the whole assistant
// message (thinking blocks stay unchanged, so the next call accepts them) and the tool results, repeat until it answers.
// Prompt caching: render order is tools -> system -> messages. Tools sorted by name (a stable prefix), a 1-hour breakpoint on the system
// prompt (instructions + memory change at most a few times a day), and the top-level automatic breakpoint, which caches up to the last
// block and moves forward each round, so the history and every tool result are read back at a tenth of the price. A 1-hour cache write
// costs 2x input. The SDK retries 429/5xx itself (2 times).
export const runAnthropicApi: Runner = async (input) => {
  const key = connSecret('anthropic-key');
  if (!key) return { error: 'No Anthropic API key connected. Add one in Settings › AI connections.' };
  const client = new Anthropic({ apiKey: key });
  const tools: Anthropic.Tool[] = (await listTools(input).catch(() => []))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
  const system: Anthropic.TextBlockParam[] = [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral', ttl: '1h' } }];
  // pictures and PDFs sent with this message ride as image / document blocks (lib/ai/attachments.ts)
  const media = (input.media ?? []).map((m): Anthropic.ContentBlockParam => (m.kind === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: m.mediaType as 'image/png', data: m.data } }
    : { type: 'document', title: m.name, source: { type: 'base64', media_type: 'application/pdf', data: m.data } }));
  const messages: Anthropic.MessageParam[] = [...history(input).map((m) => ({ role: m.role, content: m.text })),
    { role: 'user', content: media.length ? [{ type: 'text', text: input.prompt }, ...media] : input.prompt }];
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let context: number | undefined;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let final: Anthropic.Message;
    try {
      const stream = client.messages.stream({ model: input.model, max_tokens: 32000, system, messages, cache_control: { type: 'ephemeral', ttl: '1h' },
        ...(tools.length ? { tools } : {}) }, { signal: input.signal });
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') input.onText(ev.delta.text);
      }
      final = await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) { markConnection('anthropic-key', 'error', 'The key was not accepted.'); return { error: 'The Anthropic API key was not accepted.', context, usage }; }
      if (e instanceof Anthropic.RateLimitError) return { error: 'Anthropic is rate limiting this key. Try again in a minute.', context, usage };
      if (e instanceof Anthropic.APIError) return { error: `Anthropic answered ${e.status ?? ''}: ${e.message.slice(0, 200)}`, context, usage };
      return { error: e instanceof Error ? e.message : String(e), context, usage };
    }
    const u = final.usage;
    usage.input += u.input_tokens; usage.output += u.output_tokens; usage.cacheRead += u.cache_read_input_tokens ?? 0; usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    context = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (final.stop_reason === 'refusal') return { error: 'Claude declined this request.', context, usage };
    const calls = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    // a tool input cut off by max_tokens is never run
    if (final.stop_reason !== 'tool_use' || !calls.length) return final.stop_reason === 'max_tokens' && calls.length ? { error: 'The answer was cut off.', context, usage } : { context, usage };
    messages.push({ role: 'assistant', content: final.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const c of calls) {
      const r = await callTool(input, c.id, c.name, (c.input ?? {}) as Record<string, unknown>);
      results.push({ type: 'tool_result', tool_use_id: c.id, content: r.text, is_error: r.isError });
    }
    messages.push({ role: 'user', content: results });
  }
  return { error: 'Stopped after too many tool rounds.', context, usage };
};

// ─── OpenAI Responses API: OpenAI key, xAI key, ChatGPT plan, SuperGrok plan ───
type ResponsesKind = 'openai-api' | 'xai-api' | 'chatgpt-plan' | 'grok-plan';
async function endpoint(kind: ResponsesKind, sessionId: string): Promise<{ url: string; headers: Record<string, string> } | { error: string }> {
  if (kind === 'openai-api' || kind === 'xai-api') {
    const key = connSecret(kind === 'openai-api' ? 'openai-key' : 'xai-key');
    if (!key) return { error: `No ${kind === 'openai-api' ? 'OpenAI' : 'xAI'} API key connected. Add one in Settings › AI connections.` };
    return { url: `${kind === 'openai-api' ? 'https://api.openai.com/v1' : 'https://api.x.ai/v1'}/responses`, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' } };
  }
  try {
    const c = await planCredential(kind as PlanKind);
    return { url: `${c.baseUrl}/responses`, headers: planHeaders(kind as PlanKind, c, sessionId) };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}
export const responsesRunner = (kind: ResponsesKind): Runner => async (input) => {
  const ep = await endpoint(kind, input.session.id);
  if ('error' in ep) return { error: ep.error };
  const tools = await listTools(input).catch(() => []);
  const items: Record<string, unknown>[] = [
    ...history(input).map((m) => (m.role === 'assistant' ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.text }] } : { type: 'message', role: 'user', content: [{ type: 'input_text', text: m.text }] })),
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: input.prompt },
      ...(input.media ?? []).map((m) => (m.kind === 'image' ? { type: 'input_image', image_url: `data:${m.mediaType};base64,${m.data}` }
        : { type: 'input_file', filename: m.name, file_data: `data:application/pdf;base64,${m.data}` }))] },
  ];
  let context: number | undefined;
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body: Record<string, unknown> = { model: input.model, instructions: input.system, input: items, store: false, stream: true };
    // OpenAI caches long prompt prefixes by itself; a cache key per conversation keeps its turns on the same cache (D, 2026-10-12)
    if (kind === 'openai-api') body.prompt_cache_key = input.session.id.slice(0, 64);
    if (tools.length) Object.assign(body, { tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema, strict: false })), tool_choice: 'auto' });
    if (kind === 'chatgpt-plan') Object.assign(body, { reasoning: { effort: 'medium', summary: 'auto' }, include: [], prompt_cache_key: input.session.id.slice(0, 64) });
    const res = await fetch(ep.url, { method: 'POST', headers: ep.headers, body: JSON.stringify(body), signal: input.signal }).catch((e: Error) => e);
    if (res instanceof Error) return { error: res.message };
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      if (res.status === 401) markConnection(kind === 'openai-api' ? 'openai-key' : kind === 'xai-api' ? 'xai-key' : kind, 'error', 'Not accepted. Reconnect.');
      if (res.status === 429 && (kind === 'chatgpt-plan' || kind === 'grok-plan')) markConnection(kind, 'limited', 'The plan reached its usage limit.');
      return { error: `${kind} answered ${res.status}: ${t.slice(0, 200)}` };
    }
    const calls = new Map<string, { call_id: string; name: string; args: string }>();
    for await (const ev of sse(res)) {
      const type = String(ev.type ?? '');
      if (type === 'response.output_text.delta') { const d = String(ev.delta ?? ''); if (d) input.onText(d); }
      else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        const it = (ev.item ?? {}) as Record<string, unknown>;
        if (it.type !== 'function_call') continue;
        const k = String(it.id ?? it.call_id);
        const c = calls.get(k) ?? { call_id: String(it.call_id ?? it.id).slice(0, 64), name: String(it.name ?? ''), args: '' };
        if (type === 'response.output_item.done' && typeof it.arguments === 'string') c.args = it.arguments;
        calls.set(k, c);
      } else if (type === 'response.function_call_arguments.delta') { const c = calls.get(String(ev.item_id ?? '')); if (c) c.args += String(ev.delta ?? ''); }
      else if (type === 'response.completed' || type === 'response.incomplete') {
        const u = ((ev.response as Record<string, unknown>)?.usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
        context = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
        const cached = u.input_tokens_details?.cached_tokens ?? 0;
        usage.input += Math.max(0, (u.input_tokens ?? 0) - cached); usage.cacheRead += cached; usage.output += u.output_tokens ?? 0;
      }
      else if (type === 'response.failed' || type === 'error') { const e = (((ev.response as Record<string, unknown>)?.error ?? ev.error ?? ev) as { message?: string }); return { error: `Model error: ${String(e.message ?? 'stopped').slice(0, 200)}`, context, usage }; }
    }
    if (!calls.size) return { context, usage };
    for (const c of calls.values()) {
      let args: Record<string, unknown> = {}; try { args = c.args ? JSON.parse(c.args) : {}; } catch { /* broken JSON: no args */ }
      items.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.args || '{}' });
      const r = await callTool(input, c.call_id, c.name, args);
      items.push({ type: 'function_call_output', call_id: c.call_id, output: r.text });
    }
  }
  return { error: 'Stopped after too many tool rounds.', context, usage };
};
