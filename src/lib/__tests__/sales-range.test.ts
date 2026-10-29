import { describe, expect, it } from 'vitest';
import { resolveSalesWindow, todayET } from '../sales-range';

const T = '2026-10-01'; // a Thursday
describe('resolveSalesWindow', () => {
  it('defaults to this month (D, 2026-10-14), and last week is still one click', () => {
    expect(resolveSalesWindow({}, T)).toEqual(resolveSalesWindow({ range: 'tm' }, T));
    expect(resolveSalesWindow({}, T).cur.key).toBe('tm');
    const w = resolveSalesWindow({ range: 'lw' }, T);
    expect([w.cur.from, w.cur.to, w.prev?.from, w.prev?.to]).toEqual(['2026-09-21', '2026-09-27', '2026-09-14', '2026-09-20']);
  });
  it('last month compares with the whole month before', () => {
    const w = resolveSalesWindow({ range: 'lm' }, T);
    expect([w.cur.from, w.cur.to, w.prev?.from, w.prev?.to]).toEqual(['2026-09-01', '2026-09-30', '2026-08-01', '2026-08-31']);
  });
  it('this month vs same period last month / last year', () => {
    expect(resolveSalesWindow({ range: 'tm', cmp: 'month' }, '2026-03-31').prev).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
    expect(resolveSalesWindow({ range: '7d', cmp: 'year' }, T).prev).toMatchObject({ from: '2025-09-25', to: '2025-10-01' });
  });
  it('custom range, reversed dates, and compare off', () => {
    const w = resolveSalesWindow({ from: '2026-09-10', to: '2026-09-01', cmp: 'off' }, T);
    expect([w.cur.from, w.cur.to, w.cur.days, w.prev]).toEqual(['2026-09-01', '2026-09-10', 10, null]);
    expect(resolveSalesWindow({ range: '3d' }, T).prev).toMatchObject({ from: '2026-09-26', to: '2026-09-28' });
  });
  it('whole months compare with as many whole months before', () => {
    expect(resolveSalesWindow({ from: '2026-01-01', to: '2026-08-31' }, '2026-10-02').prev).toMatchObject({ from: '2025-05-01', to: '2025-12-31', label: 'Previous 8 months' });
    expect(resolveSalesWindow({ from: '2026-03-01', to: '2026-03-31' }, '2026-10-02').prev).toMatchObject({ from: '2026-02-01', to: '2026-02-28', label: 'Previous month' });
  });
  it('long presets', () => {
    expect(resolveSalesWindow({ range: 'ytd' }, '2026-10-02').cur).toMatchObject({ from: '2026-01-01', to: '2026-10-02' });
    expect(resolveSalesWindow({ range: '1y' }, '2026-10-02').cur).toMatchObject({ from: '2025-10-03', to: '2026-10-02' });
    expect(resolveSalesWindow({ range: '6m' }, '2026-10-02').cur).toMatchObject({ from: '2026-04-03', to: '2026-10-02' });
  });
  it('yesterday vs the day before', () => {
    const w = resolveSalesWindow({ range: 'yd' }, T);
    expect([w.cur.from, w.cur.to, w.prev?.from, w.prev?.to]).toEqual(['2026-09-30', '2026-09-30', '2026-09-29', '2026-09-29']);
  });
  it('today is the ET date', () => {
    expect(todayET(new Date('2026-10-02T03:00:00Z'))).toBe('2026-10-01');
  });
});
