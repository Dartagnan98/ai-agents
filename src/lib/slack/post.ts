import { asAgency, botToken, slackApi, type SlackFetch } from './app';

// Posting as the agency's AI Agents Slack bot (D, 2026-10-10): routines, approved the agents posts, DM replies. `agencyId` null = the agency
// this code already runs as. Each call reads that agency's own token (never another's) and returns { ok } or { error } without throwing.

export type SlackContent = string | { text?: string; blocks?: unknown[]; username?: string };
type Out = { ok: true; ts?: string; channel?: string } | { error: string };

const tokenOf = (agencyId: string | null) => (agencyId ? asAgency(agencyId, botToken) : botToken());
const NOT_CONNECTED = 'Slack is not connected for this agency (Settings › Agency › Agency tools › Slack).';
const why = (e?: string) => (e === 'not_in_channel' ? 'the Slack bot is not in that channel (invite it with /invite @ and its name)'
  : e === 'channel_not_found' ? 'Slack cannot find that channel' : e ?? 'no answer');

/** chat.postMessage. Text is cut under Slack's 40,000 limit; blocks go as given (text stays as the notification fallback). */
export async function postMessage(agencyId: string | null, channel: string, content: SlackContent, threadTs?: string | null, f: SlackFetch = fetch): Promise<Out> {
  const token = tokenOf(agencyId);
  if (!token) return { error: NOT_CONNECTED };
  const c = typeof content === 'string' ? { text: content } : content;
  const body: Record<string, unknown> = { channel: channel.replace(/^#/, ''), text: (c.text ?? '').slice(0, 39_000), unfurl_links: false };
  if (c.blocks?.length) body.blocks = c.blocks;
  if (c.username) body.username = c.username.slice(0, 80); // chat:write.customize: who the post is from
  if (threadTs) body.thread_ts = threadTs;
  const r = await slackApi('chat.postMessage', { token, json: body }, f);
  return r.ok ? { ok: true, ts: String(r.ts ?? ''), channel: String(r.channel ?? '') } : { error: `Slack did not post: ${why(r.error)}` };
}

/** reactions.add (emoji name without colons, e.g. white_check_mark). Already reacted counts as done. */
export async function react(agencyId: string | null, channel: string, ts: string, emoji: string, f: SlackFetch = fetch): Promise<Out> {
  const token = tokenOf(agencyId);
  if (!token) return { error: NOT_CONNECTED };
  const r = await slackApi('reactions.add', { token, json: { channel, timestamp: ts, name: emoji.replace(/^:|:$/g, '') } }, f);
  return r.ok || r.error === 'already_reacted' ? { ok: true } : { error: `Slack did not react: ${why(r.error)}` };
}

/** A direct message: opens (or reuses) the DM with that Slack user, then posts. */
export async function dm(agencyId: string | null, slackUserId: string, content: SlackContent, f: SlackFetch = fetch): Promise<Out> {
  const token = tokenOf(agencyId);
  if (!token) return { error: NOT_CONNECTED };
  const o = await slackApi('conversations.open', { token, json: { users: slackUserId } }, f);
  const ch = (o.channel as { id?: string } | undefined)?.id;
  if (!o.ok || !ch) return { error: `Slack did not open the DM: ${why(o.error)}` };
  return postMessage(agencyId, ch, content, null, f);
}

/** Channels the bot is in (public and private), for the routine delivery picker. [] when not connected. */
export async function botChannels(agencyId: string | null = null, f: SlackFetch = fetch): Promise<{ id: string; name: string }[]> {
  const token = tokenOf(agencyId);
  if (!token) return [];
  const out: { id: string; name: string }[] = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const r = await slackApi('conversations.list', { token, form: { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', ...(cursor ? { cursor } : {}) } }, f);
    if (!r.ok) break;
    for (const c of (r.channels ?? []) as { id?: string; name?: string; is_member?: boolean }[]) if (c.id && c.is_member) out.push({ id: c.id, name: c.name ?? c.id });
    cursor = String((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? '');
    if (!cursor) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
