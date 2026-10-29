import 'server-only';
import { NextResponse } from 'next/server';
import { currentUserId, getGrant } from '@/lib/user-access';

// Who may read and change an Operations page's data (D, 2026-10-10): the same rule as the page itself (lib/access.ts filterAreas): the
// owner always; an admin when that page is ticked in their AI pages; nobody else. Null = no access (the reason is the response).
export async function opsAccess(href: '/strategy' | '/experiments' | '/workflows' | '/workflows/health' | '/analytics'): Promise<{ uid: number } | NextResponse> {
  const uid = await currentUserId();
  if (!uid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const g = getGrant(uid);
  if (g.role === 'owner' || (g.role === 'admin' && g.ai.includes(href))) return { uid };
  return NextResponse.json({ error: 'no access' }, { status: 403 });
}
