'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Sidebar } from './sidebar';
import { AgentChat } from './agent-chat';
import { SubTabsProvider } from '@/hooks/use-subtabs';
import { Topbar } from './topbar';
import { BottomNav } from './bottom-nav';
import { PhoneLists } from '@/components/shared/phone-lists';
import { SwipeTabs } from './swipe-tabs';
import dynamic from 'next/dynamic';
import { PaletteContext } from './palette-context';
import { OrgContext } from '@/hooks/use-org';
import { AreasContext, ViewsContext } from '@/hooks/use-areas';
import type { Area } from '@/lib/nav';

// the ⌘K palette loads on first open (2026-10-21: cmdk was ~100 KB of every page's script)
const CommandPalette = dynamic(() => import('./command-palette').then((m) => m.CommandPalette), { ssr: false });

interface DashboardShellProps {
  orgs: string[];
  areas: Area[];
  children: React.ReactNode;
  staff?: boolean; // CTRL staff (PLATFORM_ADMIN_EMAILS): the account menu links the platform console
  views?: boolean; // a manager who also sells: the nav shows Team view or User view (their rep portal), one at a time
  photo?: string; // their Slack photo ('' = initials), lib/people-photos.ts
}

const FLAT = ['/ai', '/workflows', '/analytics', '/strategy', '/knowledge-base', '/wiki', '/experiments'];

// Pages are server-rendered from ?org=, so the org picker has to change the URL, not just client state.
function urlWithOrg(pathname: string, org: string): string {
  const sp = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
  if (org && org !== 'all') sp.set('org', org);
  else sp.delete('org');
  const qs = sp.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

export function DashboardShell({ orgs, areas: allAreas, children, staff, views, photo }: DashboardShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  // The URL is the org (the server renders from ?org= too, so server and client always agree; reading
  // localStorage during the first render made every page log a hydration mismatch). The browser only
  // remembers the last org, and a page opened without ?org= comes back to it.
  const params = useSearchParams();
  const urlOrg = params.get('org');
  const currentOrg = urlOrg && (urlOrg === 'all' || orgs.includes(urlOrg)) ? urlOrg : 'all';
  // Trackpad scroll latching (D, 2026-10-06: "when I start side scrolling on the sheet it stops me from scrolling unless I scroll out
  // of the card"): after a sideways swipe the browser keeps the gesture on that sheet, so up/down did nothing until the pointer left it.
  // A mostly vertical wheel over any sideways-scrolling box scrolls the page instead; sideways stays in the box.
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      let el = e.target instanceof Element ? e.target : null, sideways = false;
      while (el && el !== main) {
        const st = getComputedStyle(el);
        if (/auto|scroll/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 1) return; // a real vertical scroller: leave it
        if (/auto|scroll/.test(st.overflowX) && el.scrollWidth > el.clientWidth + 1) sideways = true;
        el = el.parentElement;
      }
      if (!sideways) return;
      e.preventDefault();
      main.scrollBy({ top: e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY });
    };
    main.addEventListener('wheel', onWheel, { passive: false });
    return () => main.removeEventListener('wheel', onWheel);
  }, []);
  // The frame stays put (D, 2026-10-16: "the top bar keeps getting cut off, it doesn't stay at the top"): only <main> scrolls, but
  // scrollIntoView (next call, transcript follow), focus and anchors also scrolled the overflow-hidden frame, sliding the top bar off
  // screen; screen-reader labels deep in long lists hung off the frame (main was not positioned) and made it ~5,000 px tall. Now main is
  // relative and the frame and column clip (cannot scroll at all); as a backstop anything that scrolls them or the page is put back (the page only while no field is
  // focused, so the phone keyboard keeps its own pan).
  const frameRef = useRef<HTMLDivElement>(null), colRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const typing = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || (a as HTMLElement).isContentEditable); };
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t === frameRef.current || t === colRef.current) { const el = t as HTMLElement; if (el.scrollTop || el.scrollLeft) { el.scrollTop = 0; el.scrollLeft = 0; } }
      else if ((t === document || t === document.documentElement) && (window.scrollY || window.scrollX) && !typing()) window.scrollTo(0, 0);
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true });
  }, []);
  useEffect(() => {
    try {
      if (urlOrg) { localStorage.setItem('ctrlos-org', currentOrg); return; }
      const saved = localStorage.getItem('ctrlos-org') ?? localStorage.getItem('cortextos-org'); // old key read once
      if (saved && saved !== 'all' && orgs.includes(saved)) router.replace(urlWithOrg(pathname, saved));
    } catch { /* storage blocked: the URL alone drives the org */ }
  }, [urlOrg, currentOrg, orgs, pathname, router]);

  // Picking an org: remember it here; the picker pushes the ?org= URL itself (picking All must be
  // remembered before that push, or the effect above would jump back to the saved org).
  const changeOrg = useCallback((org: string) => {
    try { localStorage.setItem('ctrlos-org', org); } catch { /* storage blocked */ }
  }, []);
  const areas = allAreas;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteUsed, setPaletteUsed] = useState(false);
  const openPalette = useCallback(() => { setPaletteUsed(true); setPaletteOpen(true); }, []);
  // ⌘K lives here, not in the palette, so it works before the palette has loaded
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteUsed(true); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Porcelain Signal shell (2026-09-29; desktop sidebar 2026-10-09): sidebar with sub-account switcher and pages, a slim top bar, phone bar.
  return (
    <OrgContext.Provider value={{ currentOrg, setCurrentOrg: changeOrg, orgs }}>
      <AreasContext.Provider value={areas}>
      <ViewsContext.Provider value={null}>
      <PaletteContext.Provider value={{ open: openPalette }}>
      <SubTabsProvider>
        {/* h-dvh, not h-screen: on phones 100vh includes the space behind the browser bar, so the whole page
            (area bar and tabs included) scrolled by that much. Pinned frame; only <main> scrolls. */}
        {/* print: the page prints as a document (invoices), not a capture of the app frame */}
        {/* pinned to the window's edges (D, 2026-10-12: in a browser pane 100dvh came out taller than the pane, so a wheel over the
            sidebar scrolled the whole page and showed a white strip). fixed inset-0 can never be taller than what is visible. */}
        {/* Liquid glass (D, 2026-10-28, app/liquid-glass.css): the wallpaper on the frame, a rounded see-through window, the sidebar a
            floating glass card inside it, the page on a light veil. Phones keep the full-bleed layout and bottom bar. */}
        <div ref={frameRef} className="lg-frame fixed inset-0 flex overflow-clip overscroll-none print:static print:block print:h-auto print:overflow-visible">
          {/* first in the tree, so its prefetches queue behind the page's own (Next starts the newest first) */}
          <SwipeTabs />
          <div className="lg-window flex min-w-0 flex-1 print:block">
            <div data-chrome className="lg-side-wrap hidden h-full md:block print:!hidden">
              <Sidebar staff={staff} photo={photo} />
            </div>
            <div ref={colRef} className="lg-main flex min-w-0 flex-1 flex-col overflow-clip print:block print:overflow-visible">
              <div data-chrome className="contents print:!hidden"><Topbar /></div>
              {/* the AI, Operations and Intelligence pages draw their lists without lines between rows (D, 2026-10-28; app/liquid-glass.css) */}
              <main ref={mainRef} data-flat={FLAT.some((h) => pathname === h || pathname.startsWith(`${h}/`)) || undefined} className={pathname === '/ai' || pathname.startsWith('/ai/') ? 'relative flex min-h-0 flex-1 flex-col overflow-hidden' : pathname === '/split' ? 'relative min-h-0 flex-1 overflow-hidden' : 'relative canvas-grid flex-1 overflow-auto overscroll-contain p-4 pb-[calc(104px+env(safe-area-inset-bottom))] md:p-8 md:pt-6 print:overflow-visible print:bg-none print:p-0'}>
                {children}
              </main>
              <div data-chrome className="contents print:!hidden"><BottomNav /></div>
              <PhoneLists />
            </div>
          </div>
        </div>
        {paletteUsed && <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />}
        {pathname !== '/split' && <div data-chrome className="contents print:!hidden"><AgentChat /></div>}
      </SubTabsProvider>
      </PaletteContext.Provider>
      </ViewsContext.Provider>
      </AreasContext.Provider>
    </OrgContext.Provider>
  );
}
