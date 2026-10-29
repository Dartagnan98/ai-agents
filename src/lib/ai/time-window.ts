// "As of" questions for team memory (D, 2026-10-23): the time a question asks about, as an inclusive day range (YYYY-MM-DD), or null when
// it names none. Plain rules, no model: "as of / on / before / since / after <date>", "yesterday", "last / this week|month|year",
// "in <Month>", "<Month> <day>", ISO dates, "N days|weeks ago". Weeks start on Monday. A month or day without a year is the most recent
// one not after today.
export interface TimeWindow { from: string; to: string; label: string }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d));
const add = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const monthOf = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3)));
const FAR_PAST = '2000-01-01';

/** The day a phrase names ("Oct 14", "October 14 2026", "2026-10-14", "10/14"), or null. */
function dayOf(s: string, today: Date): Date | null {
  let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return at(+m[1], +m[2] - 1, +m[3]);
  m = new RegExp(`${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i').exec(s);
  if (m) {
    const mo = monthOf(m[1]), y = m[3] ? +m[3] : today.getUTCFullYear();
    const d = at(y, mo, +m[2]);
    return !m[3] && d > today ? at(y - 1, mo, +m[2]) : d;
  }
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getUTCFullYear();
    const d = at(y, +m[1] - 1, +m[2]);
    return !m[3] && d > today ? at(y - 1, +m[1] - 1, +m[2]) : d;
  }
  return null;
}

export function timeWindow(text: string, todayIso: string): TimeWindow | null {
  const t = text.toLowerCase(), today = new Date(`${todayIso}T00:00:00Z`);
  const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
  // as of / on / before / since / after <date>
  let m = /\b(as of|as at|on|before|until|by|since|after|from)\s+(.{3,40})/.exec(t);
  if (m) {
    const d = dayOf(m[2], today);
    if (d) {
      const k = m[1];
      if (k === 'as of' || k === 'as at' || k === 'before' || k === 'until' || k === 'by') return { from: FAR_PAST, to: iso(k === 'before' ? add(d, -1) : d), label: `${k} ${iso(d)}` };
      if (k === 'since' || k === 'after' || k === 'from') return { from: iso(k === 'after' ? add(d, 1) : d), to: todayIso, label: `${k} ${iso(d)}` };
      return { from: iso(d), to: iso(d), label: `on ${iso(d)}` };
    }
  }
  if (/\byesterday\b/.test(t)) { const d = iso(add(today, -1)); return { from: d, to: d, label: 'yesterday' }; }
  m = /\b(\d{1,2})\s+(day|week)s?\s+ago\b/.exec(t);
  if (m) { const d = iso(add(today, -(+m[1]) * (m[2] === 'week' ? 7 : 1))); return { from: FAR_PAST, to: d, label: `as of ${d}` }; }
  if (/\blast week\b/.test(t)) { const start = add(today, -dow - 7); return { from: iso(start), to: iso(add(start, 6)), label: 'last week' }; }
  if (/\bthis week\b/.test(t)) return { from: iso(add(today, -dow)), to: todayIso, label: 'this week' };
  if (/\blast month\b/.test(t)) {
    const y = today.getUTCFullYear(), mo = today.getUTCMonth();
    return { from: iso(at(y, mo - 1, 1)), to: iso(at(y, mo, 0)), label: 'last month' };
  }
  if (/\bthis month\b/.test(t)) return { from: iso(at(today.getUTCFullYear(), today.getUTCMonth(), 1)), to: todayIso, label: 'this month' };
  if (/\blast year\b/.test(t)) { const y = today.getUTCFullYear() - 1; return { from: `${y}-01-01`, to: `${y}-12-31`, label: 'last year' }; }
  // "in September" (and "in Sept 2026"); a bare date ("on Oct 14" handled above): "Oct 14" alone is that day
  m = new RegExp(`\\b(?:in|during|for)\\s+${MON}\\b(?:\\s+(\\d{4}))?`, 'i').exec(t);
  if (m) {
    const mo = monthOf(m[1]); let y = m[2] ? +m[2] : today.getUTCFullYear();
    if (!m[2] && at(y, mo, 1) > today) y -= 1;
    return { from: iso(at(y, mo, 1)), to: iso(at(y, mo + 1, 0)), label: `${MONTHS[mo]} ${y}` };
  }
  const d = dayOf(t, today);
  if (d) return { from: iso(d), to: iso(d), label: iso(d) };
  return null;
}

/** True when two inclusive day ranges overlap ('' = open end). */
export const overlaps = (aFrom: string, aTo: string, w: TimeWindow) => (aFrom || FAR_PAST) <= w.to && (aTo || '9999-12-31') >= w.from;
