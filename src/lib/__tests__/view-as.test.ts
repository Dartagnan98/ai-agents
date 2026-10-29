// View as (D, 2026-10-28): the cookie only opens what it was signed for: right agency, not expired, not edited.
import { describe, expect, it, vi } from 'vitest';

const ctx = { agency: 'agc_A' };
vi.mock('@/lib/platform/context', () => ({ requestCookie: () => undefined, tenantKey: () => ctx.agency }));
const { readViewAs, signViewAs, VIEW_AS_TTL_MS } = await import('@/lib/view-as');

describe('view as cookie', () => {
  const now = 1_800_000_000_000;
  it('reads back what was signed', () => {
    expect(readViewAs(signViewAs(52, 1, 'usr_abc', now), now + 1000)).toEqual({ target: 52, real: 1, principal: 'usr_abc', exp: now + VIEW_AS_TTL_MS });
  });
  it('an edited target, an expired cookie and another agency open nothing', () => {
    const c = signViewAs(52, 1, 'usr_abc', now);
    expect(readViewAs(c.replace(/^52\./, '53.'), now)).toBeNull();
    expect(readViewAs(c, now + VIEW_AS_TTL_MS + 1)).toBeNull();
    ctx.agency = 'agc_B';
    expect(readViewAs(c, now)).toBeNull();
    ctx.agency = 'agc_A';
    expect(readViewAs('garbage', now)).toBeNull();
    expect(readViewAs(undefined, now)).toBeNull();
  });
});
