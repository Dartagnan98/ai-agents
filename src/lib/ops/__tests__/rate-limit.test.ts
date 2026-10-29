import { beforeEach, describe, expect, it, vi } from 'vitest';

// Rate limits (P5, D 2026-10-09): token bucket in memory and in SQLite.
vi.mock('../context', async () => {
  const { default: Database } = await import('better-sqlite3');
  const mem = new Database(':memory:');
  return { opsDb: () => mem, currentTenantId: () => 'default' };
});

const R = await import('../rate-limit');

describe('token bucket', () => {
  beforeEach(() => R._resetRateLimitsForTests());
  const p = { capacity: 3, perMinute: 6 }; // one token every 10 s

  it('allows a burst up to capacity, then refuses with Retry-After', () => {
    const t = 1_000_000;
    expect(R.takeToken('k', p, t).allowed).toBe(true);
    expect(R.takeToken('k', p, t).allowed).toBe(true);
    const third = R.takeToken('k', p, t);
    expect(third).toMatchObject({ allowed: true, remaining: 0 });
    const fourth = R.takeToken('k', p, t);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBe(10);
  });

  it('refills over time and never above capacity', () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) R.takeToken('k', p, t);
    expect(R.takeToken('k', p, t + 9_000).allowed).toBe(false);
    expect(R.takeToken('k', p, t + 10_000).allowed).toBe(true);
    // an hour idle: full again, but only 3
    const later = t + 3_600_000;
    expect([1, 2, 3, 4].map(() => R.takeToken('k', p, later).allowed)).toEqual([true, true, true, false]);
  });

  it('keys are independent', () => {
    for (let i = 0; i < 3; i++) R.takeToken('a', p, 0);
    expect(R.takeToken('a', p, 0).allowed).toBe(false);
    expect(R.takeToken('b', p, 0).allowed).toBe(true);
  });

  it('the shared (SQLite) bucket behaves the same and survives a fresh copy', () => {
    const t = 5_000_000;
    for (let i = 0; i < 3; i++) expect(R.takeTokenShared('s', p, t).allowed).toBe(true);
    R._resetRateLimitsForTests(); // memory gone, table stays
    expect(R.takeTokenShared('s', p, t + 1000).allowed).toBe(false);
    expect(R.takeTokenShared('s', p, t + 10_000).allowed).toBe(true);
  });

  it('builds keys and 429s, and only trusts x-forwarded-for behind a proxy', async () => {
    const h = new Headers({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1', 'x-real-ip': '9.9.9.9' });
    expect(R.clientIp(h, false)).toBe('9.9.9.9');
    expect(R.clientIp(h, true)).toBe('1.2.3.4');
    expect(R.rateKey({ route: 'ai-chat', ip: '1.2.3.4', user: 7 })).toBe('ai-chat|ip:1.2.3.4|u:7');
    const res = R.tooManyRequests({ allowed: false, remaining: 0, retryAfterSec: 12 });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('12');
    expect((await res.json()).retryAfterSec).toBe(12);
  });

  it('limitRequest returns null until the bucket is empty', () => {
    const req = new Request('http://x/api/ai/chat', { headers: { 'x-real-ip': '5.5.5.5' } });
    const one = { capacity: 1, perMinute: 1 };
    expect(R.limitRequest(req, 'r', one, 1)).toBeNull();
    expect(R.limitRequest(req, 'r', one, 1)?.status).toBe(429);
  });
});
