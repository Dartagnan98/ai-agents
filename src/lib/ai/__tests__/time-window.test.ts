import { describe, expect, it } from 'vitest';
import { overlaps, timeWindow } from '../time-window';

// "As of" questions (D, 2026-10-23). Today = Thursday 2026-10-23.
const T = '2026-10-23';
const w = (q: string) => { const x = timeWindow(q, T); return x ? [x.from, x.to] : null; };

describe('timeWindow', () => {
  it('as of / before / since / on a date', () => {
    expect(w('what was the refund rule as of Oct 10?')).toEqual(['2000-01-01', '2026-10-10']);
    expect(w('rules before October 14')).toEqual(['2000-01-01', '2026-10-13']);
    expect(w('what changed since 2026-10-14')).toEqual(['2026-10-14', T]);
    expect(w('what did we decide on 10/21')).toEqual(['2026-10-21', '2026-10-21']);
  });
  it('relative periods', () => {
    expect(w('what happened yesterday')).toEqual(['2026-10-22', '2026-10-22']);
    expect(w('who led setters last week')).toEqual(['2026-10-12', '2026-10-18']); // Mon-Sun before this week
    expect(w('this week so far')).toEqual(['2026-10-19', T]);
    expect(w('cash last month')).toEqual(['2026-09-01', '2026-09-30']);
    expect(w('as it was 2 weeks ago')).toEqual(['2000-01-01', '2026-10-09']);
  });
  it('months and bare dates; a month later in the year means last year', () => {
    expect(w('what did we decide in September')).toEqual(['2026-09-01', '2026-09-30']);
    expect(w('in December')).toEqual(['2025-12-01', '2025-12-31']);
    expect(w('Oct 14 leaderboard')).toEqual(['2026-10-14', '2026-10-14']);
  });
  it('no time named: null (words like "on" alone do not count)', () => {
    expect(w('who counts as one of our reps?')).toBeNull();
    expect(w('what do we do about DELTA')).toBeNull();
    expect(w('is Alex on the call today')).toBeNull();
  });
  it('overlaps', () => {
    const win = timeWindow('as of Oct 10', T)!;
    expect(overlaps('2026-10-01', '2026-10-14', win)).toBe(true);
    expect(overlaps('2026-10-14', '', win)).toBe(false);
    expect(overlaps('', '2026-10-05', win)).toBe(true);
  });
});
