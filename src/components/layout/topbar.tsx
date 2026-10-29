'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { IconSearch, IconLogout, IconMoon, IconSun, IconMessageCircle, IconInbox, IconRobot, IconChecklist, IconMessages, IconFlask2, IconRepeat, IconTerminal2,
  IconHeartbeat, IconChartLine, IconTarget, IconBrain, IconTopologyStar3, IconSparkles, IconBook2, IconNotebook, IconTestPipe } from '@tabler/icons-react';
import { signOut, useSession } from 'next-auth/react';
import { useTheme } from 'next-themes';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { locate, withOrg } from '@/lib/nav';
import { useOrg } from '@/hooks/use-org';
import { useAreas } from '@/hooks/use-areas';
import { cn } from '@/lib/utils';
import { usePalette } from './palette-context';
import { ContractPill } from './contract-pill';
import { useSubTabs } from '@/hooks/use-subtabs';
import { SETTINGS_SECTIONS } from '@/components/settings/sections';
import { useSearchParams } from 'next/navigation';

// Area bar (Porcelain Signal): the area's name, its pages as underline tabs, ⌘K on the right.
// The AI side: the group's pages as icon tabs instead of the name.
const AI_AREAS = ['HOME', 'OPS', 'AUTO', 'PERF', 'INTEL', 'LIB'];
const PAGE_ICONS: Record<string, typeof IconSearch> = {
  '/ai': IconMessageCircle, '/ai/inbox': IconInbox, '/ai/agents': IconRobot, '/ai/tasks': IconChecklist, '/ai/comms': IconMessages, '/ai/tests': IconTestPipe,
  '/ai/routines': IconRepeat, '/ai/automations': IconTerminal2, '/workflows/health': IconHeartbeat, '/analytics': IconChartLine, '/strategy': IconTarget,
  '/ai/memory': IconBrain, '/ai/graph': IconTopologyStar3, '/ai/skills': IconSparkles, '/knowledge-base': IconBook2, '/wiki': IconNotebook, '/experiments': IconFlask2,
};
// On phones (iOS look, D 2026-10-15): contract pill left, round search and account right; pages live in the floating tab bar.
export function Topbar() {
  const pathname = usePathname();
  const { open } = usePalette();
  const areas = useAreas();
  const { area, tab } = locate(areas, pathname);
  // pages outside the nav (locate falls back to the first area): name the page itself
  const offNav = tab ? undefined : ({ '/platform': 'Platform', '/account': 'Account' } as Record<string, string>)[`/${pathname.split('/')[1]}`];
  const { report } = useSubTabs();
  const settingsTab = useSearchParams().get('tab');
  const subOn = area.key === 'SETTINGS' ? (SETTINGS_SECTIONS.find((x) => x.id === settingsTab) ?? SETTINGS_SECTIONS[0]).label
    : report && report.items.length > 1 ? report.items.find((i) => i.on)?.label : undefined;
  const { currentOrg } = useOrg();
  const aiTabs = !offNav && AI_AREAS.includes(area.key) && area.tabs.length > 1;
  // Phones have no side rail, so the account menu (log out, theme) sits here (D, 2026-10-02: no way to log out on mobile).
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const username = session?.user?.name ?? 'Account';
  const initials = username.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'U';

  return (
    <header className="shrink-0 border-b border-transparent bg-canvas/90 px-4 max-md:bg-[#F2F2F7]/85 max-md:dark:bg-canvas/90 pt-[env(safe-area-inset-top)] backdrop-blur md:bg-transparent md:px-8 md:backdrop-blur-none">
      <div className="flex min-h-14 items-center gap-4 pt-2 md:min-h-[62px] md:pt-0">
        {/* phones: the contract you are in, tap to switch (the bottom bar holds the pages) */}
        <div className="min-w-0 md:hidden"><ContractPill /></div>
        {/* desktop: where you are (the pages and sub-pages live in the sidebar, D 2026-10-09) */}
        {aiTabs ? (
          <nav aria-label={area.short} className="hidden min-w-0 items-center gap-1 overflow-x-auto no-scrollbar md:flex">
            {area.tabs.map((t) => { const I = PAGE_ICONS[t.href] ?? IconSparkles, on = tab?.href === t.href; return (
              <Link key={t.href} href={withOrg(t.href, currentOrg)} aria-current={on ? 'page' : undefined}
                className={cn('flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-[13.5px] transition-colors',
                  on ? 'glass-pill font-semibold text-foreground' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground')}>
                <I size={17} stroke={1.8} className={on ? 'text-primary' : undefined} />{t.label}
              </Link>
            ); })}
          </nav>
        ) : <span className="hidden min-w-0 items-center gap-2 truncate text-[13.5px] text-muted-foreground md:flex">
          {offNav ? <span className="truncate font-semibold text-foreground">{offNav}</span> : <span className="truncate">{area.business ? area.name : area.short}</span>}
          {tab && tab.label !== area.short && <><span className="text-label">/</span><span className={cn('truncate', !subOn && 'font-semibold text-foreground')}>{tab.label}</span></>}
          {subOn && <><span className="text-label">/</span><span className="truncate font-semibold text-foreground">{subOn}</span></>}
        </span>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button type="button" onClick={open} aria-label="Search" className="glass-pill grid size-11 place-items-center rounded-full text-foreground md:hidden">
            <IconSearch size={19} stroke={2.2} />
          </button>
          <button type="button" onClick={open}
            className="glass-pill hidden h-10 min-w-[250px] items-center gap-2.5 rounded-full px-3.5 text-[13.5px] text-muted-foreground transition-colors hover:text-foreground md:flex">
            <IconSearch size={16} stroke={1.8} />
            <span className="flex-1 text-left">Ask or jump to anything</span>
            <kbd className="font-mono text-[11px] text-label">⌘K</kbd>
          </button>
          <div className="md:hidden">
            <DropdownMenu>
              <DropdownMenuTrigger aria-label="Account" title={`${username}: theme and log out`}
                className="flex size-11 cursor-pointer items-center justify-center rounded-full bg-[#273042] text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-[#7B93FF]">
                {initials}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={8} className="min-w-44">
                <div className="px-2 py-1.5 text-sm font-medium">{username}</div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                  {theme === 'dark' ? <IconSun size={14} /> : <IconMoon size={14} />}<span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => signOut({ redirectTo: '/login' })}>
                  <IconLogout size={14} /><span>Log out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </header>
  );
}
