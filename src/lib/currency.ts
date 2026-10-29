// The agency's money currency where code runs (HARDCODE_AUDIT B4, D 2026-10-10). Client-safe, like lib/tz.ts: the server resolver is
// installed by lib/report-tz.ts (Settings › Agency profile currency, else the contract defaults, else USD); the browser's by the brand
// (components/brand.tsx). the agency is USD, so its money reads exactly as before ($1,234).
type CurGlobal = { __fleetCurrencyFn?: () => string };
const CODE = /^[A-Z]{3}$/;

/** The currency the agency counts: cash, fees and commissions are sums of payments in it; other currencies are listed apart. */
export function agencyCurrency(): string {
  try { const c = (globalThis as CurGlobal).__fleetCurrencyFn?.(); return c && CODE.test(c) ? c : 'USD'; } catch { return 'USD'; }
}

/** Browser only: the currency the root layout's brand carries. */
export function setBrowserCurrency(cur: string): void {
  if (typeof window !== 'undefined' && CODE.test(cur)) (globalThis as CurGlobal).__fleetCurrencyFn = () => cur;
}

/** Whole amounts in a currency: $1,234 / −$1,234 for USD (as always), CA$1,234, €1,234, £1,234 for others. */
export function money(v: number, cur: string = agencyCurrency(), digits = 0): string {
  const abs = Math.abs(v), sign = v < 0 ? '−' : '';
  if (cur === 'USD' && digits === 0) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
  try { return sign + abs.toLocaleString('en-US', { style: 'currency', currency: cur, minimumFractionDigits: digits, maximumFractionDigits: digits }); }
  catch { return `${sign}${cur} ${abs.toFixed(digits)}`; }
}

/** SQL text for a currency column's fallback: only a 3-letter code can come back, so it is safe inside the query. */
export const sqlCurrency = (cur: string = agencyCurrency()): string => `'${CODE.test(cur) ? cur : 'USD'}'`;
