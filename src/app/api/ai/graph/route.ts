import { NextRequest } from 'next/server';
import { aiUser, aiDenied } from '@/lib/ai/access';
import { mapNodeDetail, memoryMap } from '@/lib/ai/team-graph';

export const dynamic = 'force-dynamic';

// AI › Graph (D, 2026-10-23): the memory map (owner and admins, like Memory); ?node=<id> is one node's side panel.
export async function GET(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const node = req.nextUrl.searchParams.get('node');
  if (node) { const d = mapNodeDetail(node.slice(0, 120)); return d ? Response.json(d) : Response.json({ error: 'Not found' }, { status: 404 }); }
  return Response.json(memoryMap());
}
