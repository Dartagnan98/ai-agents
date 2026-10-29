import { redirect } from 'next/navigation';
import { aiChatUser } from '@/lib/ai/access';
import { AiShell } from '@/components/ai/ai-shell';

export const dynamic = 'force-dynamic';

// The AI section (D, 2026-10-09, Agents area): /ai, /ai/agents, /ai/skills, /ai/memory. The chat (/ai) for the owner, admins,
// managers and clients (D, 2026-10-13; what each one's AI reads: lib/ai/tools.ts); the other pages check owner or admin themselves.
export default async function AiLayout({ children }: { children: React.ReactNode }) {
  const me = await aiChatUser();
  if (!me) redirect('/');
  return <AiShell full={me.tier === 'full'}>{children}</AiShell>;
}
