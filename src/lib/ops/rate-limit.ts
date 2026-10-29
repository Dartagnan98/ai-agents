// Rate limits (P5, D 2026-10-09): a token bucket keyed by whatever the caller joins (ip, user, route).
//   takeToken(key, policy)        in memory, one app copy (fast; resets on restart)
//   takeTokenShared(key, policy)  SQLite ops_rate_limits, shared by every copy on the box
// A bucket holds `capacity` tokens and refills `perMinute` tokens a minute; each request takes one.
// Sign-in already has its own limiter (lib/rate-limit.ts, 5 tries / 15 min per IP); /api/v1 and /support have theirs.
import { opsDb } from './context';

export type RatePolicy = { capacity: number; perMinute: number };
export type RateResult = { allowed: boolean; remaining: number; retryAfterSec: number };

/** Suggested policies; apply with takeToken(rateKey(...), POLICIES.x). */
export const POLICIES = {
  signIn: { capacity: 5, perMinute: 1 / 3 },     // 5 tries, then one every 3 minutes
  aiChat: { capacity: 20, perMinute: 6 },        // bursts of 20 messages, 6 a minute sustained
  publicApi: { capacity: 60, perMinute: 60 },
  emailSend: { capacity: 5, perMinute: 1 },      // password reset, invites, verify (P3)
  signUp: { capacity: 3, perMinute: 1 / 20 },    // P3 public sign-up per IP: 3, then one every 20 minutes
} satisfies Record<string, RatePolicy>;

type Bucket = { tokens: number; at: number };
const buckets = new Map<string, Bucket>();
const MAX_KEYS = 20_000;

/** Pure step of the bucket: refill since `b.at`, then try to take one. Exported for tests. */
export function stepBucket(b: Bucket | undefined, p: RatePolicy, now: number): { bucket: Bucket; result: RateResult } {
  const perMs = p.perMinute / 60_000;
  const tokens = b ? Math.min(p.capacity, b.tokens + (now - b.at) * perMs) : p.capacity;
  if (tokens >= 1) {
    const left = tokens - 1;
    return { bucket: { tokens: left, at: now }, result: { allowed: true, remaining: Math.floor(left), retryAfterSec: 0 } };
  }
  const waitMs = perMs > 0 ? (1 - tokens) / perMs : 3_600_000;
  return { bucket: { tokens, at: now }, result: { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) } };
}

export function takeToken(key: string, p: RatePolicy, now = Date.now()): RateResult {
  const { bucket, result } = stepBucket(buckets.get(key), p, now);
  buckets.set(key, bucket);
  if (buckets.size > MAX_KEYS) {
    // drop the oldest quarter (Map keeps insertion order); a dropped key just starts full again
    let n = Math.floor(MAX_KEYS / 4);
    for (const k of buckets.keys()) { if (n-- <= 0) break; buckets.delete(k); }
  }
  return result;
}

let sharedReady = false;
export function takeTokenShared(key: string, p: RatePolicy, now = Date.now()): RateResult {
  try {
    const d = opsDb();
    if (!sharedReady) {
      d.exec('CREATE TABLE IF NOT EXISTS ops_rate_limits (key TEXT PRIMARY KEY, tokens REAL NOT NULL, at INTEGER NOT NULL)');
      sharedReady = true;
    }
    return d.transaction(() => {
      const row = d.prepare('SELECT tokens, at FROM ops_rate_limits WHERE key = ?').get(key) as Bucket | undefined;
      const { bucket, result } = stepBucket(row, p, now);
      d.prepare('INSERT INTO ops_rate_limits (key, tokens, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, at = excluded.at')
        .run(key, bucket.tokens, bucket.at);
      // keep the table small: rows idle for a day are full buckets again anyway
      if (Math.random() < 0.01) d.prepare('DELETE FROM ops_rate_limits WHERE at < ?').run(now - 86_400_000);
      return result;
    }).immediate();
  } catch {
    // SQLite unavailable: fall back to this copy's memory rather than letting everything through
    return takeToken(key, p, now);
  }
}

/** The caller's IP. x-forwarded-for only when TRUST_PROXY=true (same rule as lib/auth.ts). */
export function clientIp(headers: Headers, trustProxy = process.env.TRUST_PROXY === 'true'): string {
  if (trustProxy) { const f = headers.get('x-forwarded-for')?.split(',')[0]?.trim(); if (f) return f; }
  return headers.get('x-real-ip') ?? headers.get('cf-connecting-ip') ?? '0.0.0.0';
}

export function rateKey(parts: { route: string; ip?: string; user?: string | number | null }): string {
  return [parts.route, parts.ip ? `ip:${parts.ip}` : '', parts.user != null ? `u:${parts.user}` : ''].filter(Boolean).join('|');
}

/** A 429 with Retry-After, for route handlers. */
export function tooManyRequests(r: RateResult): Response {
  return new Response(JSON.stringify({ error: 'Too many requests', retryAfterSec: r.retryAfterSec }), {
    status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(r.retryAfterSec) },
  });
}

/** One-liner for a route: `const limited = limitRequest(req, 'ai-chat', POLICIES.aiChat, userId); if (limited) return limited;` */
export function limitRequest(req: Request, route: string, p: RatePolicy, user?: string | number | null, shared = false): Response | null {
  const key = rateKey({ route, ip: clientIp(req.headers), user });
  const r = shared ? takeTokenShared(key, p) : takeToken(key, p);
  return r.allowed ? null : tooManyRequests(r);
}

/** Tests only. */
export function _resetRateLimitsForTests() { buckets.clear(); sharedReady = false; }
