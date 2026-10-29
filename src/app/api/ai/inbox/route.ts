import { aiUser } from '@/lib/ai/access';
import { inboxCount } from '@/lib/ai/inbox';

export const dynamic = 'force-dynamic';

// The sidebar's Inbox count (components/layout/sidebar.tsx): unread items that need this owner or admin. Others get 0.
export async function GET() {
  const me = await aiUser();
  if (!me) return Response.json({ count: 0 });
  return Response.json({ count: await inboxCount(me.uid).catch(() => 0) });
}
