'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { locate, withOrg } from '@/lib/nav';
import { useAreas } from '@/hooks/use-areas';
import { useOrg } from '@/hooks/use-org';

// Phones: swipe sideways on a business tab for its next or previous tab (D, 2026-10-02: "swiping within would be nice";
// switching businesses stays a tap on the bottom bar). Lands where a tap on that tab would. Left alone: a swipe that starts
// on something that scrolls sideways (tables, the range buttons), on a chart (a drag there reads the chart), in a form
// field or a dialog, near the screen edge (the browser's and the phone's own back gesture), and pages under a tab
// (an invoice, setup).
const NO_SWIPE = 'input, select, textarea, [contenteditable], dialog, [role="dialog"], [data-no-swipe], .recharts-wrapper';
const EDGE = 24, TRIGGER = 70;

/** True when the touch starts on something that should keep the sideways drag for itself. */
function keepsDrag(target: Element | null, main: Element): boolean {
  for (let el = target; el && el !== main; el = el.parentElement) {
    if (el.matches(NO_SWIPE)) return true;
    if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

export function SwipeTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const areas = useAreas();
  const { currentOrg } = useOrg();
  const { area, tab } = locate(areas, pathname);
  const i = area.business && tab?.href === pathname ? area.tabs.findIndex((t) => t.href === tab.href) : -1;
  const prev = i > 0 ? area.tabs[i - 1] : null;
  const next = i >= 0 && i < area.tabs.length - 1 ? area.tabs[i + 1] : null;
  const prevHref = prev ? withOrg(prev.href, currentOrg) : null, nextHref = next ? withOrg(next.href, currentOrg) : null;
  const prevLabel = prev?.label ?? '', nextLabel = next?.label ?? '';
  // the neighbours are fetched in full once the page is up, so a swipe is instant
  // (perf audit 2026-10-15) neighbours are no longer fetched in full on every page view; a swipe loads like a tap
  const hint = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!prevHref && !nextHref) return;
    let start: { x: number; y: number } | null = null;
    let sideways = false;
    const show = (dx: number) => {
      const el = hint.current;
      if (!el) return;
      const label = dx < 0 ? nextLabel : prevLabel;
      if (!sideways || !label || Math.abs(dx) < 24) { el.style.opacity = '0'; return; }
      el.textContent = dx < 0 ? `${label} ›` : `‹ ${label}`;
      el.style.left = dx < 0 ? '' : '16px';
      el.style.right = dx < 0 ? '16px' : '';
      el.style.opacity = String(Math.min(1, Math.abs(dx) / TRIGGER));
      el.dataset.ready = Math.abs(dx) >= TRIGGER ? '1' : '';
    };
    const onStart = (e: TouchEvent) => {
      start = null; sideways = false;
      const main = (e.target as Element | null)?.closest?.('main');
      if (!main || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) return;
      if (keepsDrag(e.target as Element, main) || document.querySelector('dialog[open]')) return;
      start = { x: t.clientX, y: t.clientY };
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const t = e.touches[0], dx = t.clientX - start.x, dy = t.clientY - start.y;
      if (!sideways) {
        if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { start = null; return; } // a scroll
        if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) sideways = true;
      }
      show(dx);
    };
    const onEnd = (e: TouchEvent) => {
      const s = start, wasSideways = sideways;
      start = null; sideways = false;
      if (hint.current) hint.current.style.opacity = '0';
      if (!s || !wasSideways || e.type === 'touchcancel') return;
      const t = e.changedTouches[0], dx = t.clientX - s.x, dy = t.clientY - s.y;
      if (Math.abs(dx) < TRIGGER || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const to = dx < 0 ? nextHref : prevHref;
      if (to) router.push(to);
    };
    const opts = { passive: true } as const;
    document.addEventListener('touchstart', onStart, opts);
    document.addEventListener('touchmove', onMove, opts);
    document.addEventListener('touchend', onEnd, opts);
    document.addEventListener('touchcancel', onEnd, opts);
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [router, prevHref, nextHref, prevLabel, nextLabel]);

  return (
    <div ref={hint} aria-hidden
      className="pointer-events-none fixed top-1/2 z-50 -translate-y-1/2 rounded-full bg-foreground px-4 py-2 text-[13.5px] font-semibold text-background opacity-0 shadow-lg transition-[opacity,background-color] duration-100 data-[ready=1]:bg-primary data-[ready=1]:text-primary-foreground print:hidden" />
  );
}
