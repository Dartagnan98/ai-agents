import 'server-only';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { runTurn } from '@/lib/ai/turn';
import { getNumber, secrets, bridgeCall, type WaNumber } from './numbers';

// A WhatsApp message to an agent's number (D, 2026-10-28), after the bridge's own gate (the admin numbers and the listed groups). Here:
// only an admin wakes the agent (a group message from anyone else is ignored), our own messages, reactions and empty ones are dropped,
// each message runs once, and one chat's turns run one after another (they share a conversation). The turn runs like Telegram's
// (lib/ai/turn.ts runTurn) as the login that added the number, with that login's access, and the reply goes back to the same chat.

const ready = schemaOnce();
function ensure() { if (ready.done()) return; db.exec('CREATE TABLE IF NOT EXISTS ai_wa_threads (convo_key TEXT PRIMARY KEY, thread_id INTEGER NOT NULL)'); ready.mark(); }

export function hookTokenOk(key: string, got: string | null): boolean {
  const want = secrets(key)?.hook ?? '';
  if (want.length < 24 || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const seen = new Set<string>();
const chains = new Map<string, Promise<unknown>>();
export interface Inbound { eventType?: string; sender?: string; content?: string; chatJID?: string; isFromMe?: boolean; messageId?: string; quotedContent?: string }

/** The admin who sent it, or null (pure): the sender's number, without device suffix, on the number's admin list. */
export function adminOf(n: Pick<WaNumber, 'admins'>, sender: string): string | null {
  const num = sender.split('@')[0].split(':')[0];
  return num in n.admins ? n.admins[num] : null;
}

/** Takes one forwarded message; runs the agent in the background (the bridge gets its 200 at once). `run` keeps the agency context. */
export function handleInbound(key: string, p: Inbound, run: <T>(fn: () => T) => T) {
  const n = getNumber(key);
  if (!n || n.mode === 'off' || p.isFromMe || p.eventType === 'reaction') return;
  const content = (p.content ?? '').trim();
  if (!content || !adminOf(n, p.sender ?? '')) return;
  if (p.messageId) { const id = `${key}:${p.messageId}`; if (seen.has(id)) return; seen.add(id); if (seen.size > 5000) seen.clear(); }
  const ck = `${key}:${p.chatJID || p.sender || ''}`;
  const next = (chains.get(ck) ?? Promise.resolve()).then(() => run(() => turn(n, p, content))).catch((e) => console.warn(`[wa] ${key}: ${e instanceof Error ? e.message : String(e)}`));
  chains.set(ck, next);
  void next.finally(() => { if (chains.get(ck) === next) chains.delete(ck); });
}

/** Markdown to WhatsApp's own marks (pure): **bold** -> *bold*, headings and code fences dropped. */
export function toWhatsApp(md: string): string {
  return md.replace(/```[a-z]*\n?/gi, '').replace(/^#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/`([^`]+)`/g, '$1').trim();
}

async function turn(n: WaNumber, p: Inbound, content: string) {
  ensure();
  const sender = p.sender ?? '', chat = p.chatJID ?? '', isGroup = chat.endsWith('@g.us');
  const target = isGroup ? chat : (sender.includes('@') ? sender : `${sender}@s.whatsapp.net`);
  const who = adminOf(n, sender) ?? 'an admin';
  const convoKey = `${n.key}:${target}`;
  const threadId = (db.prepare('SELECT thread_id FROM ai_wa_threads WHERE convo_key = ?').get(convoKey) as { thread_id: number } | undefined)?.thread_id ?? null;
  const quoted = p.quotedContent ? `\n\n(it replies to: "${p.quotedContent.slice(0, 500)}")` : '';
  const text = `[WhatsApp from ${who}${isGroup ? ' in a group chat' : ''}. Answer like a text message: short and plain, no tables.]\n\n${content}${quoted}`;
  const r = await runTurn({ userId: n.created_by, threadId, agentId: n.agent_id, text, channel: 'WhatsApp', title: `WhatsApp (${n.label}): ${who.split(',')[0]}`.slice(0, 120) });
  if (r.threadId) db.prepare('INSERT OR REPLACE INTO ai_wa_threads (convo_key, thread_id) VALUES (?, ?)').run(convoKey, r.threadId);
  const reply = toWhatsApp(r.reply || (r.error ? `(stopped: ${r.error})` : ''));
  if (!reply) return;
  for (let i = 0; i < reply.length; i += 3500) {
    const s = await bridgeCall(n.key, 'send', { recipient: target, message: reply.slice(i, i + 3500), ...(i === 0 && p.messageId && isGroup ? { quoted_message_id: p.messageId } : {}) });
    if (s.success === false) { console.warn(`[wa] ${n.key}: reply not sent: ${s.message ?? 'the bridge refused'}`); return; }
  }
}
