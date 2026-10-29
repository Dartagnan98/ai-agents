'use client';

import { useState } from 'react';
import { AppLink as Link } from '@/components/shared/app-link';
import { usePathname } from 'next/navigation';
import { IconLayoutDashboard, IconDots, IconSearch, IconClockHour4, IconBook2, IconFolders, IconSettings, IconX, IconFilter, IconChartLine, IconTrophy, IconCalendarDollar, IconFileInvoice, IconUser, IconHome, IconSparkles, IconCurrencyDollar, IconCalendar, IconUsers, IconUserPlus, IconMessages, IconBulb, IconHeartbeat, IconReportMoney, IconLayoutGrid, IconRobot, IconChecklist, IconActivity, IconCircleCheck, IconAffiliate, IconTarget, IconBook, IconFlask, IconTool, IconChevronRight } from '@tabler/icons-react';
import { homeArea } from '@/lib/access';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useOrg } from '@/hooks/use-org';
import { locate, withOrg } from '@/lib/nav';
import { useAreas } from '@/hooks/use-areas';
import { useAiAllowed } from './agent-chat';
import { cn } from '@/lib/utils';
import { usePalette } from './palette-context';

// Phone tab bar (iOS look, D 2026-10-15: "floating glass hot bar"; the contract bar at the bottom did not scale past a few contracts):
// the pages of the area you are in (Overview, Money, Team, Leads on a contract), More for its other pages and the AI side, and the
// round Ask button beside it. Contracts switch from the pill at the top (topbar.tsx), keeping the page and range.
type Icon = typeof IconLayoutDashboard;
// Box glyphs by page label; any other page gets the grid.
const PAGE_ICON: Record<string, Icon> = {
  Overview: IconLayoutDashboard, Agents: IconRobot, Tasks: IconChecklist, Activity: IconActivity, Comms: IconMessages, Approvals: IconCircleCheck,
  Workflows: IconAffiliate, 'Fleet health': IconHeartbeat, Strategy: IconTarget, Analytics: IconChartLine, Knowledge: IconBook2, Wiki: IconBook,
  Experiments: IconFlask, Skills: IconTool, Settings: IconSettings,
  Revenue: IconCurrencyDollar, 'Payment plans': IconCalendarDollar, Bookings: IconCalendar, Staff: IconUsers, Funnels: IconFilter, Leads: IconUserPlus,
  Engagement: IconMessages, Insights: IconBulb, 'Data health': IconHeartbeat, Leaderboard: IconTrophy, Invoices: IconFileInvoice, 'P&L': IconReportMoney,
  Money: IconCurrencyDollar, Calls: IconCalendar, Team: IconUsers, 'Call reviews': IconMessages, Contacts: IconUsers, Marketing: IconChartLine,
  Files: IconFolders, AI: IconSparkles, Routines: IconClockHour4, Memory: IconBook2, Drive: IconFolders, Onboarding: IconChecklist,
};
// Bar labels stay one short word so four tabs fit at 375 px.
const SHORT: Record<string, string> = { 'Data health': 'Health', 'Call reviews': 'Reviews', 'Fleet health': 'Health', 'My stats': 'Stats', 'My money': 'Money' };
// A rep's portal pages in the phone bar (D, 2026-10-02): short labels so five fit at 375 px.
const REP_BAR: { test: RegExp; label: string; icon: Icon }[] = [
  // the rep boards (D 2026-10-15): Home, Calls, Pay, Board, Me, in that order
  { test: /\/me$/, label: 'Home', icon: IconHome },
  { test: /\/me\/call-reviews/, label: 'Calls', icon: IconMessages },
  { test: /\/me\/money/, label: 'Pay', icon: IconFileInvoice }, // My invoices + Payment plans (D, 2026-10-06)
  { test: /\/me\/leaderboard/, label: 'Board', icon: IconTrophy },
  { test: /\/me\/profile/, label: 'Me', icon: IconUser },
]

export function BottomNav() {
  const pathname = usePathname();
  const { currentOrg } = useOrg();
  const { open: openPalette } = usePalette();
  const [more, setMore] = useState(false);
  const areas = useAreas();
  const aiOk = useAiAllowed();
  const { area, tab } = locate(areas, pathname);
  const current = tab?.href;
  const close = () => setMore(false);

  const bar = (children: React.ReactNode, label: string) => (
    <div data-phone-bar className="fixed inset-x-4 bottom-[max(16px,calc(env(safe-area-inset-bottom)+6px))] z-40 flex items-center gap-2.5 md:hidden">
      <nav aria-label={label} className="glass flex h-16 min-w-0 flex-1 items-center rounded-[32px] px-1.5">{children}</nav>
      {aiOk && !pathname.startsWith('/ai') && (
        <Link href="/ai" aria-label="Ask AI" className="glass grid size-16 shrink-0 place-items-center rounded-full text-[var(--ai)]">
          <IconSparkles size={26} stroke={1.8} />
        </Link>
      )}
    </div>
  );
  const cell = (on: boolean, label: string, Glyph: Icon) => (
    <>
      <Glyph size={22} stroke={on ? 2.1 : 1.8} />
      <span className={cn('max-w-full truncate text-[10px] leading-3 tracking-[-0.01em]', on ? 'font-bold' : 'font-semibold')}>{SHORT[label] ?? label}</span>
    </>
  );
  const cellCls = (on: boolean) => cn('flex h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[26px] transition-colors',
    on ? 'bg-cobalt/12 text-cobalt' : 'text-foreground/80');

  // The bar always holds a contract's pages (iOS: the tab bar never changes); off the contracts (Settings, AI ...) it keeps the last contract
  // you were on (else the home one) and More is lit, since those pages live in More.
  const home = homeArea(areas);
  const lastKey = (() => { try { return sessionStorage.getItem('phone-bar-area'); } catch { return null; } })();
  const barArea = area.business ? area : areas.find((a) => a.business && a.key === lastKey) ?? (home?.business ? home : area);
  if (area.business && typeof window !== 'undefined') { try { sessionStorage.setItem('phone-bar-area', area.key); } catch { /* storage blocked */ } }
  const tabs = barArea.tabs;
  // What More holds: this contract's other pages, then every non-contract area (AI, Operations, Intelligence, Drive, Settings).
  const sideAreas = areas.filter((a) => !a.business && a.tabs.length);
  const roomy = tabs.length <= 4 && !sideAreas.length;
  const shown = roomy ? tabs : tabs.slice(0, 4);
  const rest = tabs.slice(shown.length);
  if (!shown.length && !sideAreas.length) return null;
  const moreOn = more || !area.business || (!!current && rest.some((t) => t.href === current));
  const sections = [...(rest.length ? [{ key: barArea.key, name: barArea.name, tabs: rest }] : []), ...sideAreas.map((a) => ({ key: a.key, name: a.name, tabs: a.tabs }))];

  return (
    <>
      {bar(<>
        {shown.map((t) => {
          const on = t.href === current;
          return (
            <Link key={t.href} href={withOrg(t.href, currentOrg)} aria-current={on ? 'page' : undefined} unstable_dynamicOnHover className={cellCls(on)}>
              {cell(on, t.label, PAGE_ICON[t.label] ?? IconLayoutGrid)}
            </Link>
          );
        })}
        {!roomy && (
          <button type="button" onClick={() => setMore(true)} aria-expanded={more} className={cellCls(moreOn)}>
            {cell(moreOn, 'More', IconDots)}
          </button>
        )}
      </>, 'Pages')}

      <Sheet open={more} onOpenChange={setMore}>
        <SheetContent side="bottom" showCloseButton={false} className="max-h-[88dvh] gap-0 rounded-t-[28px] border-0 bg-canvas p-0 md:hidden">
          <div className="shrink-0 px-4">
            <span className="mx-auto mt-2 block h-[5px] w-9 rounded-full bg-[#D5DAE4] dark:bg-white/20" aria-hidden />
            <div className="-mr-1.5 ml-1 mt-0.5 flex h-11 items-center justify-between">
              <SheetTitle className="text-xl font-bold tracking-[-0.02em]">More</SheetTitle>
              <SheetClose aria-label="Close" className="flex size-11 items-center justify-center">
                <span className="flex size-8 items-center justify-center rounded-full bg-muted text-foreground"><IconX size={16} stroke={2} /></span>
              </SheetClose>
            </div>
          </div>
          {/* One scrolling body under a fixed header (a clipped box inside the flex sheet cut its rows off, 2026-10-02). */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,calc(env(safe-area-inset-bottom)+12px))]">
            <button type="button" onClick={() => { close(); openPalette(); }}
              className="mt-1 flex h-11 w-full items-center gap-2.5 rounded-xl bg-[rgba(118,118,128,0.12)] px-3 text-left text-[17px] text-muted-foreground">
              <IconSearch size={18} stroke={2} />
              Search
            </button>
            {sections.map(({ key, name, tabs: list }) => (
              <section key={key} className="mt-5">
                <h3 className="mx-4 text-[13px] font-semibold uppercase tracking-[0.02em] text-muted-foreground">{name}</h3>
                <div className="mt-1.5 overflow-hidden rounded-[22px] bg-card">
                  {list.map((t, i) => {
                    const on = t.href === current, G = PAGE_ICON[t.label] ?? IconLayoutGrid;
                    return (
                      <Link key={t.href} href={withOrg(t.href, currentOrg)} onClick={close} aria-current={on ? 'page' : undefined}
                        className={cn('flex h-[52px] items-center gap-3.5 px-4 text-[17px]', i > 0 && 'border-t border-[rgba(60,60,67,0.12)] dark:border-white/10', on && 'text-cobalt')}>
                        <span className="grid size-[30px] place-items-center rounded-lg bg-cobalt text-white"><G size={17} stroke={2} /></span>
                        <span className="flex-1 truncate">{t.label}</span>
                        <IconChevronRight size={16} stroke={2.4} className="text-[#A3A3A8]" />
                      </Link>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
