// Date ranges for the sales module (the agency, 2026-10-01). Pure, so server pages and tests share it.
// Every date is a calendar day in the agency's reporting zone (the agency: Eastern) whatever zone the viewer is in.
import { agencyTz } from './tz';
export const SALES_PRESETS = [
  // plain words, not mono capitals (D, 2026-10-28 redesign: Today / 7 days / This month / Last month)
  { key: '1d', label: 'Today' },
  { key: 'yd', label: 'Yesterday' },
  { key: '3d', label: '3 days' },
  { key: '7d', label: '7 days' },
  { key: 'lw', label: 'Last week' },
  { key: 'tm', label: 'This month' },
  { key: 'lm', label: 'Last month' },
  { key: '90d', label: '90 days' },
  // longer ranges so the rebuilt history before the agency's boards is one click away (D, 2026-10-02: "where is the back fill")
  { key: '6m', label: '6 months' },
  { key: 'ytd', label: 'This year' },
  { key: '1y', label: '12 months' },
] as const;
export const COMPARE_MODES = [
  { key: 'prev', label: 'Previous period' },
  { key: 'month', label: 'Same period last month' },
  { key: 'year', label: 'Same period last year' },
  { key: 'off', label: 'Off' },
] as const;
export type CompareMode = (typeof COMPARE_MODES)[number]['key'];

/** Inclusive ET day range. */
export interface SalesRange { from: string; to: string; key: string; label: string; days: number }
export interface SalesWindow { cur: SalesRange; prev: SalesRange | null; compare: CompareMode }

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
export const addDays = (iso: string, n: number) => new Date(at(iso) + n * DAY).toISOString().slice(0, 10);
const span = (from: string, to: string) => Math.round((at(to) - at(from)) / DAY) + 1;
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const addMonths = (iso: string, n: number) => {
  const d = new Date(at(iso)); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};
const fmt = (iso: string) => new Date(at(iso)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toUpperCase();
export const rangeText = (r: SalesRange) => (r.from === r.to ? fmt(r.from) : `${fmt(r.from)} – ${fmt(r.to)}`);

/** Today (YYYY-MM-DD) in a given timezone. */
export const todayIn = (tz: string, now = new Date()): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** Today in the reporting timezone of the current agency (Settings › the agency › Basics, read per call on the server through
 *  lib/report-tz.ts; in the browser the zone the root layout's brand carries, lib/tz.ts). */
export function todayET(now = new Date()): string {
  return todayIn(agencyTz(), now);
}

function preset(key: string, today: string): SalesRange {
  const mk = (from: string, to: string, label: string): SalesRange => ({ from, to, key, label, days: span(from, to) });
  switch (key) {
    case '1d': return mk(today, today, 'Today');
    case 'yd': { const y = addDays(today, -1); return mk(y, y, 'Yesterday'); }
    case '3d': return mk(addDays(today, -2), today, 'Last 3 days');
    case 'lw': {
      // Last full Monday-to-Sunday week.
      const dow = (new Date(at(today)).getUTCDay() + 6) % 7; // Mon = 0
      const mon = addDays(today, -dow - 7);
      return mk(mon, addDays(mon, 6), 'Last week');
    }
    case 'tm': return mk(monthStart(today), today, 'This month');
    case 'lm': { const s = addMonths(monthStart(today), -1); return mk(s, addDays(monthStart(today), -1), 'Last month'); }
    case '90d': return mk(addDays(today, -89), today, 'Last 90 days');
    case '6m': return mk(addDays(addMonths(today, -6), 1), today, 'Last 6 months');
    case 'ytd': return mk(`${today.slice(0, 4)}-01-01`, today, 'This year');
    case '1y': return mk(addDays(addMonths(today, -12), 1), today, 'Last 12 months');
    default: return { ...mk(addDays(today, -6), today, 'Last 7 days'), key: '7d' };
  }
}

function previous(cur: SalesRange, mode: CompareMode): SalesRange | null {
  if (mode === 'off') return null;
  if (mode === 'month' || mode === 'year') {
    const n = mode === 'month' ? -1 : -12;
    const from = addMonths(cur.from, n), to = addMonths(cur.to, n);
    return { from, to, key: mode, label: mode === 'month' ? 'Same period last month' : 'Same period last year', days: span(from, to) };
  }
  // Previous period: whole months compare with the same number of whole months before them (Jan-Aug with May-Dec, 2026-10-02:
  // it used to compare any run of whole months with one month only, so Jan-Aug read up 907%); anything else with the same number
  // of days immediately before.
  if (cur.key === 'lm' || (cur.from === monthStart(cur.from) && addDays(cur.to, 1) === monthStart(addDays(cur.to, 1)))) {
    const end = addDays(cur.to, 1), m = (Number(end.slice(0, 4)) - Number(cur.from.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(cur.from.slice(5, 7));
    const from = addMonths(cur.from, -m), to = addDays(cur.from, -1);
    return { from, to, key: 'prev', label: m === 1 ? 'Previous month' : `Previous ${m} months`, days: span(from, to) };
  }
  const to = addDays(cur.from, -1), from = addDays(to, -(cur.days - 1));
  return { from, to, key: 'prev', label: 'Previous period', days: cur.days };
}

type Params = { [k: string]: string | string[] | undefined };
const one = (p: Params, k: string) => { const v = p[k]; return Array.isArray(v) ? v[0] : v; };

/** ?range=lw&cmp=prev, or ?from=YYYY-MM-DD&to=YYYY-MM-DD. Default: this month vs the month before. */
export function resolveSalesWindow(params: Params, today = todayET()): SalesWindow {
  const cmpRaw = one(params, 'cmp');
  const compare = (COMPARE_MODES.some((m) => m.key === cmpRaw) ? cmpRaw : 'prev') as CompareMode;
  const from = one(params, 'from'), to = one(params, 'to');
  let cur: SalesRange;
  if (from && ISO.test(from)) {
    const t = to && ISO.test(to) ? to : today;
    const [f, e] = from <= t ? [from, t] : [t, from];
    cur = { from: f, to: e, key: 'custom', label: 'Custom', days: span(f, e) };
  } else {
    cur = preset(one(params, 'range') ?? 'tm', today); // default this month, every board and portal (D, 2026-10-14; was 7D, before that last week)
  }
  return { cur, prev: previous(cur, compare), compare };
}

/** Every ET day in a range, for chart axes. */
export function daysOf(r: SalesRange): string[] {
  return Array.from({ length: r.days }, (_, i) => addDays(r.from, i));
}
