'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Command as CommandPrimitive } from 'cmdk';
import { IconFileText, IconMessage, IconRepeat, IconRobot, IconSearch, IconSparkles } from '@tabler/icons-react';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';
import { useOrg } from '@/hooks/use-org';
import { withOrg } from '@/lib/nav';
import { useAreas } from '@/hooks/use-areas';

// ⌘K (2026-09-29): jump to any page of any area, or switch the org. Replaces the old Search
// button that did nothing and the org dropdown in the top bar.
// Typing also searches agents, your conversations, skills, routines and Knowledge (GET /api/search).

/** Switch org everywhere: the org context plus ?org= in the URL (the shell keeps the two in sync). */
export function useSwitchOrg() {
  const router = useRouter();
  const { setCurrentOrg } = useOrg();
  return (org: string) => {
    setCurrentOrg(org);
    const url = new URL(window.location.href);
    if (org === 'all') url.searchParams.delete('org'); else url.searchParams.set('org', org);
    router.push(`${url.pathname}${url.search}`);
  };
}

type Hit = { kind: 'agent' | 'chat' | 'skill' | 'routine' | 'doc'; title: string; sub: string; href: string };
const KINDS = [['agent', 'Agents', IconRobot], ['chat', 'Conversations', IconMessage], ['skill', 'Skills', IconSparkles], ['routine', 'Routines', IconRepeat],
  ['doc', 'Documents', IconFileText]] as const;

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const { currentOrg, orgs } = useOrg();
  const switchOrg = useSwitchOrg();
  const areas = useAreas();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setQ(''); setHits([]); } }, [open]);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setHits([]); setBusy(false); return; }
    const ctl = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(t)}`, { signal: ctl.signal }).then((r) => (r.ok ? r.json() : { hits: [] }))
        .then((j: { hits?: Hit[] }) => { setHits(j.hits ?? []); setBusy(false); }).catch(() => {});
    }, 200);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [q]);

  const go = (href: string) => { onOpenChange(false); router.push(withOrg(href, currentOrg)); };
  const pickOrg = (org: string) => { onOpenChange(false); switchOrg(org); };

  // cmdk needs its <Command> root inside the dialog, or typing crashes the page (store is undefined).
  const group = '**:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:pb-1.5 **:[[cmdk-group-heading]]:pt-3 **:[[cmdk-group-heading]]:font-mono **:[[cmdk-group-heading]]:text-[10.5px] **:[[cmdk-group-heading]]:font-normal **:[[cmdk-group-heading]]:uppercase **:[[cmdk-group-heading]]:tracking-[0.12em] **:[[cmdk-group-heading]]:text-label';
  const item = 'h-10 gap-3 rounded-xl! px-3 text-[14px] data-selected:bg-inset';
  const chip = 'flex h-6 min-w-8 items-center justify-center rounded-lg bg-inset px-1.5 font-heading text-[10.5px] font-semibold tracking-[0.02em] text-muted-foreground group-data-selected/command-item:bg-card group-data-selected/command-item:text-foreground';
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Jump to" description="Search every page, or switch the org."
      className="top-[16%] w-[min(620px,calc(100vw-2rem))] max-w-none! gap-0 rounded-[20px]! bg-card p-0 shadow-[0_48px_120px_-32px_rgba(14,20,34,0.6)]">
      <Command className="rounded-[20px]! bg-card p-0">
        <div className="flex items-center gap-3 border-b border-hairline px-4">
          <IconSearch size={18} stroke={1.8} className="shrink-0 text-muted-foreground" />
          <CommandPrimitive.Input placeholder="Search people, calls, payments, clients, files and pages" autoFocus value={q} onValueChange={setQ}
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] shadow-none! outline-none placeholder:text-label" />
          <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 font-mono text-[10.5px] text-label sm:inline">ESC</kbd>
        </div>
        <CommandList className="max-h-[min(60dvh,440px)] px-2 pb-2">
          <CommandEmpty className="py-10 text-center text-[13.5px] text-muted-foreground">{busy ? 'Searching…' : 'Nothing matches that.'}</CommandEmpty>
          {KINDS.map(([kind, heading, Icon]) => {
            const list = hits.filter((h) => h.kind === kind);
            return list.length ? (
              <CommandGroup key={kind} heading={heading} className={`p-0 ${group}`}>
                {list.map((h) => (
                  // the server already matched these: the query is in the value so the palette's own filter keeps them
                  <CommandItem key={h.href} value={`${kind} ${h.title} ${h.sub} ${h.href} ${q}`} onSelect={() => { onOpenChange(false); router.push(h.href); }} className={item}>
                    <Icon size={17} stroke={1.7} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{h.title}</span>
                    {h.sub && <span className="ml-auto min-w-0 truncate pl-3 text-[12px] text-label">{h.sub}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null;
          })}
          {areas.map((a) => (
            <CommandGroup key={a.key} heading={a.short} className={`p-0 ${group}`}>
              {a.tabs.map((t) => (
                <CommandItem key={t.href} value={`${a.short} ${t.label}`} onSelect={() => go(t.href)} className={item}>
                  <span className={chip}>{a.mono}</span>
                  <span>{t.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
