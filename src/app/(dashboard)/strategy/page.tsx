import { StrategyBoard } from '@/components/operations/strategy-board';

export const dynamic = 'force-dynamic';

// Strategy (D, 2026-10-10: every agency gets Operations): north star, bottleneck, daily focus and goals in the agency's own database. The
// cortextOS org goals.json view left with the daemon (D, 2026-10-28).
export default function StrategyPage() {
  return <StrategyBoard />;
}
