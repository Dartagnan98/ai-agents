import { ExperimentsBoard } from '@/components/operations/experiments-board';

export const dynamic = 'force-dynamic';

// Experiments (D, 2026-10-10: every agency gets its own): a log of the agency's tests in its own database. The cortextOS agents'
// experiment cycles left with the daemon (D, 2026-10-28).
export default function ExperimentsPage() {
  return <ExperimentsBoard />;
}
