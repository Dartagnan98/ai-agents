import type Database from 'better-sqlite3';
import { db } from '@/lib/db';
import { getGrant } from '@/lib/user-access';
import { isMultiTenant } from '@/lib/platform/mode';
import { getMembership, platformDb } from '@/lib/platform/db';
import { schemaOnce } from '@/lib/schema-once';
import { asAgency, botToken, installForTeam, markDisconnected, setTokenCleared, slackApi, type SlackFetch } from './app';
import { postMessage, react } from './post';
import { takeLinkCode } from '@/lib/ai/telegram';

// Events API work (D, 2026-10-10), run after the route has answered Slack. Routed by team id to the one agency that installed the app:
//  - a post in one of that agency's deal channels -> its `slack` sync job, soon (the tested fleet-sync parser credits it; no second
//    parser here). Never for the legacy agency (the agency credits deals on its own pipeline; the worker refuses it anyway).
//  - a DM to the bot from someone whose Slack email is an owner or admin login of that agency -> a the agents turn, answered in the DM.
//  - @the bot in a channel -> a the agents turn answered in that thread; later replies in the thread carry on
//    without a new mention. Who it answers: owners and admins, matched by Slack email or linked once with "link CODE" in a DM (the agency's
//    logins are names, not emails). Works for the legacy agency too.
//  - app_uninstalled / tokens_revoked -> the agency shows Slack as not connected.
// Messages from our own bot are ignored. Unknown or disconnected workspaces are ignored.

export interface SlackEvent { type?: string; subtype?: string; channel?: string; channel_type?: string; user?: string; bot_id?: string; text?: string; ts?: string; thread_ts?: string; tokens?: { bot?: string[] } }
export interface EventEnvelope { type?: string; team_id?: string; event_id?: string; api_app_id?: string; event?: SlackEvent; authorizations?: { team_id?: string }[] }
export type EventOutcome = 'ignored' | 'unknown-team' | 'own-bot' | 'posted' | 'dm' | 'mention' | 'disconnected';

export interface EventDeps {
  channelPost?: (channel: string) => void; // a new top-level post: routines watching that channel run now
  aiTurn: (input: { userId: number; threadId: number | null; text: string }) => Promise<{ reply: string; threadId: number }>;
  fetch?: SlackFetch;
}

const seen = new Map<string, number>(); // event ids handled lately (Slack retries an event it thinks we missed)
function firstTime(id: string | undefined, now = Date.now()): boolean {
  if (!id) return true;
  for (const [k, at] of seen) if (at < now - 30 * 60_000) seen.delete(k);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}

// one continuous the agents conversation per Slack user, in the agency's own SQLite
const ready = schemaOnce();
function links(): Database.Database {
  if (!ready.done()) {
    db.exec(`CREATE TABLE IF NOT EXISTS ai_slack_links (slack_user TEXT PRIMARY KEY, user_id INTEGER NOT NULL, thread_id INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_slack_threads (channel TEXT NOT NULL, thread_ts TEXT NOT NULL, user_id INTEGER NOT NULL, ai_thread INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (channel, thread_ts, user_id))`);
    ready.mark();
  }
  return db as unknown as Database.Database;
}

/** The agency login with that email: multi-agency = the platform user's membership here; single = a login named with that email. */
export function loginForEmail(agencyId: string, email: string): number | null {
  const e = email.trim().toLowerCase();
  if (!e.includes('@')) return null;
  if (isMultiTenant() && agencyId !== 'single') {
    const u = platformDb().prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(e) as { id: string } | undefined;
    return u ? getMembership(u.id, agencyId)?.localUserId ?? null : null;
  }
  const r = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(e) as { id: number } | undefined;
  return r?.id ?? null;
}

const plain = (t: string) => t.replace(/```ctrl-[a-z]+\s*\n?[\s\S]*?```/g, '(see the chart or table in the app)').replace(/\*\*([^*]+)\*\*/g, '*$1*');

const NOT_YOU = 'I answer this agency\'s owners, admins, managers and clients. If you are one, link your Slack once: in the app open Settings › AI connections › Slack, press Link my Slack, and send me the code here in a DM as "link CODE".';

/** The login behind a Slack user (owner, admin, manager or client; the AI applies each one's limits, lib/ai/tools.ts): linked with a code,
 *  else matched by Slack email. Null for everyone else. */
async function loginForSlack(agencyId: string, slackUser: string, f: SlackFetch): Promise<number | null> {
  const linked = (links().prepare('SELECT user_id FROM ai_slack_links WHERE slack_user = ?').get(slackUser) as { user_id: number } | undefined)?.user_id ?? null;
  let uid = linked;
  if (!uid) {
    const info = await slackApi('users.info', { token: botToken(), form: { user: slackUser } }, f);
    const email = String(((info.user as { profile?: { email?: string } } | undefined)?.profile?.email) ?? '');
    uid = email ? loginForEmail(agencyId, email) : null;
  }
  const role = uid ? getGrant(uid).role : null;
  return uid && (role === 'owner' || role === 'admin' || role === 'manager' || role === 'client') ? uid : null;
}

const YES = /^(yes|yep|yeah|yup|ya|y|ok|okay|sure|go|go ahead|do it|send it|ship it|post it|approve|approved|confirm|confirmed|sounds good|perfect)\b/i;
const NO = /^(no|nope|nah|n|don'?t|do not|deny|denied|reject|cancel|stop|hold off|leave it)\b/i;
/** the AI asks before a change it may not make on its own (GHL writes, app runs, people links, experiments) and waits: the person's
 *  short "yes" / "no" (or "yes 139") in the same Slack DM or thread runs or drops what it asked about in the last day (D, 2026-10-26:
 *  "it can ask normally and wait for yes, it doesn't need to be a card"; Slack has no Approve button). Their own signed Slack message,
 *  not text the AI read. Null when the text is not a short answer or nothing is waiting, so it goes to the AI as usual. */
export async function approvalReply(uid: number, threadId: number | null, text: string): Promise<string | null> {
  const t = text.trim().replace(/[.!]+$/, '');
  const yes = YES.test(t), no = !yes && NO.test(t);
  if (!threadId || t.length > 60 || (!yes && !no)) return null;
  const ids = [...t.matchAll(/#?(\d+)/g)].map((x) => Number(x[1]));
  const { decide, listApprovals } = await import('@/lib/ai/approvals');
  const since = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 19);
  const waiting = listApprovals(uid, threadId).filter((a) => a.status === 'pending' && a.created_at.slice(0, 19) >= since && (!ids.length || ids.includes(a.id)));
  if (!waiting.length) return null;
  const out: string[] = [];
  for (const a of waiting) {
    const r = await decide(uid, a.id, yes);
    out.push(r.status === 'approved' ? `Done: ${r.result}` : r.status === 'failed' ? `Could not do it: ${r.result}` : `Left as it was: ${a.summary}`);
  }
  return out.join('\n');
}

async function directMessage(agencyId: string, ev: SlackEvent, deps: EventDeps): Promise<EventOutcome> {
  const f = deps.fetch ?? fetch;
  const text = (ev.text ?? '').trim(), channel = ev.channel!, thread = ev.thread_ts || ev.ts || null;
  if (!text || !ev.user) return 'ignored';
  const say = (t: string) => postMessage(null, channel, plain(t), thread, f);
  const code = /^link\s+([A-Z0-9]{6,12})$/i.exec(text);
  if (code) {
    const who = takeLinkCode(code[1]);
    if (!who) { await say('That code is wrong or expired. Get a new one in the app: Settings › AI connections › Slack › Link my Slack.'); return 'dm'; }
    links().prepare(`INSERT INTO ai_slack_links (slack_user, user_id, thread_id, updated_at) VALUES (?, ?, NULL, ?) ON CONFLICT(slack_user) DO UPDATE SET user_id = excluded.user_id, thread_id = NULL, updated_at = excluded.updated_at`).run(ev.user, who, Date.now());
    await say('Linked. DM me anything about the agency, or mention me in a channel and I answer in the thread.');
    return 'dm';
  }
  const uid = await loginForSlack(agencyId, ev.user, f);
  if (!uid) { await say(NOT_YOU); return 'dm'; }
  const d = links();
  const link = d.prepare('SELECT user_id, thread_id FROM ai_slack_links WHERE slack_user = ?').get(ev.user) as { user_id: number; thread_id: number | null } | undefined;
  if (/^(new|\/new|start over)$/i.test(text)) {
    d.prepare(`INSERT INTO ai_slack_links (slack_user, user_id, thread_id, updated_at) VALUES (?, ?, NULL, ?) ON CONFLICT(slack_user) DO UPDATE SET user_id = excluded.user_id, thread_id = NULL, updated_at = excluded.updated_at`).run(ev.user, uid, Date.now());
    await say('New conversation. What should we work on?');
    return 'dm';
  }
  const decided = await approvalReply(uid, link && link.user_id === uid ? link.thread_id : null, text);
  if (decided) { await say(decided); return 'dm'; }
  const r = await deps.aiTurn({ userId: uid, threadId: link && link.user_id === uid ? link.thread_id : null, text });
  d.prepare(`INSERT INTO ai_slack_links (slack_user, user_id, thread_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(slack_user) DO UPDATE SET user_id = excluded.user_id, thread_id = excluded.thread_id, updated_at = excluded.updated_at`)
    .run(ev.user, uid, r.threadId || null, Date.now());
  await say(r.reply);
  return 'dm';
}

/** @AI Agents in a channel, or a reply in a thread it already answers in: a the agents turn per person per thread, answered in the thread. */
async function channelTurn(agencyId: string, ev: SlackEvent, deps: EventDeps, botUser: string, followUp: boolean): Promise<EventOutcome> {
  const f = deps.fetch ?? fetch;
  const channel = ev.channel!, root = ev.thread_ts || ev.ts!;
  const text = (ev.text ?? '').replace(new RegExp(`<@${botUser || 'U'}[^>]*>`, 'g'), '').trim();
  const uid = await loginForSlack(agencyId, ev.user!, f);
  if (!uid) { if (!followUp) await postMessage(null, channel, NOT_YOU, root, f); return followUp ? 'ignored' : 'mention'; }
  if (!text) { await postMessage(null, channel, 'What should we work on?', root, f); return 'mention'; }
  void react(null, channel, ev.ts!, 'eyes', f).catch(() => null);
  const d = links();
  const row = d.prepare('SELECT ai_thread FROM ai_slack_threads WHERE channel = ? AND thread_ts = ? AND user_id = ?').get(channel, root, uid) as { ai_thread: number | null } | undefined;
  const decided = await approvalReply(uid, row?.ai_thread ?? null, text);
  if (decided) { await postMessage(null, channel, plain(decided), root, f); return 'mention'; }
  const r = await deps.aiTurn({ userId: uid, threadId: row?.ai_thread ?? null, text });
  d.prepare(`INSERT INTO ai_slack_threads (channel, thread_ts, user_id, ai_thread, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(channel, thread_ts, user_id) DO UPDATE SET ai_thread = excluded.ai_thread, updated_at = excluded.updated_at`).run(channel, root, uid, r.threadId || null, Date.now());
  await postMessage(null, channel, plain(r.reply), root, f);
  return 'mention';
}

/** One verified event_callback. Returns what it did (tests read it). */
export async function handleEvent(env: EventEnvelope, deps: EventDeps): Promise<EventOutcome> {
  const teamId = env.team_id ?? env.authorizations?.[0]?.team_id ?? '';
  const ev = env.event ?? {};
  const inst = teamId ? installForTeam(teamId) : null;
  if (!inst) return 'unknown-team';
  if (!firstTime(env.event_id)) return 'ignored';
  if (ev.type === 'app_uninstalled' || (ev.type === 'tokens_revoked' && (ev.tokens?.bot?.length ?? 0) > 0)) {
    markDisconnected(teamId);
    asAgency(inst.agencyId, setTokenCleared);
    return 'disconnected';
  }
  if (inst.status !== 'active' || (ev.type !== 'message' && ev.type !== 'app_mention')) return 'ignored';
  if (inst.botUserId && ev.user === inst.botUserId) return 'own-bot'; // our own posts and replies (chat.postMessage carries the bot user)
  return asAgency(inst.agencyId, async () => {
    if (ev.type === 'app_mention') return ev.user && ev.channel && ev.ts && !ev.bot_id ? channelTurn(inst.agencyId, ev, deps, inst.botUserId, false) : 'ignored' as const;
    // a reply in a thread it answers in carries on without a new mention (a reply WITH the mention comes as app_mention too: skip it here)
    if ((ev.channel_type === 'channel' || ev.channel_type === 'group') && ev.thread_ts && ev.user && !ev.subtype && !ev.bot_id && ev.channel
      && !(ev.text ?? '').includes(`<@${inst.botUserId}`)
      && links().prepare('SELECT 1 FROM ai_slack_threads WHERE channel = ? AND thread_ts = ? LIMIT 1').get(ev.channel, ev.thread_ts)) {
      return channelTurn(inst.agencyId, ev, deps, inst.botUserId, true);
    }
    if (ev.channel_type === 'im') {
      if (ev.subtype || ev.bot_id) return 'ignored' as const; // edits, joins, other bots
      return directMessage(inst.agencyId, ev, deps);
    }
    if (ev.channel_type !== 'channel' && ev.channel_type !== 'group') return 'ignored' as const;
    // a new top-level post (people or a form bot; not edits, deletes or joins) starts the routines that watch this channel
    if (ev.channel && (!ev.subtype || ev.subtype === 'bot_message') && (!ev.thread_ts || ev.thread_ts === ev.ts)) deps.channelPost?.(ev.channel);
    return 'posted' as const;
  });
}
