import { NextRequest } from 'next/server';
import { callTool, runKeyUser, toolsFor } from '@/lib/ai/tools';
import { filterTools } from '@/lib/ai/catalog';
import { routineTickKey } from '@/lib/ai/routine-clock';
import { routineTick } from '@/lib/ai/routine-scheduler';

export const dynamic = 'force-dynamic';

// the agents tool server (MCP over HTTP, JSON responses): the headless Claude run that app/api/ai/chat starts calls this on the same app
// copy, from 127.0.0.1, with its run key (Bearer fai_...). No key or an expired one = nothing. The middleware lets this path through
// without a session; this handler is the only gate. Tools and access: lib/ai/tools.ts. The run key names the agent's tools; the list
// and calls only see those (D, 2026-10-09).
type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };
const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function POST(req: NextRequest) {
  const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!hops.every((h) => h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1')) return Response.json({ error: 'Not found' }, { status: 404 });
  // the routine timer's tick (D, 2026-10-09: lib/ai/routine-clock.ts, this copy's own key; loopback only, checked above)
  const tick = req.headers.get('x-fleet-routine-tick');
  if (tick) return tick === routineTickKey() ? Response.json({ fired: await routineTick() }) : Response.json({ error: 'Unauthorized' }, { status: 401 });
  const run = runKeyUser((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
  if (!run) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let body: Rpc | Rpc[];
  try { body = await req.json(); } catch { return Response.json(fail(null, -32700, 'Parse error'), { status: 400 }); }
  const one = async (m: Rpc) => {
    if (m.method === 'initialize') return ok(m.id, { protocolVersion: (m.params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fleet', version: '1' } });
    if (m.method === 'tools/list') return ok(m.id, { tools: filterTools(toolsFor(run), run.tools).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    if (m.method === 'tools/call') {
      const name = String(m.params?.name ?? ''), args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try { return ok(m.id, { content: [{ type: 'text', text: await callTool(run, name, args) }] }); }
      catch (e) { return ok(m.id, { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }); }
    }
    if (m.method === 'ping') return ok(m.id, {});
    if (m.id === undefined || m.id === null) return null; // notifications (notifications/initialized ...)
    return fail(m.id, -32601, `Method not found: ${m.method}`);
  };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(one))).filter(Boolean);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await one(body);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}

export async function GET() { return new Response(null, { status: 405 }); }
