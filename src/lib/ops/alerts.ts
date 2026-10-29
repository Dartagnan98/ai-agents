// Error alerts (P5, D 2026-10-09): alert(kind, message, extra) tells D on Telegram and/or email, at most once per kind+message
// every 30 minutes. The de-dup is in memory (fast path) and in SQLite ops_alerts (so the three app copies agree). Never throws.
import { opsDb, currentTenantId } from './context';
import { sendEmail } from '@/lib/email';

export const ALERT_WINDOW_MS = 30 * 60_000;
const recent = new Map<string, number>();
let tableReady = false;

export type AlertResult = { sent: boolean; deduped: boolean; channels: string[]; errors: string[] };

function ensureTable() {
  if (tableReady) return;
  opsDb().exec(`CREATE TABLE IF NOT EXISTS ops_alerts (
    key TEXT PRIMARY KEY, kind TEXT NOT NULL, message TEXT NOT NULL, tenant TEXT NOT NULL DEFAULT 'default',
    first_at INTEGER NOT NULL, last_sent_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1, extra TEXT)`);
  tableReady = true;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** True when this kind+message may be sent now; records the attempt either way. Exported for tests. */
export function claimAlert(kind: string, message: string, extra?: string, now = Date.now()): boolean {
  const key = `${kind}\n${message}`;
  const mem = recent.get(key);
  if (mem !== undefined && now - mem < ALERT_WINDOW_MS) {
    try { ensureTable(); opsDb().prepare('UPDATE ops_alerts SET count = count + 1, last_seen_at = ? WHERE key = ?').run(now, key); } catch { /* memory is enough */ }
    return false;
  }
  try {
    ensureTable();
    const d = opsDb();
    const ok = d.transaction(() => {
      const row = d.prepare('SELECT last_sent_at FROM ops_alerts WHERE key = ?').get(key) as { last_sent_at: number } | undefined;
      if (row && now - row.last_sent_at < ALERT_WINDOW_MS) {
        d.prepare('UPDATE ops_alerts SET count = count + 1, last_seen_at = ? WHERE key = ?').run(now, key);
        return false;
      }
      d.prepare(`INSERT INTO ops_alerts (key, kind, message, tenant, first_at, last_sent_at, last_seen_at, count, extra) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET last_sent_at = excluded.last_sent_at, last_seen_at = excluded.last_seen_at, count = count + 1, extra = excluded.extra`)
        .run(key, kind, message, currentTenantId(), now, now, now, extra ?? null);
      return true;
    }).immediate();
    if (ok) recent.set(key, now);
    else recent.set(key, mem ?? now); // another copy sent it: stay quiet here too
    return ok;
  } catch {
    // SQLite down: fall back to memory only (an alert about the database must still go out)
    recent.set(key, now);
    return true;
  }
}

export function alertChannels(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  if (env.OPS_TELEGRAM_BOT_TOKEN && env.OPS_TELEGRAM_CHAT_ID) out.push('telegram');
  if (env.OPS_ALERT_EMAIL) out.push('email');
  return out;
}

export async function alert(kind: string, message: string, extra?: Record<string, unknown>): Promise<AlertResult> {
  const msg = clip(String(message ?? ''), 500);
  let extraText: string | undefined;
  try { extraText = extra ? clip(JSON.stringify(extra), 1500) : undefined; } catch { extraText = undefined; }
  const res: AlertResult = { sent: false, deduped: false, channels: [], errors: [] };
  if (!claimAlert(kind, msg, extraText)) { res.deduped = true; return res; }

  const host = process.env.APP_NAME || process.env.NEXTAUTH_URL || 'AI Agents';
  const text = `[${host}] ${kind}: ${msg}${extraText ? `\n${extraText}` : ''}`;
  const channels = alertChannels();
  if (!channels.length) { console.warn(`[alert] ${text}`); return res; }

  await Promise.all(channels.map(async (ch) => {
    try {
      if (ch === 'telegram') {
        const r = await fetch(`https://api.telegram.org/bot${process.env.OPS_TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: process.env.OPS_TELEGRAM_CHAT_ID, text: clip(text, 4000), disable_web_page_preview: true }),
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error(`telegram ${r.status}`);
      } else {
        const r = await sendEmail({ to: (process.env.OPS_ALERT_EMAIL as string).split(',').map((s) => s.trim()).filter(Boolean), subject: clip(`[ops] ${kind}: ${msg}`, 150), text });
        if (!r.sent) throw new Error(r.error || `email not sent (${r.provider})`);
      }
      res.channels.push(ch);
    } catch (e) {
      res.errors.push(`${ch}: ${String((e as Error)?.message ?? e)}`);
    }
  }));
  res.sent = res.channels.length > 0;
  if (res.errors.length) console.warn(`[alert] delivery problems: ${res.errors.join('; ')} | ${text}`);
  return res;
}

/** Tests only: forget the in-memory de-dup and the table flag. */
export function _resetAlertsForTests() { recent.clear(); tableReady = false; }
