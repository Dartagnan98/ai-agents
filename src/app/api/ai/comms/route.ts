import { aiUser, aiDenied } from '@/lib/ai/access';
import { listComms } from '@/lib/ai/comms';

export const dynamic = 'force-dynamic';

// AI › Comms (D, 2026-10-23): every ask, message and hand-off between agents, newest first (owner and admins).
export async function GET() {
  const me = await aiUser();
  if (!me) return aiDenied();
  return Response.json({ comms: listComms(300) });
}
