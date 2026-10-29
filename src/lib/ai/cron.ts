// Routine schedules (D, 2026-10-09: Routines, ported from lib/agents/routines.ts). A 5-field cron (minute hour day month
// weekday) read in one time zone (the agency's reporting zone, lib/tz.ts; the agency: America/New_York), with no package: Fleet has no cron dependency and this is small.
// DST safe: the next run is found on the local calendar (day by day, then the listed hours and minutes) and each local time is turned
// into one exact instant, so a fall-back hour never fires twice and a spring-forward time that does not exist runs an hour later.
// Pure and client-safe (the editor and the tests use it too).

import { agencyTz, tzAbbr } from '@/lib/tz';

/** @deprecated the zone is the agency's now (agencyTz()); kept for old imports. */
export { DEFAULT_TZ as ROUTINE_TZ } from '@/lib/tz';

export interface Cron { minute: number[]; hour: number[]; dom: number[]; month: number[]; dow: number[]; domAny: boolean; dowAny: boolean }

function field(raw: string, min: number, max: number, names?: string[]): number[] {
  const out = new Set<number>();
  for (const part of raw.toLowerCase().split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step "${part}"`);
    const num = (s: string) => {
      const i = names ? names.indexOf(s) : -1;
      const n = i >= 0 ? i + min : Number(s);
      if (!/^\d+$/.test(s) && i < 0) throw new Error(`Bad value "${s}"`);
      return n;
    };
    let lo: number, hi: number;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-'); lo = num(a); hi = num(b); }
    else { lo = num(range); hi = stepRaw === undefined ? lo : max; }
    if (lo < min || hi > max || lo > hi) throw new Error(`"${part}" is out of range (${min} to ${max})`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parses a 5-field cron; throws a plain reason. Weekday 7 = Sunday. */
export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Use a 5-part schedule: minute hour day month weekday, like "0 8 * * 1-5".');
  const [mi, h, d, mo, w] = parts;
  const dow = [...new Set(field(w, 0, 7, DAYS).map((x) => x % 7))].sort((a, b) => a - b);
  return { minute: field(mi, 0, 59), hour: field(h, 0, 23), dom: field(d, 1, 31), month: field(mo, 1, 12, MONTHS), dow, domAny: d === '*', dowAny: w === '*' };
}

/** The wall clock of an instant in a time zone. */
function wall(t: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute };
}

/** The instant a local wall time happens in a time zone (the earlier one in a repeated hour; a skipped time moves forward). */
export function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => { const w = wall(t, tz); return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - t; };
  // two passes settle the offset; for a repeated hour prefer the earlier (larger offset) answer
  const o1 = offsetAt(asUtc - 12 * 3600_000), o2 = offsetAt(asUtc + 12 * 3600_000);
  const cands = [asUtc - o1, asUtc - o2].filter((t) => { const w = wall(t, tz); return w.h === h && w.mi === mi && w.d === d; }).sort((a, b) => a - b);
  return cands[0] ?? asUtc - Math.min(o1, o2);
}

/** The next run strictly after `from` (ms), or null when there is none within ~4 years (e.g. Feb 30). */
export function nextRun(expr: string | Cron, from: number = Date.now(), tz = agencyTz()): number | null {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const start = wall(from, tz);
  const day = new Date(Date.UTC(start.y, start.mo - 1, start.d));
  for (let i = 0; i < 1500; i++, day.setUTCDate(day.getUTCDate() + 1)) {
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate(), wd = day.getUTCDay();
    if (!c.month.includes(mo)) continue;
    const domHit = c.dom.includes(d), dowHit = c.dow.includes(wd);
    // classic cron: when both day fields are limited, either one matches
    if (!(c.domAny && c.dowAny) && !(c.domAny ? dowHit : c.dowAny ? domHit : domHit || dowHit)) continue;
    for (const h of c.hour) for (const mi of c.minute) {
      const t = zonedInstant(y, mo, d, h, mi, tz);
      if (t > from) return t;
    }
  }
  return null;
}

/** Checks a schedule for the editor and the API: valid, and not more often than every 15 minutes. Returns a reason or null. */
/** minMinutes: 15 for agent routines (each run is an AI turn); script routines (no AI, D 2026-10-28) go down to 5. */
export function cronProblem(expr: string, minMinutes = 15): string | null {
  try {
    const first = nextRun(expr);
    if (first === null) return 'That schedule never runs.';
    const second = nextRun(expr, first);
    if (second !== null && second - first < minMinutes * 60_000) return `${minMinutes === 15 ? 'Routines' : 'Script routines'} can run at most every ${minMinutes} minutes.`;
    return null;
  } catch (e) { return e instanceof Error ? e.message : String(e); }
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const clock = (h: number, mi: number) => `${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** A Slack channel id in a routine's "only run if": a routine with no schedule runs on that channel's new posts (D, 2026-10-23: "reactive"). */
export const watchedChannel = (condition: string) => /\b[CG][A-Z0-9]{6,20}\b/.exec(condition)?.[0] ?? null;
// events a routine with no schedule can wait on as "when:<event>" (lib/ai/triggers.ts, D 2026-10-28)
export const ROUTINE_EVENTS = ['task_blocked', 'routine_failed'] as const;
const eventOf = (condition: string) => (ROUTINE_EVENTS as readonly string[]).find((e) => condition.trim() === `when:${e}`);
export const reactiveProblem = (condition: string) => (watchedChannel(condition) || eventOf(condition) ? null : `With no schedule, put the Slack channel id (C...) it watches in "Only run if", or when:<event> (${ROUTINE_EVENTS.join(', ')}).`);

/** A schedule in words: "Every day at 6:00 AM ET" (the zone's short label). Falls back to the cron itself. */
export function describeCron(expr: string, tz = agencyTz()): string {
  if (!expr.trim()) return 'On new posts'; // no schedule: runs only when a post lands in the channel its check names (lib/ai/routines.ts)
  let c: Cron;
  try { c = parseCron(expr); } catch { return expr; }
  const [mi, h, d, mo, w] = expr.trim().split(/\s+/);
  const allMonths = mo === '*';
  if (/^\d+$/.test(mi) && h === '*' && d === '*' && allMonths && w === '*') return mi === '0' ? 'Every hour' : `Every hour at :${mi.padStart(2, '0')}`;
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(h) || !allMonths) return `Custom: ${expr}`;
  const at = `at ${clock(c.hour[0], c.minute[0])} ${tzAbbr(tz)}`;
  if (d === '*' && w === '*') return `Every day ${at}`;
  if (d === '*' && w === '1-5') return `Weekdays ${at}`;
  if (d === '*' && /^[0-7](,[0-7])*$/.test(w)) return `Every ${c.dow.map((x) => DAY_NAMES[x]).join(', ')} ${at}`;
  if (/^\d+$/.test(d) && w === '*') return `Monthly on the ${ord(c.dom[0])} ${at}`;
  return `Custom: ${expr}`;
}
