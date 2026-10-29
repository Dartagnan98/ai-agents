import crypto from 'crypto';
import { slackApi } from '@/lib/slack/app';
import { reportTz } from '@/lib/report-tz';
import { zoneMidnight } from '@/lib/tz';

// Reading the agency's Slack as its bot (moved out of lib/ai/tools.ts, 2026-10-22, so team memory's ingest reads it the same way).
// Channels only: direct and group messages are private (D, 2026-10-13).

type Msg = { ts: string; user?: string; bot_id?: string; username?: string; text?: string; reply_count?: number; thread_ts?: string; subtype?: string };

/** One channel's messages for one day (the agency's day), oldest first: "[3:11 AM] Name (U123): text". Throws Slack's refusal. */
export async function channelDayLines(token: string, channel: string, day: string, replies = false): Promise<string[]> {
  const info = await slackApi('conversations.info', { token, form: { channel } });
  const ch = info.channel as { is_im?: boolean; is_mpim?: boolean } | undefined;
  if (!info.ok || !ch || ch.is_im || ch.is_mpim) throw new Error(info.ok ? 'Direct and group messages are private: only channels can be read.' : `Slack said ${info.error}.`);
  const tz = reportTz(), next = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const oldest = String(Date.parse(zoneMidnight(day, tz)) / 1000), latest = String(Date.parse(zoneMidnight(next, tz)) / 1000);
  const msgs: Msg[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const r = await slackApi('conversations.history', { token, form: { channel, oldest, latest, inclusive: 'true', limit: '200', ...(cursor ? { cursor } : {}) } });
    if (!r.ok) throw new Error(r.error === 'not_in_channel' ? 'The Slack bot is not in that channel: invite it there first.' : `Slack said ${r.error}.`);
    msgs.push(...((r.messages as Msg[]) ?? []));
    cursor = String((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '');
    if (!cursor) break;
  }
  msgs.sort((x, y) => Number(x.ts) - Number(y.ts));
  const names = new Map<string, string>();
  const who = async (u?: string) => {
    if (!u) return 'bot';
    if (!names.has(u)) { const r = await slackApi('users.info', { token, form: { user: u } }); const p = r.user as { real_name?: string; name?: string } | undefined; names.set(u, p?.real_name || p?.name || u); }
    return `${names.get(u)} (${u})`;
  };
  const clock = (ts: string) => new Date(Number(ts) * 1000).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const out: string[] = [];
  for (const m of msgs.slice(0, 300)) {
    if (m.subtype === 'channel_join' || m.subtype === 'channel_leave') continue;
    out.push(`[${clock(m.ts)}] ${m.user ? await who(m.user) : m.username || 'bot'}: ${(m.text ?? '').slice(0, 2000)}`);
    if (replies && (m.reply_count ?? 0) > 0) {
      const r = await slackApi('conversations.replies', { token, form: { channel, ts: m.ts, limit: '100' } });
      for (const x of ((r.messages as Msg[]) ?? []).slice(1)) out.push(`    ↳ [${clock(x.ts)}] ${x.user ? await who(x.user) : x.username || 'bot'}: ${(x.text ?? '').slice(0, 1000)}`);
    }
  }
  return out;
}

/** A channel's raw messages between two Slack timestamps, oldest first, up to `limit` (workspace scripts page with next_oldest; D,
 *  scripts read months as "[ts] @user: text"). Thread replies only with `threads`. Channels only, like channelDayLines. */
export async function channelHistory(token: string, channel: string, oldest: string, latest: string, limit: number, threads: boolean):
  Promise<{ messages: { ts: string; user: string; text: string; thread_ts?: string; reply_count?: number; subtype?: string }[]; next_oldest: string | null }> {
  const info = await slackApi('conversations.info', { token, form: { channel } });
  const ch = info.channel as { is_im?: boolean; is_mpim?: boolean } | undefined;
  if (!info.ok || !ch || ch.is_im || ch.is_mpim) throw new Error(info.ok ? 'Direct and group messages are private: only channels can be read.' : `Slack said ${info.error}.`);
  const msgs: Msg[] = [];
  let cursor = '';
  // oldest first: Slack pages newest first, so read the whole window (at most 60 pages = 12,000 messages), sort, and hand back its start
  for (let page = 0; page < 60; page++) {
    const r = await slackApi('conversations.history', { token, form: { channel, oldest, latest, inclusive: 'false', limit: '200', ...(cursor ? { cursor } : {}) } });
    if (!r.ok) throw new Error(r.error === 'not_in_channel' ? 'The Slack bot is not in that channel: invite it there first.' : `Slack said ${r.error}.`);
    msgs.push(...((r.messages as Msg[]) ?? []));
    cursor = String((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '');
    if (!cursor) break;
  }
  if (cursor) throw new Error('Over 12,000 messages in that window: ask for a shorter one (until).');
  msgs.sort((x, y) => Number(x.ts) - Number(y.ts));
  const page = msgs.slice(0, limit), more = msgs.length > limit;
  const out: { ts: string; user: string; text: string; thread_ts?: string; reply_count?: number; subtype?: string }[] = [];
  for (const m of page) {
    out.push({ ts: m.ts, user: m.user || m.bot_id || 'bot', text: m.text ?? '', ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}), ...(m.reply_count ? { reply_count: m.reply_count } : {}), ...(m.subtype ? { subtype: m.subtype } : {}) });
    if (threads && (m.reply_count ?? 0) > 0) {
      const r = await slackApi('conversations.replies', { token, form: { channel, ts: m.ts, limit: '200' } });
      for (const x of ((r.messages as Msg[]) ?? []).slice(1)) out.push({ ts: x.ts, user: x.user || x.bot_id || 'bot', text: x.text ?? '', thread_ts: m.ts });
    }
  }
  return { messages: out, next_oldest: more && page.length ? page[page.length - 1].ts : null };
}

/** The channels the bot is a member of (public and private), with names. */
export async function botChannels(token: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const r = await slackApi('conversations.list', { token, form: { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', ...(cursor ? { cursor } : {}) } });
    if (!r.ok) throw new Error(`Slack did not list channels: ${r.error ?? 'no answer'}`);
    for (const c of (r.channels ?? []) as { id: string; name?: string; is_member?: boolean }[]) if (c.is_member) out.push({ id: c.id, name: c.name ?? c.id });
    cursor = String((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '');
    if (!cursor) break;
  }
  return out;
}

// Slack's member list, cached 10 minutes per agency (users.list, users:read + users:read.email)
export type SlackPerson = { id: string; name: string; real: string; display: string; title: string; email: string; /** their Slack picture (uploaded, or Slack's default) */ photo: string };
const peopleCache = new Map<string, { at: number; list: SlackPerson[] }>();
export async function slackPeople(token: string): Promise<SlackPerson[]> {
  const key = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16), hit = peopleCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.list;
  const list: SlackPerson[] = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const r = await slackApi('users.list', { token, form: { limit: '200', ...(cursor ? { cursor } : {}) } });
    if (!r.ok) throw new Error(`Slack did not list people: ${r.error ?? 'no answer'}`);
    for (const u of (r.members ?? []) as { id: string; name?: string; deleted?: boolean; is_bot?: boolean; profile?: Record<string, string> }[]) {
      if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
      const p = u.profile ?? {};
      list.push({ id: u.id, name: u.name ?? '', real: p.real_name ?? '', display: p.display_name ?? '', title: p.title ?? '', email: p.email ?? '',
        photo: String(p.image_192 ?? '') });
    }
    cursor = String((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '');
    if (!cursor) break;
  }
  peopleCache.set(key, { at: Date.now(), list });
  return list;
}
