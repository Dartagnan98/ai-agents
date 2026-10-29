import 'server-only';
import { db } from '@/lib/db';

// Daily AI usage report (D, 2026-10-13): the old usage monitor read the Claude plan's limits, which the long-lived login the AI uses
// cannot see (scope user:profile). This reads what the AI itself recorded per answer (ai_turns, Operations › Analytics) instead:
// yesterday's tokens and API-price cost by routine and by agent, against the 7 days before, flagging anything over 2x its usual.
// No AI call. Days are the report time zone's.

interface Turn { day: string; who: string; cost: number; out: number }
const money = (n: number) => `$${n.toFixed(2)}`;

export function usageReport(tz: string, now = new Date()): string {
  const since = new Date(now.getTime() - 9 * 86_400_000).toISOString();
  const rows = db.prepare(`
    select t.created_at at, coalesce(t.cost_usd, 0) cost, coalesce(t.output_tokens, 0) out,
           coalesce('Routine: ' || r.name, 'Chat: ' || a.name, 'Chat: an agent') who
      from ai_turns t
      left join ai_routine_runs rr on rr.thread_id = t.thread_id
      left join ai_routines r on r.id = rr.routine_id
      left join ai_agents a on a.id = t.agent_id
     where t.created_at >= ?`).all(since) as { at: string; cost: number; out: number; who: string }[];
  const dayOf = (iso: string) => new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleDateString('en-CA', { timeZone: tz });
  const turns: Turn[] = rows.map((x) => ({ day: dayOf(x.at), who: x.who, cost: x.cost, out: x.out }));
  const today = now.toLocaleDateString('en-CA', { timeZone: tz });
  const days = [...new Set(turns.map((t) => t.day))].filter((d) => d < today).sort();
  const y = days[days.length - 1];
  if (!y) return '*AI usage*\nNo AI use recorded in the last week.';
  const before = days.filter((d) => d < y).slice(-7);
  const sum = (ts: Turn[]) => ts.reduce((a, t) => a + t.cost, 0);
  const yT = turns.filter((t) => t.day === y), total = sum(yT), avg = before.length ? sum(turns.filter((t) => before.includes(t.day))) / before.length : 0;
  const by = new Map<string, { cost: number; n: number }>();
  for (const t of yT) { const e = by.get(t.who) ?? { cost: 0, n: 0 }; e.cost += t.cost; e.n += 1; by.set(t.who, e); }
  const usual = (who: string) => before.length ? sum(turns.filter((t) => t.who === who && before.includes(t.day))) / before.length : 0;
  const lines = [...by.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 8).map(([who, v]) => {
    const u = usual(who), hot = v.cost >= 1 && u > 0 && v.cost > 2 * u;
    return `• ${who}: ${money(v.cost)}, ${v.n} answer${v.n === 1 ? '' : 's'}${hot ? ` ⚠ ${(v.cost / u).toFixed(1)}x usual (${money(u)}/day)` : u === 0 && v.cost >= 1 ? ' (new)' : ''}`;
  });
  const flag = avg > 0 && total > 2 * avg ? ` ⚠ ${(total / avg).toFixed(1)}x the daily average (${money(avg)})` : avg > 0 ? ` (daily average ${money(avg)})` : '';
  return [`*AI usage · ${y}*`, `Total ${money(total)} at API prices, ${yT.reduce((a, t) => a + t.out, 0).toLocaleString('en-US')} output tokens${flag}.`,
    'Runs on the Claude plan login, so this is plan usage, not a bill.', '', ...lines].join('\n');
}
