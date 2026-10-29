'use client';

import { useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Conversation } from './conversation';
import { ThreadMenu } from './thread-menu';

// The AI page (D, 2026-10-09, AgentsView): the conversation full height, the agent picker and the conversation's title and
// menu in its header. ?thread= opens one; a new conversation gets its id in the address on the first reply.
export function AiHome() {
  const sp = useSearchParams();
  const router = useRouter();
  const thread = Number(sp.get('thread')) || null;
  const agent = Number(sp.get('agent')) || null;
  const onThread = useCallback((id: number | null) => {
    const want = id ? `/ai?thread=${id}` : '/ai';
    if (`${window.location.pathname}${window.location.search}` !== want) router.replace(want, { scroll: false });
  }, [router]);
  return (
    <div className="h-full">
      <Conversation variant="page" thread={thread} agent={agent} onThread={onThread}
        title={(c) => c.id ? <>
          <span className="mx-1 text-label">/</span>
          <span className="min-w-0 truncate text-[15px] text-muted-foreground md:text-[13.5px]">{c.title || 'Untitled'}</span>
          <ThreadMenu thread={{ id: c.id, title: c.title }} onRenamed={c.renamed} onGone={() => router.replace('/ai')} />
        </> : <span className="ml-1 text-[15px] text-muted-foreground md:text-[13.5px]">New conversation</span>} />
    </div>
  );
}
