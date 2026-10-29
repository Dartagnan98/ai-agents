import { NextRequest, NextResponse } from 'next/server';
import { finishInstall, readState, redirectUri } from '@/lib/slack/app';
import { appUrl } from '@/lib/accounts/config';

export const dynamic = 'force-dynamic';

// Slack sends the browser back here after "Add to Slack" (public path: the signed state + this browser's nonce cookie prove who started
// it). Exchanges the code, saves the bot token for the state's agency, then returns to Settings › Agency with the outcome.
export async function GET(req: NextRequest) {
  const base = appUrl(req.nextUrl.origin) ?? new URL(redirectUri() ?? req.url).origin;
  const back = (q: Record<string, string>) => {
    const res = NextResponse.redirect(`${base}/settings?${new URLSearchParams({ tab: 'agency', step: 'tools', ...q })}`);
    res.cookies.set('ctrlos_slack_nonce', '', { path: '/api/slack/oauth', maxAge: 0 });
    return res;
  };
  const p = req.nextUrl.searchParams;
  if (p.get('error')) return back({ slack: 'cancelled' });
  const state = readState(p.get('state'));
  const nonce = req.cookies.get('ctrlos_slack_nonce')?.value ?? '';
  if (!state || !nonce || nonce !== state.nonce) return back({ slack: 'error', why: 'The Slack install link expired or was opened in another browser. Press Connect Slack again.' });
  const code = p.get('code') ?? '';
  if (!/^[A-Za-z0-9._-]{10,200}$/.test(code)) return back({ slack: 'error', why: 'Slack did not send an install code.' });
  const r = await finishInstall(code, state);
  return r.ok ? back({ slack: 'connected', team: r.teamName }) : back({ slack: 'error', why: r.error });
}
