import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { getGrant, realSessionUserId } from '@/lib/user-access';
import { signViewAs, VIEW_AS_COOKIE, VIEW_AS_TTL_MS } from '@/lib/view-as';

export const dynamic = 'force-dynamic';

// View as (lib/view-as.ts). POST {userId}: an owner starts looking as that login (read-only, 2 hours). DELETE: stop. The middleware
// lets only this route write while the cookie is set.
const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: process.env.NODE_ENV === 'production' };

export async function POST(req: NextRequest) {
  const session = await auth();
  const real = realSessionUserId(session);
  if (!real || getGrant(real).role !== 'owner') return NextResponse.json({ error: 'Only an owner can view as someone else.' }, { status: 403 });
  const b = await req.json().catch(() => ({})) as { userId?: unknown };
  const target = Number(b.userId);
  const row = Number.isInteger(target) ? db.prepare('SELECT username FROM users WHERE id = ?').get(target) as { username: string } | undefined : undefined;
  if (!row) return NextResponse.json({ error: 'No such login.' }, { status: 404 });
  if (target === real) return NextResponse.json({ error: 'That is you.' }, { status: 400 });
  console.log(`[view-as] login ${real} views as ${target} (${row.username})`);
  const res = NextResponse.json({ ok: true, name: row.username });
  res.cookies.set(VIEW_AS_COOKIE, signViewAs(target, real, String(session?.user?.id ?? '')), { ...cookieOpts, maxAge: VIEW_AS_TTL_MS / 1000 });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(VIEW_AS_COOKIE, '', { ...cookieOpts, maxAge: 0 });
  return res;
}
