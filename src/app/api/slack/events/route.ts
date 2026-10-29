import { NextRequest } from 'next/server';
import { slackAppConfig, verifySlackSignature } from '@/lib/slack/app';
import { dispatchSlackEvent } from '@/lib/slack/dispatch';

export const dynamic = 'force-dynamic';

// Slack Events API (D, 2026-10-10, docs/SLACK_APP.md). Public path: every call must carry a valid X-Slack-Signature (signing secret, 5
// minutes). Answers at once (Slack wants 200 within 3 s) and does the work after: a deal post queues that agency's slack sync job, a DM
// to the bot gets a the agents reply.
export async function POST(req: NextRequest) {
  const cfg = slackAppConfig();
  if (!cfg) return new Response(null, { status: 404 });
  const body = await req.text();
  if (!verifySlackSignature(cfg.signingSecret, req.headers.get('x-slack-request-timestamp'), body, req.headers.get('x-slack-signature'))) {
    return new Response('bad signature', { status: 401 });
  }
  let env: Record<string, unknown>;
  try { env = JSON.parse(body) as Record<string, unknown>; } catch { return new Response(null, { status: 400 }); }
  if (env.type === 'url_verification') return Response.json({ challenge: String(env.challenge ?? '') });
  if (env.type === 'event_callback') dispatchSlackEvent(env);
  return new Response(null, { status: 200 });
}
