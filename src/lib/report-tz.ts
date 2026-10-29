import { DEFAULT_TZ } from '@/lib/tz';

// The app's time zone: APP_TZ in .env.local, else this computer's own zone. Days in reports, routines and the day/night rules count in it.
const ok = (tz: string) => { try { return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) && !!new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return false; } };
const ZONE = [process.env.APP_TZ, Intl.DateTimeFormat().resolvedOptions().timeZone].find((z): z is string => !!z && ok(z)) ?? DEFAULT_TZ;

export function reportTz(): string { return ZONE; }
// todayET (lib/sales-range.ts, shared with the browser) asks this on the server for the zone
(globalThis as { __fleetReportTzFn?: () => string }).__fleetReportTzFn = reportTz;

export function reportCurrency(): string { return 'USD'; }
(globalThis as { __fleetCurrencyFn?: () => string }).__fleetCurrencyFn = reportCurrency; // lib/currency.ts money() on the server

export { tzName } from '@/lib/tz';
