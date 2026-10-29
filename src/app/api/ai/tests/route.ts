import { NextRequest } from 'next/server';
import { aiUser, aiDenied } from '@/lib/ai/access';
import { addEval, agentsForTests, deleteEval, evalHistory, listEvals, runEval, writeEvals } from '@/lib/ai/evals';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

// AI › Tests (lib/ai/evals.ts), owner and admins. GET: every test with its last score and trend. POST { agent, question, expect } adds one;
// ?write=<agent> drafts 5; ?run=<id> runs one; ?runAgent=<agent> runs all of that agent's, one at a time. DELETE ?id=.
export async function GET() {
  const me = await aiUser();
  if (!me) return aiDenied();
  return Response.json({ agents: agentsForTests(), tests: listEvals().map((e) => ({ ...e, trend: evalHistory(e.id) })) });
}
export async function POST(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const sp = req.nextUrl.searchParams;
  if (sp.get('write')) { const n = await writeEvals(Number(sp.get('write'))); return typeof n === 'string' ? Response.json({ error: n }, { status: 400 }) : Response.json({ added: n }); }
  if (sp.get('run')) return Response.json(await runEval(Number(sp.get('run'))));
  if (sp.get('runAgent')) { const out = []; for (const e of listEvals(Number(sp.get('runAgent')))) out.push(await runEval(e.id)); return Response.json({ ran: out.length }); }
  const b = await req.json().catch(() => ({})) as { agent?: number; question?: string; expect?: string };
  const r = addEval(Number(b.agent), String(b.question ?? ''), String(b.expect ?? ''));
  return typeof r === 'string' ? Response.json({ error: r }, { status: 400 }) : Response.json({ id: r });
}
export async function DELETE(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  return Response.json({ ok: deleteEval(Number(req.nextUrl.searchParams.get('id'))) });
}
