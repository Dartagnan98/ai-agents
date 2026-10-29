import { DocsLibrary } from '@/components/knowledge/docs-library';

export const dynamic = 'force-dynamic';

const PURPOSE = 'What your team and the agents should know: offers, scripts, SOPs, answers to common questions. Only this agency sees it.';

// Knowledge (D, 2026-10-10: every agency gets its own Intelligence). Each agency's documents live in its own database
// (lib/knowledge/docs.ts). The cortextOS "Agent index" view left with the daemon (D, 2026-10-28); its notes are in the folder "Legacy agents".
export default function KnowledgeBasePage() {
  return <DocsLibrary space="knowledge" title="Knowledge" purpose={PURPOSE} />;
}
