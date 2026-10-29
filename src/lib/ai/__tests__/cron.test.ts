import { describe, expect, it } from 'vitest';
import { cronProblem, describeCron, nextRun, parseCron, zonedInstant } from '../cron';

// Routine schedules (D, 2026-10-09): 5-field cron read in Eastern Time, safe across daylight saving changes.
const et = (t: number | null) => (t === null ? null : new Date(t).toLocaleString('sv-SE', { timeZone: 'America/New_York' }).slice(0, 16));
const utc = (s: string) => Date.parse(s);

describe('cron parsing', () => {
  it('reads lists, ranges, steps, names and Sunday as 0 or 7', () => {
    const c = parseCron('*/15 9-17 1,15 jan-mar mon-fri');
    expect(c.minute).toEqual([0, 15, 30, 45]);
    expect(c.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(c.dom).toEqual([1, 15]);
    expect(c.month).toEqual([1, 2, 3]);
    expect(c.dow).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron('0 8 * * 7').dow).toEqual([0]);
    expect(parseCron('0 8 * * 5-7').dow).toEqual([0, 5, 6]);
  });
  it('refuses bad schedules with a plain reason', () => {
    expect(() => parseCron('0 8 * *')).toThrow(/5-part/);
    expect(() => parseCron('61 8 * * *')).toThrow(/out of range/);
    expect(cronProblem('* * * * *')).toMatch(/15 minutes/);
    expect(cronProblem('0 6 * * *')).toBeNull();
    expect(cronProblem('0 0 30 2 *')).toMatch(/never/);
  });
});

describe('next run in Eastern Time', () => {
  it('daily at 6:00 ET, from before and after the time', () => {
    expect(et(nextRun('0 6 * * *', utc('2026-10-09T09:00:00Z')))).toBe('2026-10-09 06:00'); // 5:00 EDT
    expect(et(nextRun('0 6 * * *', utc('2026-10-09T10:00:00Z')))).toBe('2026-10-10 06:00'); // exactly 6:00 = strictly after
    expect(nextRun('0 6 * * *', utc('2026-10-09T09:00:00Z'))).toBe(utc('2026-10-09T10:00:00Z')); // EDT = UTC-4
    expect(nextRun('0 6 * * *', utc('2026-12-09T09:00:00Z'))).toBe(utc('2026-12-09T11:00:00Z')); // EST = UTC-5
  });
  it('weekdays and Sundays', () => {
    expect(et(nextRun('0 8 * * 1-5', utc('2026-10-10T12:00:00Z')))).toBe('2026-10-12 08:00'); // Saturday -> Monday
    expect(et(nextRun('0 8 * * 0', utc('2026-10-09T12:00:00Z')))).toBe('2026-10-11 08:00');
  });
  it('day of month OR weekday when both are set (classic cron)', () => {
    expect(et(nextRun('0 9 1 * 1', utc('2026-10-27T12:00:00Z')))).toBe('2026-11-01 09:00'); // the 1st (a Sunday) before Monday 2nd
  });
  it('spring forward: 6:00 keeps its wall time; a 2:30 that does not exist runs at 3:30', () => {
    // 2027-03-14 clocks go 2:00 EST -> 3:00 EDT
    expect(et(nextRun('0 6 * * *', utc('2027-03-13T12:00:00Z')))).toBe('2027-03-14 06:00');
    expect(nextRun('0 6 * * *', utc('2027-03-13T12:00:00Z'))).toBe(utc('2027-03-14T10:00:00Z'));
    expect(et(nextRun('30 2 * * *', utc('2027-03-14T05:00:00Z')))).toBe('2027-03-14 03:30');
  });
  it('fall back: 1:30 happens twice but fires once', () => {
    // 2026-11-01 clocks go 2:00 EDT -> 1:00 EST
    const first = nextRun('30 1 * * *', utc('2026-11-01T04:00:00Z'))!;
    expect(first).toBe(utc('2026-11-01T05:30:00Z')); // 1:30 EDT
    expect(et(nextRun('30 1 * * *', first))).toBe('2026-11-02 01:30'); // not 1:30 EST the same night
    expect(zonedInstant(2026, 11, 1, 1, 30, 'America/New_York')).toBe(first);
  });
  it('hourly over the fall-back hour: each wall time once (1:00 EST is a repeat of 1:00, so 2:00 EST is next)', () => {
    expect(nextRun('0 * * * *', utc('2026-11-01T05:10:00Z'))).toBe(utc('2026-11-01T07:00:00Z'));
    expect(et(nextRun('0 2 * * *', utc('2026-11-01T04:00:00Z')))).toBe('2026-11-01 02:00');
  });
});

describe('schedule in words', () => {
  it('reads the presets', () => {
    expect(describeCron('0 6 * * *')).toBe('Every day at 6:00 AM ET');
    expect(describeCron('30 7 * * *')).toBe('Every day at 7:30 AM ET');
    expect(describeCron('0 18 * * *')).toBe('Every day at 6:00 PM ET');
    expect(describeCron('0 8 * * 1-5')).toBe('Weekdays at 8:00 AM ET');
    expect(describeCron('0 8 * * 0')).toBe('Every Sunday at 8:00 AM ET');
    expect(describeCron('0 9 1 * *')).toBe('Monthly on the 1st at 9:00 AM ET');
    expect(describeCron('0 * * * *')).toBe('Every hour');
    expect(describeCron('0 9 * 1 *')).toBe('Custom: 0 9 * 1 *');
  });
});
