import { NextResponse } from 'next/server';
import { currentUserId, getGrant } from '@/lib/user-access';
import { agencyIdNow, authorizeUrl, redirectUri, signState, slackAppConfig } from '@/lib/slack/app';

export const dynamic = 'force-dynamic';

// "Connect Slack" (D, 2026-10-10, docs/SLACK_APP.md): the owner or an admin of the current agency is sent to Slack's install screen.
// The state names the agency and the login (signed, 10 minutes); a cookie holds its nonce so only this browser can finish the install.
export async function GET() {
  const uid = await currentUserId();
  const role = uid ? getGrant(uid).role : null;
  if (!uid || (role !== 'owner' && role !== 'admin')) return Response.json({ error: 'Only the owner or an admin can connect Slack.' }, { status: 403 });
  const cfg = slackAppConfig(), redirect = redirectUri();
  if (!cfg || !redirect) return Response.json({ error: 'The Slack app is not set up on this server yet.' }, { status: 503 });
  const { state, nonce } = signState(agencyIdNow(), uid);
  const res = NextResponse.redirect(authorizeUrl(cfg, state, redirect));
  res.cookies.set('ctrlos_slack_nonce', nonce, { httpOnly: true, secure: redirect.startsWith('https://'), sameSite: 'lax', path: '/api/slack/oauth', maxAge: 600 });
  return res;
}
