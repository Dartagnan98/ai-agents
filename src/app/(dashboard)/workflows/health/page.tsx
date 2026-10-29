import { HealthBoard } from '@/components/operations/health-board';
import { healthView } from '@/lib/operations/views';

export const dynamic = 'force-dynamic';

// Fleet health (D, 2026-10-10: every agency gets Operations): the agency's agents, routines, approvals waiting and AI connections. The
// cortextOS daemon's cron health left with the daemon (D, 2026-10-28).
export default function FleetHealthPage() {
  return <HealthBoard data={healthView()} />;
}
