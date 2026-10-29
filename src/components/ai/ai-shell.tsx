'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { IconPlus, IconSearch, IconSparkles, IconSlash, IconBrain, IconRepeat, IconX, IconMessages, IconAffiliate, IconChevronRight, IconLayoutKanban } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { AgentGlyph } from './agent-mark';
import { ThreadMenu } from './thread-menu';
import { FolderGlyph } from '@/components/wiki/folder-tree';
import { relTime, useAiAgents, useAiThreads, type UiThread } from './use-ai';

// The AI section's frame (D, 2026-10-09, AgentsSidebar): a left column with New conversation, the pages (Agents, Skills,
// Memory; Routines too, D 2026-10-09) and the conversations (search over titles and messages, the agent's mark, age, a menu per row), then the page. Phones get
// the page only (the AI area's tabs reach Agents, Skills and Memory).
export function AiShell({ children, full = true }: { children: React.ReactNode; /** owner or admin: Agents, Routines, Skills, Memory */ full?: boolean }) {
  const chat = usePathname() === '/ai'; // the conversations column belongs to the chat; the other AI pages get the full width (D, 2026-10-27)
  return (
    <div className="flex min-h-0 flex-1">
      <aside className={cn('lg-glass m-2 mr-0 hidden w-[264px] shrink-0 flex-col rounded-[18px]', chat && 'md:flex')}>
        <AiSide full={full} />
      </aside>
      <div data-ai-page="" className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

function AiSide({ full = true }: { full?: boolean }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const router = useRouter();
  const thread = pathname === '/ai' ? Number(sp.get('thread')) || null : null;
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 200); return () => clearTimeout(t); }, [search]);
  const threads = useAiThreads(q);
  const agents = useAiAgents()?.agents ?? [];
  const page = (href: string, label: string, Ico: typeof IconSparkles) => {
    const on = pathname === href;
    return (
      <Link href={href} aria-current={on ? 'page' : undefined}
        className={cn('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors', on ? 'lg-tint font-semibold text-foreground' : 'text-muted-foreground hover:bg-inset hover:text-foreground')}>
        <Ico size={16} stroke={1.7} className="shrink-0" />{label}
      </Link>
    );
  };
  const closeSearch = () => { setSearch(''); setSearchOpen(false); };
  // routines get their own section below the chats, one folder per routine with its runs inside (D, 2026-10-27); chats stay under Conversations
  const chats = threads?.filter((t) => !t.routine_id) ?? null;
  const byRoutine = new Map<number, { name: string; runs: UiThread[] }>();
  for (const t of threads ?? []) if (t.routine_id) {
    const g = byRoutine.get(t.routine_id) ?? byRoutine.set(t.routine_id, { name: t.routine || 'Routine', runs: [] }).get(t.routine_id)!;
    g.runs.push(t);
  }
  const routineList = [...byRoutine.entries()].sort((a, b) => b[1].runs[0].updated_at.localeCompare(a[1].runs[0].updated_at));
  const [open, setOpen] = useState<Set<number>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem('ai:routines-open') ?? '[]') as number[]); } catch { return new Set(); }
  });
  const toggle = (id: number) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { sessionStorage.setItem('ai:routines-open', JSON.stringify([...next])); } catch { /* storage off: stays open for this page only */ }
    return next;
  });
  // open when you opened it, while searching, or when the run on screen is in it
  const openOf = (id: number) => open.has(id) || !!q || !!byRoutine.get(id)?.runs.some((t) => t.id === thread);
  const row = (t: UiThread, label: string, nested = false) => {
    const a = agents.find((x) => x.id === t.agent_id) ?? agents.find((x) => x.is_default);
    const on = thread === t.id;
    return (
      <div key={t.id} className={cn('group relative flex h-[30px] items-center rounded-lg', on ? 'lg-tint' : 'hover:bg-foreground/5')}>
        <Link href={`/ai?thread=${t.id}`} aria-current={on ? 'page' : undefined} title={[t.title, a?.name].filter(Boolean).join(' · ')}
          className={cn('flex min-w-0 flex-1 items-center gap-2 px-2.5 text-[13px]', nested && 'pl-[34px]')}>
          {!nested && <AgentGlyph icon={a?.icon} color={a?.color} size={14} />}
          <span className={cn('min-w-0 flex-1 truncate', on ? 'font-semibold text-foreground' : 'text-foreground/85')}>{label || 'Untitled'}</span>
          <span className="shrink-0 font-mono text-[11px] text-label group-hover:invisible group-has-[[aria-expanded=true]]:invisible">{relTime(t.updated_at)}</span>
        </Link>
        <span className="absolute right-1 hidden group-hover:block group-has-[[aria-expanded=true]]:block">
          <ThreadMenu thread={t} className="size-6" onGone={() => { if (on) router.replace('/ai'); }} />
        </span>
      </div>
    );
  };
  return (
    <>
      <div className="px-3 pb-2 pt-3">
        <Link href="/ai" className="glass-pill flex h-9 items-center gap-2 rounded-full px-3 text-[13px] font-semibold hover:bg-foreground/5">
          <IconPlus size={15} stroke={2} />New conversation
        </Link>
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {/* desktop has these under AI in the app sidebar (D, 2026-10-09: no doubled nav); phones keep them here */}
        <div className={full ? 'flex flex-col gap-0.5 md:hidden' : 'hidden'}>
          {page('/ai/agents', 'Agents', IconSparkles)}
          {page('/ai/tasks', 'Tasks', IconLayoutKanban)}
          {page('/ai/routines', 'Routines', IconRepeat)}
          {page('/ai/skills', 'Skills', IconSlash)}
          {page('/ai/memory', 'Memory', IconBrain)}
          {page('/ai/graph', 'Graph', IconAffiliate)}
          {page('/ai/comms', 'Comms', IconMessages)}
        </div>
        <div className="mt-4 flex h-7 items-center justify-between px-2.5 md:mt-1">
          <span className="text-[12px] font-semibold text-muted-foreground">Conversations</span>
          <button type="button" aria-label="Search conversations" title="Search conversations" aria-pressed={searchOpen}
            onClick={() => { if (searchOpen) closeSearch(); else { setSearchOpen(true); requestAnimationFrame(() => box.current?.focus()); } }}
            className={cn('grid size-6 place-items-center rounded-md hover:bg-inset hover:text-foreground', searchOpen ? 'bg-inset text-foreground' : 'text-muted-foreground')}>
            {searchOpen ? <IconX size={13} /> : <IconSearch size={13} />}
          </button>
        </div>
        {searchOpen && (
          <div className="relative mx-0.5 mb-1.5">
            <IconSearch size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-label" />
            <input ref={box} type="search" value={search} placeholder="Search conversations" aria-label="Search conversations" onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } }}
              className="h-8 w-full rounded-lg border border-border bg-inset pl-8 pr-2 text-[12.5px] outline-none focus:border-foreground/25" />
          </div>
        )}
        {chats === null && <div className="px-2.5 py-1.5 text-[12.5px] text-label">Loading...</div>}
        {chats?.length === 0 && <div className="px-2.5 py-1.5 text-[12.5px] text-label">{q ? `No results for "${q}"` : 'No conversations yet'}</div>}
        {chats?.map((t) => row(t, t.title))}
        {routineList.length > 0 && <>
          <div className="mt-4 flex h-7 items-center px-2.5"><span className="text-[12px] font-semibold text-muted-foreground">Routines</span></div>
          {routineList.map(([id, g]) => {
            const isOpen = openOf(id);
            return (
              <div key={id}>
                <button type="button" onClick={() => toggle(id)} aria-expanded={isOpen} title={g.name}
                  className="flex h-[30px] w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-inset">
                  <IconChevronRight size={13} stroke={2} className={cn('shrink-0 text-label transition-transform', isOpen && 'rotate-90')} />
                  <FolderGlyph open={isOpen} size={15} />
                  <span className="min-w-0 flex-1 truncate text-foreground/85">{g.name}</span>
                  <span className="shrink-0 font-mono text-[11px] text-label">{g.runs.length}</span>
                </button>
                {/* a run's title is "<routine> · <date>": inside its folder the date says enough */}
                {isOpen && g.runs.map((t) => row(t, t.title.startsWith(`${g.name} · `) ? t.title.slice(g.name.length + 3) : t.title, true))}
              </div>
            );
          })}
        </>}
      </div>
    </>
  );
}
