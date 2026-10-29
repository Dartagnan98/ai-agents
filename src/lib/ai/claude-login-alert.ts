import 'server-only';
import { db } from '@/lib/db';
import { getGrant } from '@/lib/user-access';
import { markConnection } from './connections';
import { sendSlack } from './routine-deliver';

// The Claude login stopped (D, 2026-10-13): when a Claude run fails on its sign-in, the connection shows "Needs attention" in
// Settings › AI connections and every owner linked in Slack gets one DM with the reconnect link, at most once every 12 hours (a mark
// in SQLite, shared by the app copies). Other errors (a tool, a timeout) are not login trouble and send nothing.

const LOGIN_TROUBLE = /\b40[13]\b|oauth|token (?:has )?expired|invalid (?:api key|bearer|token|x-api-key)|authentication|not logged in|please run \/login|unauthori[sz]ed|permission_error|credit balance/i;
const EVERY_MS = 12 * 3600_000;

export function noteClaudeFailure(error: string, now = Date.now()): boolean {
  if (!LOGIN_TROUBLE.test(error)) return false;
  try { markConnection('claude-token', 'error', 'The Claude login stopped working. Press Reconnect with Claude.'); } catch { /* no row: the box login */ }
  db.exec('CREATE TABLE IF NOT EXISTS ai_alert_marks (key TEXT PRIMARY KEY, at INTEGER NOT NULL)');
  const won = db.prepare(`INSERT INTO ai_alert_marks (key, at) VALUES ('claude-login', ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at WHERE ai_alert_marks.at < ?`)
    .run(now, now - EVERY_MS).changes > 0;
  if (!won) return false;
  let owners: string[] = [];
  try {
    owners = (db.prepare('SELECT slack_user, user_id FROM ai_slack_links').all() as { slack_user: string; user_id: number }[])
      .filter((l) => getGrant(l.user_id).role === 'owner').map((l) => l.slack_user);
  } catch { /* nobody linked yet */ }
  const link = `${(process.env.APP_URL ?? '').replace(/\/$/, '')}/settings?tab=ai`;
  const text = `*Claude login stopped working*\nthe AI's runs are failing on the Claude sign-in (${error.slice(0, 120)}). Reconnect: ${link} › Claude subscription › Reconnect with Claude.`;
  for (const u of owners) void sendSlack(u, text).catch(() => null);
  return true;
}
