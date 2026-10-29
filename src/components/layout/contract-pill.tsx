'use client';

import { useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { IconCheck, IconChevronDown, IconX } from '@tabler/icons-react';
import { AppLink as Link } from '@/components/shared/app-link';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAreas, useViews } from '@/hooks/use-areas';
import { useOrg } from '@/hooks/use-org';
import { homeArea } from '@/lib/access';
import { locate, sameTabHref, withOrg, type Area } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { usePrefetchAll } from '@/components/shared/prefetch';

const Badge = ({ a, size = 32 }: { a: Area; size?: number }) => a.logo
  // eslint-disable-next-line @next/next/no-img-element
  ? <img src={a.logo} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  : <span className="grid shrink-0 place-items-center rounded-full bg-cobalt text-[12px] font-bold text-white" style={{ width: size, height: size }}>{a.mono}</span>;

/** Team view / User view (D, 2026-10-20: a manager who also closes taps the pill for their own portal). */
export function ViewSwitch({ onPick }: { onPick?: () => void }) {
  const views = useViews();
  const { currentOrg } = useOrg();
  if (!views) return null;
  return (
    <div role="tablist" aria-label="View" className="grid grid-cols-2 gap-1 rounded-[12px] bg-muted p-1">
      {([['team', 'Team view'], ['me', 'User view']] as const).map(([k, label]) => (
        <Link key={k} href={withOrg(views[k], currentOrg)} onClick={onPick} role="tab" aria-selected={views.on === k}
          className={cn('flex h-9 items-center justify-center rounded-[9px] text-[14px] font-semibold', views.on === k ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}>
          {label}
        </Link>
      ))}
    </div>
  );
}

// Phone contract switcher (D 2026-10-15: the contract bar at the bottom "is going to get messy" with more contracts): the pill at the
// top left names the contract you are in; tapping it lists every contract and the agency, and picking one keeps the page and range.
export function ContractPill() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const { currentOrg } = useOrg();
  const areas = useAreas();
  const views = useViews();
  const [open, setOpen] = useState(false);
  const { area } = locate(areas, pathname);
  const home = homeArea(areas);
  const businesses = areas.filter((a) => a.business && a.tabs.length);
  const list = [...(home?.business ? [home] : []), ...businesses.filter((b) => b.key !== home?.key)];
  // speed (D 2026-10-15: "super slow" to switch): opening the list loads each contract's same page in the background, so the tap lands
  // on a page that is already there (kept 2 minutes by the client router cache, next.config.ts staleTimes)
  usePrefetchAll(open ? list.filter((b) => b.key !== area.key).map((b) => withOrg(sameTabHref(b, pathname, search), currentOrg)) : []);
  if (!list.length) return <span className="truncate text-[17px] font-semibold">{area.name}</span>;
  const pick = list.length > 1 || !!views;
  const face = (
    <>
      {area.business ? <Badge a={area} /> : null}
      <span className={cn('max-w-[150px] truncate text-base font-semibold', !area.business && 'pl-2')}>{area.business ? area.short : area.name}</span>
      {pick && <IconChevronDown size={14} stroke={2.6} className="shrink-0" />}
    </>
  );
  const pillCls = 'glass-pill flex h-11 min-w-0 items-center gap-2 rounded-full pl-1.5 pr-3.5 text-foreground';
  if (!pick) return <span className={pillCls}>{face}</span>;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`Contract: ${area.name}. Switch`} className={pillCls}>{face}</button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" showCloseButton={false} className="max-h-[80dvh] gap-0 rounded-t-[28px] border-0 bg-canvas p-0 md:hidden">
          <div className="shrink-0 px-4">
            <span className="mx-auto mt-2 block h-[5px] w-9 rounded-full bg-[#D5DAE4] dark:bg-white/20" aria-hidden />
            <div className="-mr-1.5 ml-1 mt-0.5 flex h-11 items-center justify-between">
              <SheetTitle className="text-xl font-bold tracking-[-0.02em]">{views ? 'Switch' : 'Contracts'}</SheetTitle>
              <SheetClose aria-label="Close" className="flex size-11 items-center justify-center">
                <span className="flex size-8 items-center justify-center rounded-full bg-muted text-foreground"><IconX size={16} stroke={2} /></span>
              </SheetClose>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,calc(env(safe-area-inset-bottom)+12px))]">
            {views && <div className="mt-2"><ViewSwitch onPick={() => setOpen(false)} /></div>}
            {list.length > 1 && <>
            <div className="mt-2 overflow-hidden rounded-[22px] bg-card">
              {list.map((b, i) => {
                const on = b.key === area.key;
                return (
                  <Link key={b.key} href={withOrg(sameTabHref(b, pathname, search), currentOrg)} onClick={() => setOpen(false)} aria-current={on ? 'page' : undefined}
                    className={cn('flex h-[58px] items-center gap-3 px-4', i > 0 && 'border-t border-[rgba(60,60,67,0.12)] dark:border-white/10')}>
                    <Badge a={b} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[17px]">{b.name}</span>
                      {b.module === 'agency' && <span className="block text-[13px] text-muted-foreground">Agency, every contract</span>}
                    </span>
                    {on && <IconCheck size={18} stroke={2.4} className="text-cobalt" />}
                  </Link>
                );
              })}
            </div>
            <p className="mx-4 mt-2 text-[13px] text-muted-foreground">You stay on the same page and dates.</p>
            </>}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
