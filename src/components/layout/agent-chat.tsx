'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { IconSparkles, IconArrowsDiagonal, IconX, IconLayoutColumns, IconArrowUpRight } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import dynamic from 'next/dynamic';

// the chat itself loads the first time the corner button opens it (2026-10-21); split view's docked pane loads it at once
const Conversation = dynamic(() => import('@/components/ai/conversation').then((m) => m.Conversation), { ssr: false });

// the agents in the corner (D, 2026-10-09): agent chat look over Fleet's own AI back end (app/api/ai/chat). Owner and admins
// only: the route refuses everyone else and the button never shows. `docked` = the split screen's AI pane. The conversation itself is
// components/ai/conversation.tsx, the same one the AI page uses; this adds the corner button and the corner's own tools.
// One check per page load, shared by the corner chat and the phone tab bar's round Ask button.
let aiCheck: Promise<boolean> | null = null;
export function useAiAllowed() {
  const { data: session } = useSession();
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    if (!session) return;
    aiCheck ??= fetch('/api/ai/chat').then((r) => r.ok).catch(() => false);
    aiCheck.then(setAllowed);
  }, [session]);
  return allowed;
}

export function AgentChat({ docked = false }: { docked?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const allowed = useAiAllowed();
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const [wide, setWide] = useState(false);
  const [thread, setThread] = useState<number | null>(null);

  // the AI page is the chat itself: no corner button there
  if (!allowed || (!docked && pathname === '/ai')) return null;
  const beside = () => { const here = window.location.pathname + window.location.search; router.push(`/split?p=${encodeURIComponent(here)}&p=ai`); };
  const full = () => router.push(thread ? `/ai?thread=${thread}` : '/ai');
  const tools: [typeof IconX, string, () => void][] = docked ? [] : [[IconArrowUpRight, 'Open on the AI page', full], [IconLayoutColumns, 'Open beside this page', beside],
    [IconArrowsDiagonal, 'Bigger', () => setWide(!wide)], [IconX, 'Close', () => setOpen(false)]];
  const toolbar = tools.map(([Ico, l, f]) => <button key={l} type="button" onClick={f} aria-label={l} title={l} className="grid size-[30px] place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-foreground"><Ico size={16} stroke={1.8} /></button>);
  return (
    <>
      {/* phones: the round Ask button lives beside the floating tab bar (bottom-nav.tsx) */}
      {!docked && <button type="button" onClick={() => { setUsed(true); setOpen(!open); }} aria-label="Ask the AI"
        className="fixed bottom-[22px] right-[22px] z-40 hidden size-[52px] place-items-center rounded-2xl bg-[var(--ai)] text-white shadow-[0_12px_30px_-8px_rgba(14,20,34,0.5)] transition-transform hover:-translate-y-0.5 md:grid">
        <IconSparkles size={22} stroke={1.8} />
      </button>}
      {/* stays mounted while closed, so a reply keeps streaming and the conversation is there when it opens again */}
      {(used || docked) && <div hidden={!open && !docked} className={docked ? 'flex h-full w-full flex-col overflow-hidden bg-card' : cn('fixed bottom-[86px] right-[22px] z-40 flex flex-col overflow-hidden rounded-[18px] bg-card shadow-[0_30px_70px_-20px_rgba(14,20,34,0.45),0_0_0_1px_rgba(14,20,34,0.08)]',
        wide ? 'h-[calc(100dvh-110px)] w-[min(760px,calc(100vw-340px))]' : 'h-[min(640px,calc(100dvh-120px))] w-[420px]')}>
        <Conversation variant={docked ? 'docked' : 'corner'} thread={thread} onThread={setThread} toolbar={toolbar} />
      </div>}
    </>
  );
}
