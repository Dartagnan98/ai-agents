import { NextRequest } from 'next/server';
import { aiUser, aiDenied } from '@/lib/ai/access';
import { decide, listApprovals } from '@/lib/ai/approvals';

export const dynamic = 'force-dynamic';

// Approve cards (D, 2026-10-09). GET ?thread=: this login's proposals in that conversation. POST {id, approve}: decide one.
export async function GET(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  return Response.json({ approvals: listApprovals(me.uid, Number(req.nextUrl.searchParams.get('thread'))).map(({ args: _a, ...a }) => a) });
}
export async function POST(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const b = await req.json().catch(() => ({})) as { id?: number; approve?: boolean };
  try { const a = await decide(me.uid, Number(b.id), b.approve === true); const { args: _a, ...rest } = a; return Response.json({ approval: rest }); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
}
