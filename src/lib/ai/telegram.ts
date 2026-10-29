import 'server-only';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { seal, unseal } from '@/lib/secret-crypto';
import { listAgents } from './store';
import { runTurn } from './turn';
import { getGrant } from '@/lib/user-access';

// the agents on Telegram (D, 2026-10-09: replaces the cortextOS Telegram bots). The agency's own bot (from @BotFather), set up in
// Settings › AI connections. Each person links their Telegram once with a code from the app (/link CODE), then each Telegram chat
// is one continuous the agents conversation as that login, with their access and agents. /new starts over, /agent <name> switches.
let ready = false;
function ensure() {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_telegram_bot (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, secret TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', webhook TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS ai_telegram_links (chat_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, thread_id INTEGER, agent_id INTEGER, linked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE IF NOT EXISTS ai_telegram_codes (code TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);`);
  ready = true;
}
type Bot = { token: string; secret: string; username: string; webhook: string };
function bot(): Bot | null {
  ensure();
  const r = db.prepare('SELECT * FROM ai_telegram_bot WHERE id = 1').get() as Bot | undefined;
  if (!r) return null;
  try { return { ...r, token: unseal(r.token) }; } catch { return null; }
}
const api = async (token: string, method: string, body: Record<string, unknown>) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return res.json().catch(() => ({ ok: false })) as Promise<{ ok: boolean; result?: Record<string, unknown>; description?: string }>;
};

export function telegramStatus(): { connected: boolean; username: string; webhook: string } {
  const b = bot();
  return { connected: !!b, username: b?.username ?? '', webhook: b?.webhook ?? '' };
}
/** Saves the bot after checking it with Telegram, and points its webhook at this app (needs a public APP_URL). */
export async function connectTelegram(token: string, agencyPath: string): Promise<{ ok: boolean; error?: string; note?: string }> {
  const t = token.trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t)) return { ok: false, error: 'Paste the token @BotFather gave you (numbers:letters).' };
  const me = await api(t, 'getMe', {}).catch(() => null);
  if (!me?.ok) return { ok: false, error: 'Telegram did not accept that token.' };
  const secret = crypto.randomBytes(24).toString('hex');
  const base = (process.env.APP_URL || process.env.AUTH_URL || '').replace(/\/$/, '');
  let webhook = '', note = '';
  if (/^https:\/\//.test(base)) {
    webhook = `${base}/api/ai/telegram/${agencyPath}/${secret}`;
    const w = await api(t, 'setWebhook', { url: webhook, secret_token: secret, allowed_updates: ['message'] }).catch(() => null);
    if (!w?.ok) return { ok: false, error: `Telegram would not set the webhook: ${w?.description ?? 'no answer'}` };
  } else note = 'Saved. Set APP_URL to this app\'s public https address so Telegram can reach it, then connect again.';
  ensure();
  db.prepare('INSERT INTO ai_telegram_bot (id, token, secret, username, webhook) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token, secret = excluded.secret, username = excluded.username, webhook = excluded.webhook')
    .run(seal(t), secret, String(me.result?.username ?? ''), webhook);
  return { ok: true, note };
}
export async function disconnectTelegram() {
  const b = bot();
  if (b) await api(b.token, 'deleteWebhook', {}).catch(() => null);
  ensure(); db.prepare('DELETE FROM ai_telegram_bot').run();
}
/** A one-time code (10 minutes) the person sends to the bot as "/link CODE". */
export function linkCode(userId: number): string {
  ensure();
  db.prepare('DELETE FROM ai_telegram_codes WHERE expires < ?').run(Date.now());
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare('INSERT INTO ai_telegram_codes (code, user_id, expires) VALUES (?, ?, ?)').run(code, userId, Date.now() + 10 * 60_000);
  return code;
}
/** Uses up a link code (Telegram's "/link CODE" or Slack's "link CODE"): the login it was made for, or null when wrong or expired. */
export function takeLinkCode(code: string): number | null {
  ensure();
  const c = code.trim().toUpperCase();
  const r = db.prepare('SELECT user_id FROM ai_telegram_codes WHERE code = ? AND expires > ?').get(c, Date.now()) as { user_id: number } | undefined;
  if (r) db.prepare('DELETE FROM ai_telegram_codes WHERE code = ?').run(c);
  return r?.user_id ?? null;
}
export function linkedChats(userId: number): number { ensure(); return (db.prepare('SELECT COUNT(*) AS n FROM ai_telegram_links WHERE user_id = ?').get(userId) as { n: number }).n; }
export function unlinkChats(userId: number) { ensure(); db.prepare('DELETE FROM ai_telegram_links WHERE user_id = ?').run(userId); }

/** Telegram's reply: plain text, rich blocks flattened, split under Telegram's 4096 limit. */
function plain(text: string): string[] {
  const flat = text.replace(/```ctrl-[a-z]+\s*\n?[\s\S]*?```/g, '(see the chart or table in the app)').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
  const out: string[] = [];
  for (let i = 0; i < flat.length; i += 3900) out.push(flat.slice(i, i + 3900));
  return out.length ? out : ['(no answer)'];
}

/** One incoming Telegram update (webhook). Checks the secret first; answers only linked chats. */
export async function handleUpdate(secret: string, headerSecret: string | null, update: Record<string, unknown>): Promise<boolean> {
  const b = bot();
  if (!b || !headerSecret || secret.length !== b.secret.length || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(b.secret)) || headerSecret !== b.secret) return false;
  const msg = update.message as { chat?: { id?: number; type?: string }; text?: string; from?: { first_name?: string } } | undefined;
  const chat = msg?.chat?.id, text = (msg?.text ?? '').trim();
  if (!chat || !text || msg?.chat?.type !== 'private') return true; // private chats only: never answer in groups
  const say = async (t: string) => { for (const part of plain(t)) await api(b.token, 'sendMessage', { chat_id: chat, text: part }).catch(() => null); };
  ensure();
  const link = db.prepare('SELECT * FROM ai_telegram_links WHERE chat_id = ?').get(String(chat)) as { user_id: number; thread_id: number | null; agent_id: number | null } | undefined;
  const m = /^\/link\s+([A-Z0-9]{6,12})$/i.exec(text);
  if (m) {
    const c = db.prepare('SELECT * FROM ai_telegram_codes WHERE code = ? AND expires > ?').get(m[1].toUpperCase(), Date.now()) as { user_id: number } | undefined;
    if (!c) { await say('That code is wrong or expired. Get a new one in the app (Settings › AI connections › Telegram).'); return true; }
    db.prepare('DELETE FROM ai_telegram_codes WHERE code = ?').run(m[1].toUpperCase());
    db.prepare('INSERT INTO ai_telegram_links (chat_id, user_id) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET user_id = excluded.user_id, thread_id = NULL').run(String(chat), c.user_id);
    await say('Linked. Ask me anything about your agency. /new starts a fresh conversation, /agent <name> switches agent.');
    return true;
  }
  if (!link) { await say('This chat is not linked yet. In the app open Settings › AI connections › Telegram, get a code, and send /link CODE here.'); return true; }
  if (text === '/new' || text === '/start') { db.prepare('UPDATE ai_telegram_links SET thread_id = NULL WHERE chat_id = ?').run(String(chat)); await say('New conversation. What should we work on?'); return true; }
  const a = /^\/agent\s+(.+)$/i.exec(text);
  if (a) {
    const pick = listAgents(link.user_id).find((x) => x.name.toLowerCase().startsWith(a[1].trim().toLowerCase()));
    if (!pick) { await say(`No agent called "${a[1].trim()}". You have: ${listAgents(link.user_id).map((x) => x.name).join(', ')}.`); return true; }
    db.prepare('UPDATE ai_telegram_links SET agent_id = ?, thread_id = NULL WHERE chat_id = ?').run(pick.id, String(chat));
    await say(`Now talking to ${pick.name}.`);
    return true;
  }
  void api(b.token, 'sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => null);
  const r = await runTurn({ userId: link.user_id, threadId: link.thread_id, agentId: link.agent_id, text, channel: 'Telegram', title: `Telegram: ${text.slice(0, 60)}` });
  db.prepare('UPDATE ai_telegram_links SET thread_id = ? WHERE chat_id = ?').run(r.threadId || null, String(chat));
  await say(r.reply);
  return true;
}

/** A note to every owner who linked Telegram (weekly tests, spend alerts). True when at least one got it. Never throws. */
export async function tellOwners(text: string): Promise<boolean> {
  try {
    const b = bot();
    if (!b) return false;
    ensure();
    const chats = (db.prepare('SELECT chat_id, user_id FROM ai_telegram_links').all() as { chat_id: string; user_id: number }[]).filter((c) => getGrant(c.user_id).role === 'owner');
    for (const c of chats) for (const part of plain(text)) await api(b.token, 'sendMessage', { chat_id: c.chat_id, text: part, disable_web_page_preview: true }).catch(() => null);
    return chats.length > 0;
  } catch { return false; }
}

