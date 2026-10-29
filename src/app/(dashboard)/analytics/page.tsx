import { RANGES, UsageBoard } from '@/components/operations/usage-board';
import { usageView } from '@/lib/operations/views';
import { reportTz } from '@/lib/report-tz';
import { todayIn } from '@/lib/sales-range';
import { zoneMidnight } from '@/lib/tz';

export const dynamic = 'force-dynamic';

// Analytics (D, 2026-10-10: every agency gets Operations): the agency's the agents use (messages, routine runs, by agent and model) and the
// plan's AI allowance. The cortextOS daemon's analytics left with the daemon (D, 2026-10-28).
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ view?: string; days?: string; org?: string }> }) {
  const sp = await searchParams;
  // default This month, like every board (D, 2026-10-14); 7 / 30 / 90 days stay one click away
  const picked = RANGES.find((d) => String(d) === sp.days);
  const tz = reportTz(), today = todayIn(tz);
  const from = picked ? undefined : Date.parse(zoneMidnight(`${today.slice(0, 8)}01`, tz));
  const days = picked ?? Number(today.slice(8, 10));
  return <UsageBoard data={usageView(days, Date.now(), from)} meter={null} />;
}
