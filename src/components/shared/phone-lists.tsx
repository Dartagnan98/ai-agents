'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { IconChevronRight, IconX } from '@tabler/icons-react';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';

// Phones (iOS look, D 2026-10-15: "lists" as rows like the iPhone's own apps, on every page): every wide table on the page (four or more
// columns) is drawn as a list of rows instead, and the table is kept in the page out of sight (search, sort and its links still run on
// it). A table that must stay a table opts out with data-phone-table on it or an ancestor. Desktop is untouched: this only runs on phones.
export function PhoneLists() {
  const pathname = usePathname();
  const [phone, setPhone] = useState(false);
  const [found, setFound] = useState<{ box: HTMLElement; t: HTMLTableElement; holder: HTMLElement }[]>([]);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const set = () => setPhone(mq.matches);
    set(); mq.addEventListener('change', set);
    return () => mq.removeEventListener('change', set);
  }, []);
  useEffect(() => {
    if (!phone) { setFound([]); return; }
    const main = document.querySelector('main');
    if (!main) return;
    const holders = new Map<HTMLTableElement, { box: HTMLElement; t: HTMLTableElement; holder: HTMLElement }>();
    let timer = 0;
    const scan = () => {
      for (const [t, x] of holders) if (!t.isConnected) { x.holder.remove(); x.box.classList.remove('phone-table-hidden'); holders.delete(t); }
      for (const t of main.querySelectorAll<HTMLTableElement>('table')) {
        if (holders.has(t) || t.closest('[data-phone-table],[data-phone-rows],[role=dialog]')) continue;
        const cols = t.querySelector('thead tr:last-child')?.children.length ?? t.rows[0]?.cells.length ?? 0;
        if (cols < 4) continue;
        // the box that scrolls the table sideways (or the table itself) is what the rows stand in for
        let box: HTMLElement = t;
        for (let el = t.parentElement; el && el !== main; el = el.parentElement) {
          if (/auto|scroll/.test(getComputedStyle(el).overflowX)) { box = el; break; }
          if (el.children.length > 1) break;
        }
        const holder = document.createElement('div');
        holder.setAttribute('data-phone-rows', '');
        box.parentElement?.insertBefore(holder, box);
        holders.set(t, { box, t, holder });
      }
      // re-render only when the set of lists changed (a new array every scan re-rendered every list on every page change)
      setFound((prev) => (prev.length === holders.size && prev.every((x) => holders.get(x.t) === x) ? prev : [...holders.values()]));
      // the boards' card layout (globals.css .phone-half / .phone-group): Medium number cards two by two, the ink card full width;
      // a card holding a list becomes a plain section with the list as its white group
      for (const k of main.querySelectorAll<HTMLElement>('[data-kpi]')) {
        const slot = k.parentElement;
        if (slot?.hasAttribute('data-slot')) slot.classList.toggle('phone-half', slot.className.includes('lg:col-span-2') && !k.classList.contains('ink-card'));
      }
      // the page's first number card is its headline, full width (the boards: Cash collected, the rep home's Cash you closed)
      // a number card's grid cell: its board slot, or the card itself in a plain grid (the rep portal is not a board)
      const unit = (k: Element) => (k.parentElement?.hasAttribute('data-slot') ? k.parentElement : k) as HTMLElement;
      const firstKpi = main.querySelector<HTMLElement>('[data-kpi]');
      const first = firstKpi ? unit(firstKpi) : null;
      main.querySelectorAll('.phone-full').forEach((e) => e.classList.remove('phone-full'));
      if (first) { first.classList.remove('phone-half'); first.classList.add('phone-full'); }
      // pairs only: in each run of half-width cards (made half above, or Small), an odd one out takes the whole row
      for (const grid of new Set([...main.querySelectorAll<HTMLElement>('[data-kpi]')].map((e) => unit(e).parentElement))) {
        let run: Element[] = [];
        const end = () => { if (run.length % 2) { const last = run[run.length - 1]; last.classList.remove('phone-half'); last.classList.add('phone-full'); } run = []; };
        for (const c of grid?.children ?? []) {
          const half = (c.hasAttribute('data-slot') || c.hasAttribute('data-kpi')) && !c.classList.contains('phone-full') && (c.classList.contains('phone-half') || !c.className.includes('col-span-full'));
          if (half) run.push(c); else end();
        }
        end();
      }
      for (const sec of main.querySelectorAll<HTMLElement>('section')) sec.classList.toggle('phone-group', !!sec.querySelector('[data-phone-rows]'));
    };
    scan();
    // the lists' own drawing (inside data-phone-rows) and the hidden tables' search/sort never start a scan
    const ours = (n: Node) => (n instanceof Element ? n : n.parentElement)?.closest('[data-phone-rows],.phone-table-hidden');
    const mo = new MutationObserver((recs) => {
      if (recs.every((r) => ours(r.target))) return;
      clearTimeout(timer); timer = window.setTimeout(scan, 200);
    });
    mo.observe(main, { subtree: true, childList: true });
    return () => {
      mo.disconnect(); clearTimeout(timer);
      for (const x of holders.values()) { x.holder.remove(); x.box.classList.remove('phone-table-hidden'); x.box.removeAttribute('aria-hidden'); }
      main.querySelectorAll('.phone-half').forEach((e) => e.classList.remove('phone-half'));
      main.querySelectorAll('.phone-group').forEach((e) => e.classList.remove('phone-group'));
      main.querySelectorAll('.phone-full').forEach((e) => e.classList.remove('phone-full'));
    };
  }, [phone, pathname]);
  return <>{found.map((x, i) => createPortal(<PhoneRows box={x.box} t={x.t} />, x.holder, String(i)))}</>;
}

interface Cell { head: string; text: string; el: HTMLElement | null }
interface Row { tr: HTMLTableRowElement; open: HTMLElement | null; title: string; sub: string; value: string; change: string; good: boolean; total: boolean }
const MONEYISH = /cash|amount|commission|comm\.|value|total|revenue|paid|owed|net|\$/i;
const LIMIT = 200;
const clean = (c: Element | undefined) => ((c as HTMLElement | undefined)?.innerText || '').replace(/\s+/g, ' ').trim();
const num = (x: string) => /^[−-]?\$?\s*[−-]?[\d,]*\.?\d+/.test(x.trim());
// textContent, not innerText: headers are drawn in capitals by CSS, the words themselves are "Zoom SR", "Cash"
const headsOf = (t: HTMLTableElement) => [...t.querySelectorAll<HTMLTableCellElement>('thead tr:last-child > th')].map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim());
/** Every column of one row, read only when its sheet opens. */
function cellsOf(t: HTMLTableElement, tr: HTMLTableRowElement): Cell[] {
  const heads = headsOf(t);
  return [...tr.cells].map((c, i) => ({ head: heads[i] ?? '', text: clean(c), el: c.querySelector<HTMLElement>('a[href],button') }));
}

// One table as iPhone rows: its first column the title, the next two the grey line, one number on the right (the sorted column, else the
// first money column, else the last number). Tapping a row opens a sheet with every column; a link or button in a cell still works from
// there (it clicks the table's own). Search, sort and new data flow through: the rows are read from the table when it changes.
// Phones (crash fix, 2026-10-15): only the rows on screen are read (up to 200), at most every 250 ms, and a row's other columns only when
// its sheet opens; reading every cell of every row on each change hung long lists like Contacts.
function PhoneRows({ box, t }: { box: HTMLElement; t: HTMLTableElement }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [open, setOpen] = useState<{ row: Row; cells: Cell[] } | null>(null);
  useEffect(() => {
    box.classList.add('phone-table-hidden'); box.setAttribute('aria-hidden', 'true');
    let timer = 0, alive = true;
    const read = () => {
      if (!alive) return;
      const heads = headsOf(t);
      const sorted = [...t.querySelectorAll<HTMLTableCellElement>('thead tr:last-child > th')].findIndex((h) => h.dataset.sort);
      const money = heads.findIndex((h, i) => i > 0 && MONEYISH.test(h));
      const body = [...t.querySelectorAll<HTMLTableRowElement>('tbody > tr')].filter((r) => r.style.display !== 'none' && r.cells.length > 1);
      // a row the desktop opens on click (its pointer cursor says so) opens that same pop-up straight from the list (one check per list)
      const clickable = body.length > 0 && getComputedStyle(body[0]).cursor === 'pointer';
      setTotal(body.length);
      setRows(body.slice(0, LIMIT).map((r) => {
        const cells = [...r.cells].slice(0, 8);
        const texts = cells.map(clean);
        // the number on the right: the sorted column, else a money column holding a $ amount, else any $ amount, else the last number
        let vi = sorted > 0 ? sorted : money > 0 && money < 8 && texts[money]?.includes('$') ? money : texts.findIndex((x, i) => i > 0 && /\$\s?[\d,]/.test(x));
        if (sorted > 7) texts[sorted] = clean(r.cells[sorted]);
        if (vi < 1 || !texts[vi]) vi = texts.map((x, i) => (i > 0 && num(x) ? i : -1)).filter((i) => i > 0).pop() ?? -1;
        // a bare number on the grey line says what it counts ("40 booked"); a change glued to the value goes under it
        const sub = texts.slice(1, 4).map((x, i) => ({ x, i: i + 1 })).filter(({ x, i }) => x && i !== vi && x !== '–' && x !== '-')
          .slice(0, 2).map(({ x, i }) => (/^[−-]?[\d,.]+%?$/.test(x) && heads[i] && heads[i].length <= 16 ? `${x} ${heads[i].toLowerCase()}` : x)).join(' · ');
        const [value, change = ''] = (vi > 0 ? texts[vi] : '').split(/\s+(?=[▲▼])/);
        // the table's own colour says whether the change is good (a rise in refunds is not)
        const good = vi > 0 ? !r.cells[vi]?.querySelector('.text-weak') : true;
        // a table can mark the name (data-phone-title) and a lead for the grey line (data-phone-pre), e.g. Team's tier before the closer
        const named = clean(r.querySelector('[data-phone-title]') ?? undefined), preEl = r.querySelector('[data-phone-pre]');
        const pre = preEl ? (preEl.children.length ? [...preEl.children].map(clean).filter(Boolean).join(' ') : clean(preEl)) : ''; // the table is hidden: join the parts with a space
        return { tr: r, open: clickable ? r.cells[0] : null, title: named || texts[0] || texts[1] || '–', sub: pre ? (sub ? `${pre} · ${sub}` : pre) : sub, value, change, good, total: /^(all |total)/i.test(texts[0] ?? '') };
      }));
    };
    const later = () => { clearTimeout(timer); timer = window.setTimeout(() => requestAnimationFrame(read), 250); };
    read();
    const mo = new MutationObserver(later);
    mo.observe(t, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style', 'data-sort'] });
    return () => { alive = false; clearTimeout(timer); mo.disconnect(); box.classList.remove('phone-table-hidden'); box.removeAttribute('aria-hidden'); };
  }, [box, t]);
  if (!rows.length) return <p className="rounded-[22px] bg-card px-4 py-5 text-center text-[15px] text-muted-foreground">Nothing in this list.</p>;
  const shown = rows;
  return (
    <div>
      <div className="overflow-hidden rounded-[22px] bg-card">
        {shown.map((r, i) => (
          <button key={i} type="button" onClick={() => (r.open ? r.open.click() : setOpen({ row: r, cells: cellsOf(t, r.tr) }))}
            className={`flex min-h-[58px] w-full items-center gap-3 px-4 py-2 text-left ${i > 0 ? 'border-t border-[rgba(60,60,67,0.12)] dark:border-white/10' : ''}`}>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-[17px] ${r.total ? 'font-semibold' : ''}`}>{r.title}</span>
              {r.sub && <span className="block truncate text-[13px] text-muted-foreground">{r.sub}</span>}
            </span>
            {r.value && <span className="flex shrink-0 flex-col items-end">
              <span className="text-[17px] font-semibold tabular-nums">{r.value}</span>
              {r.change && <span className={`text-[12px] font-medium tabular-nums ${r.good ? 'text-healthy' : 'text-weak'}`}>{r.change}</span>}
            </span>}
            <IconChevronRight size={14} stroke={2.6} className="shrink-0 text-[#A3A3A8]" />
          </button>
        ))}
      </div>
      {total > LIMIT && <p className="mt-2 px-4 text-[13px] text-muted-foreground">Showing {LIMIT} of {total}. Search to narrow it down.</p>}
      <Sheet open={!!open} onOpenChange={(o) => { if (!o) setOpen(null); }}>
        <SheetContent side="bottom" showCloseButton={false} className="max-h-[88dvh] gap-0 rounded-t-[28px] border-0 bg-canvas p-0 md:hidden">
          <div className="shrink-0 px-4">
            <span className="mx-auto mt-2 block h-[5px] w-9 rounded-full bg-[#D5DAE4] dark:bg-white/20" aria-hidden />
            <div className="-mr-1.5 ml-1 mt-0.5 flex min-h-11 items-center justify-between gap-2">
              <SheetTitle className="truncate text-xl font-bold tracking-[-0.02em]">{open?.row.title}</SheetTitle>
              <SheetClose aria-label="Close" className="flex size-11 shrink-0 items-center justify-center">
                <span className="flex size-8 items-center justify-center rounded-full bg-muted text-foreground"><IconX size={16} stroke={2} /></span>
              </SheetClose>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,calc(env(safe-area-inset-bottom)+12px))]">
            <div className="mt-2 overflow-hidden rounded-[22px] bg-card">
              {open?.cells.slice(1).filter((c) => c.text || c.el).map((c, i) => {
                const line = <><span className="shrink-0 text-muted-foreground">{c.head || '–'}</span><span className="min-w-0 flex-1 text-right font-medium tabular-nums">{c.text || 'Open'}</span></>;
                const cls = `flex min-h-12 w-full items-center gap-4 px-4 py-2.5 text-left text-[16px] ${i > 0 ? 'border-t border-[rgba(60,60,67,0.12)] dark:border-white/10' : ''}`;
                return c.el
                  ? <button key={i} type="button" className={`${cls} text-cobalt`} onClick={() => { const el = c.el; setOpen(null); setTimeout(() => el?.click(), 250); }}>{line}<IconChevronRight size={14} stroke={2.6} className="shrink-0" /></button>
                  : <div key={i} className={cls}>{line}</div>;
              })}
              {open?.row.open && !open.cells[0]?.el && (
                <button type="button" className="flex h-12 w-full items-center justify-center border-t border-[rgba(60,60,67,0.12)] text-[16px] font-semibold text-cobalt dark:border-white/10"
                  onClick={() => { const el = open.row.open; setOpen(null); setTimeout(() => el?.click(), 250); }}>More details</button>
              )}
              {open?.cells[0]?.el && (
                <button type="button" className="flex h-12 w-full items-center justify-center border-t border-[rgba(60,60,67,0.12)] text-[16px] font-semibold text-cobalt dark:border-white/10"
                  onClick={() => { const el = open.cells[0].el; setOpen(null); setTimeout(() => el?.click(), 250); }}>Open {open.row.title}</button>
              )}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
