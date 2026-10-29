export const dynamic = 'force-dynamic';

import { DocsLibrary } from '@/components/knowledge/docs-library';

const PURPOSE = 'The team\'s notes: decisions, how-tos, meeting notes. the agents can search them. Only this agency sees them.';

// Wiki (D, 2026-10-10: every agency gets its own Intelligence): the agency's own notes (lib/knowledge/docs.ts, space 'wiki'). The
// cortextOS org vault view left with the daemon (D, 2026-10-28); the vault is in.
export default function WikiPage() {
  return <DocsLibrary space="wiki" title="Wiki" purpose={PURPOSE} />;
}
