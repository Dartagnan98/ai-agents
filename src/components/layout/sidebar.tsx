'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Face } from '@/components/shared/face';
import { AppLink as Link } from '@/components/shared/app-link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { signOut, useSession } from 'next-auth/react';
import { IconChartLine, IconBrain, IconCalendar, IconLayoutDashboard, IconCash, IconPhone, IconUsers, IconFilter, IconChartBar, IconAddressBook, IconVideo, IconActivity, IconUser, IconRobot, IconClockHour4, IconBook2, IconTrophy, IconSelector, IconChevronRight, IconCheck, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconSearch, IconSettings, IconLogout, IconUsersGroup, IconSun, IconMoon, IconDeviceDesktop, IconArrowLeft, IconInbox } from '@tabler/icons-react';
import { useOrg } from '@/hooks/use-org';
import { useAreas } from '@/hooks/use-areas';
import { useSubTabs } from '@/hooks/use-subtabs';
import { locate, sameTabHref, withOrg, type Area, type NavTab } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { ViewSwitch } from './contract-pill';
import { useViews } from '@/hooks/use-areas';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from '@/components/settings/sections';

// Desktop sidebar (D, 2026-10-09, replaces the rail + top tab row): a sub-account switcher at the top (a dropdown, so an agency with
// hundreds of clients still fits), the open sub-account's pages with their sub-pages in line under the open one, the AI side under
// Workspace, and the account menu on the name (Settings lives there). Collapses to icons. Phones keep the bottom bar (bottom-nav.tsx).
type Icon = typeof IconLayoutDashboard;
const PAGE_ICONS: Record<string, Icon> = {
  overview: IconLayoutDashboard, money: IconCash, 'calls-pipeline': IconPhone, team: IconUsers, leads: IconFilter, marketing: IconChartBar,
  contacts: IconAddressBook, calendar: IconCalendar, calls: IconVideo, health: IconActivity, me: IconUser, 'me-leaderboard': IconTrophy, 'me-calls': IconPhone,
};
const AREA_ICONS: Record<string, Icon> = { HOME: IconRobot, OPS: IconUsersGroup, AUTO: IconClockHour4, PERF: IconChartLine, INTEL: IconBrain, LIB: IconBook2 };
const MINI_KEY = 'fleet-sidebar-mini';

function Tip({ show, label, children }: { show: boolean; label: string; children: React.ReactNode }) {
  return (
    <div className="group/tip relative">
      {children}
      {show && <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 hidden -translate-y-1/2 whitespace-nowrap rounded-lg bg-foreground px-2.5 py-1.5 text-[12.5px] font-medium text-background group-hover/tip:block">{label}</span>}
    </div>
  );
}

const row = (on: boolean) => cn('flex h-[38px] w-full items-center gap-[11px] rounded-[10px] px-2.5 text-[13.5px] font-medium transition-colors',
  on ? 'lg-tint text-foreground' : 'text-foreground/85 hover:bg-foreground/5 hover:text-foreground');

export function Sidebar({ staff = false, photo }: { staff?: boolean; photo?: string }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const areas = useAreas();
  const { currentOrg, orgs } = useOrg();
  const { report, seen } = useSubTabs();
  const { area, tab } = locate(areas, pathname);
  const [mini, setMini] = useState(false);
  useEffect(() => { try { setMini(localStorage.getItem(MINI_KEY) === '1'); } catch { /* storage blocked */ } }, []);
  const toggle = () => setMini((m) => { try { localStorage.setItem(MINI_KEY, m ? '0' : '1'); } catch { /* storage blocked */ } return !m; });

  const subs = areas.filter((a) => a.business).sort((a, b) => Number(b.module === 'agency') - Number(a.module === 'agency'));
  // the sub-account in view: the open business, else the last one (the AI side and Settings keep the switcher on it)
  const [lastBiz, setLastBiz] = useState<string | null>(null);
  useEffect(() => { if (area.business) setLastBiz(area.key); }, [area]);
  const current = area.business ? area : subs.find((a) => a.key === lastBiz) ?? subs[0];
  const workspace = areas.filter((a) => AREA_ICONS[a.key]);
  // which page shows its sub-pages: the open one; clicking the open page's row folds it
  const [folded, setFolded] = useState<string | null>(null);
  useEffect(() => setFolded(null), [pathname]);

  // the Inbox (D, 2026-10-28: "that should be above overview"): owners and admins, with the count of unread things that need them,
  // read again every minute and on each page change (app/api/ai/inbox)
  const hasInbox = areas.some((a) => a.tabs.some((t) => t.href === '/ai/inbox'));
  const [inboxN, setInboxN] = useState(0);
  useEffect(() => {
    if (!hasInbox) return;
    let live = true;
    const read = () => fetch('/api/ai/inbox').then((r) => r.json()).then((j: { count?: number }) => { if (live) setInboxN(Number(j.count) || 0); }).catch(() => {});
    read();
    const t = setInterval(read, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [hasInbox, pathname]);

  const subsOf = (t: NavTab): { label: string; href: string; on: boolean }[] => {
    if (report && tab?.href === t.href) return report.items;
    return (seen[t.href.split('?')[0]] ?? []).map((x) => ({ ...x, on: false }));
  };
  const pageRow = (t: NavTab, icon: Icon | undefined, href: string, sub?: { label: string; href: string; on: boolean }[], active?: boolean) => {
    const on = active ?? tab?.href === t.href;
    const items = sub ?? subsOf(t);
    const open = on && items.length > 1 && folded !== t.href && !mini;
    const I = icon ?? IconLayoutDashboard;
    return (
      <div key={t.href}>
        <Tip show={mini} label={t.label}>
          <Link href={withOrg(href, currentOrg)} unstable_dynamicOnHover aria-current={on ? 'page' : undefined}
            onClick={(e) => { if (window.__fleetSplitNav?.(withOrg(href, currentOrg))) { e.preventDefault(); return; } if (on && items.length > 1 && !mini) { e.preventDefault(); setFolded(folded === t.href ? null : t.href); } }}
            className={cn(row(on), mini && 'h-[42px] justify-center px-0')}>
            <I size={19} stroke={1.7} className={cn('shrink-0', on ? 'text-foreground' : 'text-muted-foreground')} />
            {!mini && <span className="min-w-0 flex-1 truncate">{t.label}</span>}
            {!mini && items.length > 1 && <IconChevronRight size={14} stroke={2} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />}
          </Link>
        </Tip>
        {open && (
          <div className="mb-1.5 ml-[21px] mt-0.5 border-l border-border pl-3">
            {items.map((s) => (
              <Link key={s.href} href={withOrg(s.href, currentOrg)} scroll={false} aria-current={s.on ? 'page' : undefined}
                onClick={(e) => { if (window.__fleetSplitNav?.(withOrg(s.href, currentOrg))) e.preventDefault(); }}
                className={cn('relative flex h-8 items-center rounded-lg px-2.5 text-[13px] transition-colors',
                  s.on ? 'font-semibold text-foreground before:absolute before:-left-[13px] before:bottom-2 before:top-2 before:w-0.5 before:rounded before:bg-primary'
                    : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground')}>
                {s.label}
              </Link>
            ))}
          </div>
        )}
      </div>
    );
  };
  const section = (label: string) => mini
    ? <span className="mx-auto my-3 block h-px w-6 bg-border" />
    : <div className="px-2.5 pb-1.5 pt-3.5 font-mono text-[10px] uppercase tracking-[0.14em] text-label">{label}</div>;

  return (
    <nav aria-label="Pages" className={cn('relative flex h-full flex-col lg-side text-foreground/85 transition-[width] duration-200', mini ? 'w-[72px]' : 'w-[268px]')}>
      {current && <Switcher subs={subs} current={current} mini={mini} pathname={pathname} search={search} go={(h) => { if (!window.__fleetSplitNav?.(withOrg(h, currentOrg))) router.push(withOrg(h, currentOrg)); }} />}
      <div className="no-scrollbar flex-1 overflow-y-auto overscroll-contain px-2.5 pb-2.5">
        {area.key === 'SETTINGS' ? <>
          {/* Settings in the sidebar (D, 2026-10-09): its sections replace the pages while you are in it; Back returns to the sub-account */}
          <Tip show={mini} label={`Back to ${current?.name ?? 'the dashboard'}`}>
            <Link href={withOrg(current?.tabs[0]?.href ?? '/', currentOrg)} className={cn(row(false), 'mt-2', mini && 'h-[42px] justify-center px-0')}>
              <IconArrowLeft size={19} stroke={1.7} className="shrink-0 text-muted-foreground" />
              {!mini && <span className="min-w-0 flex-1 truncate">Back to {current?.name ?? 'the dashboard'}</span>}
            </Link>
          </Tip>
          {SETTINGS_GROUPS.map((g) => <div key={g}>{section(g)}{SETTINGS_SECTIONS.filter((x) => x.group === g).map(({ id, label, icon: I }) => {
            const tabNow = new URLSearchParams(search).get('tab') ?? 'ai';
            const on = pathname === '/settings' ? tabNow === id : pathname.startsWith(`/settings/${id}`);
            return (
              <div key={id}>
                <Tip show={mini} label={label}>
                  <Link href={`/settings?tab=${id}`} scroll={false} aria-current={on ? 'page' : undefined}
                    className={cn(row(on), mini && 'h-[42px] justify-center px-0')}>
                    <I size={19} stroke={1.7} className={cn('shrink-0', on ? 'text-foreground' : 'text-muted-foreground')} />
                    {!mini && <span className="min-w-0 flex-1 truncate">{label}</span>}
                  </Link>
                </Tip>
              </div>
            );
          })}</div>)}
        </> : <>
        {hasInbox && (
          <Tip show={mini} label={inboxN ? `Inbox, ${inboxN} need you` : 'Inbox'}>
            <Link href="/ai/inbox" aria-current={pathname === '/ai/inbox' ? 'page' : undefined}
              className={cn(row(pathname === '/ai/inbox'), 'relative mt-2', mini && 'h-[42px] justify-center px-0')}>
              <IconInbox size={19} stroke={1.7} className={cn('shrink-0', pathname === '/ai/inbox' ? 'text-foreground' : 'text-muted-foreground')} />
              {!mini && <span className="min-w-0 flex-1 truncate">Inbox</span>}
              {inboxN > 0 && (mini
                ? <span aria-label={`${inboxN} need you`} className="absolute right-3 top-2 size-2 rounded-full bg-[#C8102E]" />
                : <span aria-label={`${inboxN} need you`} className="min-w-5 rounded-full bg-[#C8102E] px-1.5 text-center text-[11px] font-semibold leading-5 text-white tabular-nums">{inboxN > 99 ? '99+' : inboxN}</span>)}
            </Link>
          </Tip>
        )}
        {current && <>
          {section(current.module === 'agency' ? 'Agency' : 'Sub-account')}
          {current.tabs.map((t) => pageRow(t, PAGE_ICONS[t.id ?? ''], t.href, area.business ? undefined : []))}
        </>}
        {workspace.length > 0 && section('Workspace')}
        {workspace.map((a) => pageRow({ label: a.name, href: a.tabs[0].href }, AREA_ICONS[a.key], a.tabs[0].href,
          a.tabs.filter((t) => t.href !== '/ai/inbox').map((t) => ({ label: t.label, href: t.href, on: tab?.href === t.href })), a.key === area.key && !!tab))}
        </>}
      </div>
      {/* inside the card, above the account (D, 2026-10-28: the round arrow sat over the sidebar's edge) */}
      <div className={cn('px-3 pb-1', mini && 'px-2')}>
        <button type="button" onClick={toggle} aria-label={mini ? 'Show the sidebar' : 'Hide the sidebar'} title={mini ? 'Show the sidebar' : 'Hide the sidebar'}
          className={cn('flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[13px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground', mini && 'justify-center px-0')}>
          {mini ? <IconLayoutSidebarLeftExpand size={18} stroke={1.8} /> : <IconLayoutSidebarLeftCollapse size={18} stroke={1.8} />}
          {!mini && <span>Hide sidebar</span>}
        </button>
      </div>
      <Account mini={mini} staff={staff} photo={photo} />
    </nav>
  );
}

function Switcher({ subs, current, mini, pathname, search, go }: { subs: Area[]; current: Area; mini: boolean; pathname: string; search: string; go: (href: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [kb, setKb] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useMemo(() => subs.filter((a) => a.name.toLowerCase().includes(q.trim().toLowerCase())), [subs, q]);
  const agencies = subs.filter((a) => a.module === 'agency').length;
  const views = useViews();
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); setOpen(true); } };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  const pick = (a: Area) => { setOpen(false); setQ(''); if (a.key !== current.key) go(sameTabHref(a, pathname, search)); };
  const kind = (a: Area) => a.module === 'agency' ? 'Agency · all sub-accounts' : a.module === 'sales' ? 'Sales' : a.module ? a.module[0].toUpperCase() + a.module.slice(1) : '';
  return (
    <div ref={box} className={cn('relative z-20', mini ? 'mx-auto mb-2 mt-3.5' : 'mx-3 mb-2 mt-3.5')}>
      <button type="button" onClick={() => { setOpen(!open); setKb(0); }} aria-haspopup="listbox" aria-expanded={open} title={mini ? current.name : undefined}
        className={cn('flex w-full items-center gap-2.5 rounded-xl text-left', mini ? 'p-1' : 'bg-foreground/[0.04] p-2 shadow-[inset_0_0_0_0.5px_var(--border)] hover:bg-foreground/[0.07]')}>
        <span className="grid size-[34px] shrink-0 place-items-center overflow-hidden rounded-[10px] bg-white font-heading text-xs font-semibold tracking-wide text-[#0E1422]">
          {current.logo ? <img src={current.logo} alt="" className="size-full object-cover" /> : current.mono}
        </span>
        {!mini && <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-foreground">{current.name}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground">{current.module === 'agency' ? `Agency · ${subs.length - agencies} sub-account${subs.length - agencies === 1 ? '' : 's'}` : `Sub-account · ${kind(current)}`}</span>
        </span>}
        {!mini && <IconSelector size={16} stroke={1.8} className="shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 top-[calc(100%+6px)] w-[300px] overflow-hidden rounded-[14px] lg-pop text-foreground">
          {views && <div className="border-b border-border p-2"><ViewSwitch onPick={() => setOpen(false)} /></div>}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <IconSearch size={16} stroke={1.8} className="text-label" />
            <input autoFocus value={q} placeholder="Find a sub-account" className="flex-1 bg-transparent text-[13.5px] outline-none"
              onChange={(e) => { setQ(e.target.value); setKb(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setKb((k) => Math.min(k + 1, list.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setKb((k) => Math.max(k - 1, 0)); }
                else if (e.key === 'Enter' && list[kb]) pick(list[kb]);
                else if (e.key === 'Escape') setOpen(false);
              }} />
          </div>
          <div className="max-h-[380px] overflow-auto p-1.5">
            {list.length === 0 && <div className="px-2 py-3 text-[12.5px] text-muted-foreground">No match</div>}
            {list.map((a, i) => (
              <button key={a.key} type="button" onClick={() => pick(a)} onMouseEnter={() => setKb(i)}
                className={cn('flex w-full items-center gap-2.5 rounded-[9px] px-2 py-[7px] text-left', i === kb && 'bg-inset', a.module === 'agency' && list[i + 1]?.module !== 'agency' && 'mb-1')}>
                <span className={cn('grid size-7 shrink-0 place-items-center overflow-hidden rounded-lg font-heading text-[10.5px] font-semibold text-white', a.logo ? 'bg-white ring-1 ring-border' : a.module === 'agency' ? 'bg-primary' : 'bg-rail')}>
                  {a.logo ? <img src={a.logo} alt="" loading="lazy" className="size-full object-cover" /> : a.mono}
                </span>
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold">{a.name}</span><span className="block truncate text-[11.5px] text-muted-foreground">{kind(a)}</span></span>
                {a.key === current.key && <IconCheck size={16} stroke={2.4} className="shrink-0 text-primary" />}
              </button>
            ))}
          </div>
          <div className="flex justify-between border-t border-border px-3 py-2 text-[12px] text-muted-foreground"><span>{subs.length - agencies} sub-accounts</span><span className="font-mono">⌘J</span></div>
        </div>
      )}
    </div>
  );
}

function Account({ mini, staff, photo }: { mini: boolean; staff: boolean; photo?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const areas = useAreas();
  const name = session?.user?.name ?? 'User';
  const email = session?.user?.email ?? '';
  const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'U';
  const settings = areas.some((a) => a.key === 'SETTINGS');
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  const mi = 'flex w-full items-center gap-[11px] rounded-lg px-2.5 py-2 text-left text-[14px] text-foreground/85 hover:bg-foreground/5 hover:text-foreground';
  return (
    <div ref={box} className="relative border-t border-border p-2.5">
      {open && (
        <div role="menu" className="absolute bottom-[calc(100%-4px)] left-2.5 z-30 w-[290px] rounded-[14px] lg-pop p-1.5 text-foreground">
          <div className="px-2.5 pb-1.5 pt-2 text-[13px] text-muted-foreground">{email || name}</div>
          <hr className="mx-1.5 my-1 border-border" />
          {settings && <Link href="/settings" onClick={() => setOpen(false)} className={mi}><IconSettings size={17} stroke={1.7} className="text-muted-foreground" />Settings</Link>}
          {settings && <Link href="/settings?tab=users" onClick={() => setOpen(false)} className={mi}><IconUsersGroup size={17} stroke={1.7} className="text-muted-foreground" />Users and access</Link>}
          <div className={mi}>
            <IconMoon size={17} stroke={1.7} className="text-muted-foreground" />Theme
            <span className="ml-auto flex rounded-[7px] bg-foreground/[0.06] p-0.5">
              {([['light', IconSun], ['dark', IconMoon], ['system', IconDeviceDesktop]] as const).map(([k, I]) => (
                <button key={k} type="button" aria-label={k} onClick={() => setTheme(k)}
                  className={cn('grid h-6 w-7 place-items-center rounded-[5px]', theme === k ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}><I size={13} stroke={1.8} /></button>
              ))}
            </span>
          </div>
          <hr className="mx-1.5 my-1 border-border" />
          <button type="button" onClick={() => signOut({ redirectTo: '/login' })} className={mi}><IconLogout size={17} stroke={1.7} className="text-muted-foreground" />Log out</button>
        </div>
      )}
      <button type="button" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title={mini ? name : undefined}
        className={cn('flex w-full items-center gap-2.5 rounded-[10px] p-1.5 text-left hover:bg-foreground/5', mini && 'justify-center')}>
        {photo ? <Face name={name} url={photo} size={32} /> : <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#8E8E93] text-xs font-semibold text-white">{initials}</span>}
        {!mini && <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-semibold text-foreground">{name}</span><span className="block truncate text-[11.5px] text-muted-foreground">Account and settings</span></span>}
      </button>
    </div>
  );
}
