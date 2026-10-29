import 'server-only';
import fs from 'fs';
import path from 'path';
import { getAgentDir, getAgentsForOrg, getOrgs } from '@/lib/config';
import { composioConnections, composioExecute } from '@/lib/connectors/composio';
import { botToken } from '@/lib/slack/app';
import { botChannels, postMessage } from '@/lib/slack/post';

// Where a routine's result goes besides its conversation (D, 2026-10-09). Telegram: the bot and chat already set up for a cortextOS
// agent in Settings › Telegram (its .env TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID; same keys the settings page reads). Slack: the Slack
// app linked in Settings › Connectors (Composio SLACK_SEND_MESSAGE). Nothing here holds or invents a credential.

function readEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(?:export\s+)?(\w+)=(.*)$/);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
function telegramOf(org: string, agent: string): { token: string; chat: string } | null {
  const env = readEnv(path.join(getAgentDir(agent, org), '.env'));
  const token = env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN || env.BOT_TOKEN || '';
  const chat = env.TELEGRAM_CHAT_ID || env.TG_CHAT_ID || env.CHAT_ID || '';
  return token && chat ? { token, chat } : null;
}

/** The Telegram bots a routine can send through ("org/agent"), only those with both a bot token and a chat id. */
export function telegramTargets(): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  try {
    for (const org of getOrgs()) for (const agent of getAgentsForOrg(org)) if (telegramOf(org, agent)) out.push({ id: `${org}/${agent}`, label: `${agent} bot (${org})` });
  } catch { /* no cortextOS on this box */ }
  return out;
}

/** True when the agency's AI Agents Slack bot is connected (Settings › Agency › Agency tools › Slack, docs/SLACK_APP.md). */
const appBot = (): boolean => { try { return !!botToken(); } catch { return false; } };

/** Channels the agency's Slack bot is in (the routine editor's picker; [] without the app). */
export async function slackChannels(): Promise<{ id: string; name: string }[]> {
  return appBot() ? botChannels().catch(() => []) : [];
}

/** True when Slack can take a routine's result: the agency's Slack bot, else a Slack account linked in Composio. */
export async function slackReady(): Promise<boolean> {
  if (appBot()) return true;
  const list = (await composioConnections()).slack ?? [];
  return list.some((c) => c.status === 'ACTIVE');
}

const plain = (s: string) => s.replace(/```(?:ctrl-[a-z]+)?\n?/g, '').trim();

export async function sendTelegram(target: string, text: string): Promise<{ ok: true } | { error: string }> {
  const [org, agent] = target.split('/');
  const t = org && agent ? telegramOf(org, agent) : null;
  if (!t) return { error: `No Telegram bot set up for ${target}.` };
  const body = plain(text);
  const r = await fetch(`https://api.telegram.org/bot${t.token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: t.chat, text: body.length > 4000 ? `${body.slice(0, 3990)}\n[cut]` : body, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(20_000),
  }).catch((e: Error) => e);
  if (r instanceof Error) return { error: `Telegram did not answer: ${r.message}` };
  return r.ok ? { ok: true } : { error: `Telegram said ${r.status}` };
}

export async function sendSlack(channel: string, text: string): Promise<{ ok: true } | { error: string }> {
  // the agency's own AI Agents bot first (D, 2026-10-10); Composio only when the app is not connected
  if (appBot()) { // charts and tables as images (lib/charts/slack-charts.ts); the rest as before
    const { slackWithCharts } = await import('@/lib/charts/slack-charts');
    const c = await slackWithCharts(text);
    const r = await postMessage(null, channel, c.blocks ? c : plain(text));
    return 'ok' in r ? { ok: true } : r;
  }
  if (!(await slackReady())) return { error: 'Slack is not connected (Settings › Connectors).' };
  const out = await composioExecute('SLACK_SEND_MESSAGE', { channel: channel.replace(/^#/, ''), markdown_text: plain(text).slice(0, 11_000) });
  return 'error' in out ? { error: out.error } : { ok: true };
}
