import { NextResponse } from 'next/server';
import { currentUserId, getGrant } from './user-access';

/** The agent fleet's own routes (agents, tasks, crons, comms, approvals, wiki, kb, skills, system and Telegram settings):
 *  the owner and admins only, like the AI and Settings pages they serve (settings audit 2026-10-06: the middleware only checks
 *  that someone is signed in, so a rep or client login could read and change all of it by URL). Null = go on. */
export async function staffOnly(): Promise<NextResponse | null> {
  const id = await currentUserId();
  const role = id ? getGrant(id).role : null;
  if (role === 'owner' || role === 'admin') return null;
  return NextResponse.json({ error: id ? 'no access' : 'Unauthorized' }, { status: id ? 403 : 401 });
}
