// The agency's time zone where code runs (HARDCODE_AUDIT B1/B2/B19b, D 2026-10-10). Client-safe: no fs. On the server the resolver is
// lib/report-tz.ts (the current agency's Basics zone, read per call); in the browser it is the brand handed down by the root layout
// (components/brand.tsx installs it). Before either exists: DEFAULT_TZ, the agency's zone, so the agency reads exactly as before.
export const DEFAULT_TZ = 'America/New_York';

type TzGlobal = { __fleetReportTzFn?: () => string };

/** The current agency's reporting zone (Settings › the agency › Basics). */
export function agencyTz(): string {
  try { return (globalThis as TzGlobal).__fleetReportTzFn?.() || DEFAULT_TZ; } catch { return DEFAULT_TZ; }
}

/** Browser only: the zone the root layout's brand carries. The server keeps lib/report-tz.ts's resolver. */
export function setBrowserTz(tz: string): void {
  if (typeof window !== 'undefined' && tz) (globalThis as TzGlobal).__fleetReportTzFn = () => tz;
}

/** A short label for a zone: ET, PT, CT; GMT+1 style where there is no short everyday name. */
export function tzAbbr(tz: string = agencyTz()): string {
  const part = (style: 'shortGeneric' | 'short') => {
    try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: style }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? ''; } catch { return ''; }
  };
  const g = part('shortGeneric');
  return g && g.length <= 4 ? g : part('short') || tz;
}

/** A zone's everyday name for prompts and labels: Eastern Time for America/New_York, Pacific Time for America/Vancouver. */
export function tzName(tz: string = agencyTz()): string {
  try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? tz; } catch { return tz; }
}

/** Fills a static text's zone placeholders (lib/metrics/metrics.md): {{TZ}} = tzName (Eastern Time), {{TZA}} = tzAbbr (ET). */
export function fillTz(text: string, tz: string = agencyTz()): string {
  return text.replaceAll('{{TZ}}', tzName(tz)).replaceAll('{{TZA}}', tzAbbr(tz));
}

/** The UTC instant (ISO, seconds) of local midnight starting `day` in `tz`: guess UTC midnight, then correct by the zone's offset there. */
export function zoneMidnight(day: string, tz: string): string {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);
  return new Date(guess - (local - guess)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
