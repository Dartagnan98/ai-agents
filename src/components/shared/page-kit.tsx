import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { GrowValue, SectionShell, TileLabel, TileShell } from './tile';

// Porcelain Signal page kit (2026-09-29): the pieces every page is built from, so pages stay
// consistent. Server components, no client JS. Colours come from the tokens in globals.css.

/** Title row (Sora 30) with page controls on the right, then the answer line and filters. */
/** `purpose`: one quiet line under the title saying what the page is for. `part`: a part of a longer page (Money, Calls ...):
 *  the title is a section heading, not the page's, and `id` makes it a link target (#payment-plans). */
export function PageHeader({ title, answer, actions, filters, className, purpose, part, id }: {
  title: ReactNode; answer?: ReactNode; actions?: ReactNode; filters?: ReactNode; className?: string; purpose?: ReactNode; part?: boolean; id?: string;
}) {
  return (
    <div id={id} className={cn('flex flex-col gap-4', part && 'scroll-mt-24 border-t border-hairline pt-6', className)}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          {part
            ? <h2 className="font-heading text-[21px] font-semibold leading-tight tracking-[-0.02em] md:text-[23px]">{title}</h2>
            : <h1 className="font-heading text-[26px] font-semibold leading-tight tracking-[-0.02em] md:text-[30px]">{title}</h1>}
          {purpose && <p className="max-w-[860px] text-[13.5px] leading-snug text-muted-foreground max-md:hidden">{purpose}</p>}
        </div>
        {/* phones (the boards): the date chip sits here, beside the title (components/sales/range-sheet.tsx moves it in) */}
        {!part && <span data-phone-title-slot="" className="flex items-center md:hidden" />}
        {part ? actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>
          : <div className="flex flex-wrap items-center gap-2 empty:hidden">{actions}</div>}
      </div>
      {/* phones: the page's part chips move here, under the title (components/shared/phone-slot.tsx) */}
      {!part && <div data-phone-parts-slot="" className="empty:hidden md:hidden" />}
      {(answer || filters) && (
        <div className="flex flex-wrap items-center justify-between gap-3 has-[[data-toolbar=row]]:flex-col has-[[data-toolbar=row]]:items-start">
          {answer && <p className="max-w-[860px] font-heading text-[17px] font-medium leading-snug tracking-[-0.01em] max-md:hidden md:text-[19px]">{answer}</p>}
          {filters && <div className="flex flex-wrap items-center gap-2 has-[[data-toolbar=row]]:w-full">{filters}</div>}
        </div>
      )}
    </div>
  );
}

/** The answer line + filters row on its own (for pages whose answer needs data loaded below the title). */
export function AnswerRow({ answer, filters }: { answer?: ReactNode; filters?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 has-[[data-toolbar=row]]:flex-col has-[[data-toolbar=row]]:items-start">
      {answer && <p className="max-w-[860px] font-heading text-[17px] font-medium leading-snug tracking-[-0.01em] max-md:hidden md:text-[19px]">{answer}</p>}
      {filters && <div className="flex flex-wrap items-center gap-2 has-[[data-toolbar=row]]:w-full">{filters}</div>}
    </div>
  );
}

/** Grey tail of an answer line: <Answer>6.0% book. <Quiet>Most leave at Claim.</Quiet></Answer> */
export const Quiet = ({ children }: { children: ReactNode }) => <span className="text-label">{children}</span>;

export function Spark({ values, width = 90, height = 24, color = 'var(--cobalt)', className }: { values: number[]; width?: number; height?: number; color?: string; className?: string }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * (width - 4) + 2).toFixed(1)} ${(height - 2 - ((v - lo) / (hi - lo || 1)) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden>
      <path d={d} stroke={color} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** ▲ 12% / ▼ 3.1 pts in mono; `good` decides the colour (a drop in cancels is good). */
export function Delta({ text, good, suffix }: { text: string; good: boolean; suffix?: string }) {
  return (
    <span className={cn('font-mono text-[12px]', good ? 'text-healthy' : 'text-weak')}>
      {text}{suffix && <span className="font-sans text-label"> {suffix}</span>}
    </span>
  );
}

/** Change between two values as a Delta ('▲ 12%'); null when there is no previous value. */
export function pctDelta(now: number, prev: number | null | undefined, higherIsGood = true) {
  if (prev == null || !Number.isFinite(prev) || prev === 0) return null;
  const r = (now - prev) / Math.abs(prev);
  return { text: `${r >= 0 ? '▲' : '▼'} ${Math.abs(r * 100).toFixed(Math.abs(r) < 0.1 ? 1 : 0)}%`, good: higherIsGood ? r >= 0 : r <= 0 };
}

/** Change between two rates as points ('▲ 1.2 pts'); null when there is no previous rate. A rise in cancels is bad: pass higherIsGood=false. */
export function ptsDelta(now: number, prev: number | null | undefined, higherIsGood = true) {
  if (prev == null || !Number.isFinite(prev)) return null;
  const d = now - prev;
  return { text: `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} pts`, good: higherIsGood ? d >= 0 : d <= 0 };
}

export type Tone = 'healthy' | 'watch' | 'weak' | 'info' | 'neutral' | 'outline';
const TONE: Record<Tone, string> = {
  healthy: 'bg-healthy-bg text-healthy', watch: 'bg-watch-bg text-watch', weak: 'bg-weak-bg text-weak',
  info: 'bg-accent text-accent-foreground', neutral: 'bg-secondary text-foreground', outline: 'border border-border bg-card text-muted-foreground',
};
const DOT: Partial<Record<Tone, string>> = { healthy: 'bg-[#0B8F6A]', watch: 'bg-[#E8A317]', weak: 'bg-[#C8102E]', info: 'bg-primary' };

/** Status pill; `dot` adds the health dot. Health tones always come with a word. */
export function Pill({ tone = 'neutral', dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-semibold', TONE[tone], className)}>
      {dot && DOT[tone] && <span className={cn('size-1.5 rounded-full', DOT[tone])} />}
      {children}
    </span>
  );
}

export function LiveChip({ label = 'LIVE' }: { label?: string }) {
  return (
    <span className="flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3.5 font-mono text-[11.5px] tracking-wide text-muted-foreground">
      <span className="size-[7px] rounded-full bg-[#0B8F6A] shadow-[0_0_0_3px_rgba(11,143,106,0.16)]" />
      {label}
    </span>
  );
}

/** Phones (2026-10-02): a long text value steps its size down so it fits a half-width tile ("$279,072" showed as
 *  "$279,0…" at 375 px); a long name ("Jonathan Migneault") wraps at its spaces instead. Short values keep the
 *  full size; sm and up are unchanged. */
const phoneFit = (v: ReactNode) => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
  if (s.length >= 8 && /\s/.test(s)) return 'max-sm:whitespace-normal max-sm:text-[20px] max-sm:leading-[1.15]';
  const n = s.length;
  return n >= 11 ? 'max-sm:text-[18px]' : n >= 10 ? 'max-sm:text-[20px]' : n >= 9 ? 'max-sm:text-[22px]' : n >= 8 ? 'max-sm:text-[24px]' : '';
};

/** KPI tile: mono label, big Sora value, optional delta + sparkline, sub-line. */
// The ink highlight card (D, 2026-10-02: "dark cards all over the app, like the AI home"). The `dark` class switches
// the app's dark-theme colours on inside the card, so labels, deltas, pills, bars and charts all follow; paper stays light.

export function KpiTile({ label, value, sub, delta, spark, tone, className, how, dark }: {
  label: ReactNode;
  /** Card boards (lib/cards): this card's stable name when its label changes with the data or gets reworded (its id keeps this). */
  card?: string; value: ReactNode; sub?: ReactNode; delta?: { text: string; good: boolean; suffix?: string } | null;
  spark?: number[]; tone?: 'healthy' | 'watch' | 'weak'; className?: string;
  /** The ink highlight card (like the AI home's): a page's headline number. */
  dark?: boolean;
  /** Hover / focus help: how the number is counted (and the previous value, if the caller adds it). */
  how?: ReactNode;
}) {
  return (
    <TileShell dark={dark} tabIndex={how ? 0 : undefined} className={cn('lg-card @container relative flex min-w-0 flex-col gap-2 rounded-[20px] bg-card px-5 py-[18px] shadow-[var(--card-shadow)]', how && 'group outline-none transition-shadow hover:shadow-[0_0_0_1.5px_var(--primary),var(--card-shadow)] focus-visible:shadow-[0_0_0_1.5px_var(--primary),var(--card-shadow)]', className)}>
      {how && (
        <div role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+8px)] [[data-tips-below]_&]:bottom-auto [[data-tips-below]_&]:top-[calc(100%+8px)] left-1/2 z-40 hidden w-64 -translate-x-1/2 rounded-xl bg-foreground px-3 py-2.5 text-[12px] leading-relaxed text-background shadow-lg group-hover:block group-focus-visible:block">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-wider opacity-70">How it is counted</div>
          {how}
        </div>
      )}
      <span className="micro-label line-clamp-2"><TileLabel>{label}</TileLabel></span>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <GrowValue chars={typeof value === 'string' || typeof value === 'number' ? String(value).trim().length : 6} className={cn('truncate font-heading font-semibold leading-none tracking-[-0.02em] tabular-nums', phoneFit(value))}>{value}</GrowValue>
        {tone && <Pill tone={tone} dot>{tone === 'healthy' ? 'Healthy' : tone === 'watch' ? 'Watch' : 'Not healthy'}</Pill>}
      </div>
      {(delta || spark) && (
        <div className="flex items-center justify-between gap-2">
          {delta ? <Delta {...delta} /> : <span />}
          {spark && <Spark values={spark} />}
        </div>
      )}
      {sub && <span className="text-[12.5px] leading-snug text-muted-foreground">{sub}</span>}
    </TileShell>
  );
}

/** Responsive KPI grid: 2 columns on phones, `cols` on desktop. */
export function KpiGrid({ cols = 4, children, className, title }: { cols?: 3 | 4 | 5 | 6; children: ReactNode; className?: string; title?: string }) {
  const lg = { 3: 'md:grid-cols-3', 4: 'md:grid-cols-2 lg:grid-cols-4', 5: 'md:grid-cols-3 xl:grid-cols-5', 6: 'md:grid-cols-3 xl:grid-cols-6' }[cols];
  const cls = cn('grid grid-cols-2 gap-3 md:gap-5', lg, className);
  return <>{title && <span className="micro-label">{title}</span>}<div className={cls}>{children}</div></>;
}

/** Card section: title + description + right-side actions, then content. `hero` adds the cobalt corner ticks. */
export function Section({ title, eyebrow, description, actions, hero, flush, dark, children, className }: {
  title?: ReactNode; eyebrow?: ReactNode; description?: ReactNode; actions?: ReactNode; hero?: boolean; flush?: boolean; children: ReactNode; className?: string;
  /** The ink highlight card (like the AI home's); a few per page (D, 2026-10-02). */
  dark?: boolean;
}) {
  return (
    <SectionShell dark={dark} className={cn('lg-card relative flex min-w-0 flex-col gap-4 bg-card shadow-[var(--card-shadow)]', hero ? 'rounded-[24px] py-7' : 'rounded-[22px] py-6', className)}>
      {(title || actions || eyebrow) && (
        <div className="flex flex-wrap items-start justify-between gap-3 px-6 md:px-7">
          <div className="flex min-w-0 flex-col gap-1">
            {eyebrow && <span className="micro-label">{eyebrow}</span>}
            {title && <h2 className="text-[15px] font-semibold leading-snug">{title}</h2>}
            {description && <p className="max-w-[80ch] text-[13px] leading-relaxed text-muted-foreground max-md:hidden">{description}</p>}
            {/* phones: the explanation folds away under one line, so the list starts near the top (iOS look, 2026-10-15) */}
            {description && <details className="group text-[13px] leading-relaxed text-muted-foreground md:hidden">
              <summary className="cursor-pointer list-none font-semibold text-cobalt [&::-webkit-details-marker]:hidden">How this is counted</summary>
              <p className="mt-1">{description}</p>
            </details>}
          </div>
          {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn('min-w-0', !flush && 'px-6 md:px-7')}>{children}</div>
    </SectionShell>
  );
}

/** Quiet inset stat: big number + label. */
export function InsetStat({ value, label, tone }: { value: ReactNode; label: ReactNode; tone?: 'weak' | 'healthy' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-2xl bg-inset px-4 py-3">
      <span className={cn('font-heading text-[22px] font-semibold tabular-nums', tone === 'weak' && 'text-weak', tone === 'healthy' && 'text-healthy')}>{value}</span>
      <span className="text-[12px] text-muted-foreground">{label}</span>
    </div>
  );
}

/** Alert bar (the funnel's "Biggest leak"): tinted, icon, one sentence. */
export function AlertBar({ tone = 'weak', children }: { tone?: 'weak' | 'watch' | 'healthy' | 'info'; children: ReactNode }) {
  const bg = { weak: 'bg-[#FDF1F1] dark:bg-weak-bg', watch: 'bg-[#FFF8E6] dark:bg-watch-bg', healthy: 'bg-[#ECFDF5] dark:bg-healthy-bg', info: 'bg-accent' }[tone];
  const fg = { weak: 'text-weak', watch: 'text-watch', healthy: 'text-healthy', info: 'text-accent-foreground' }[tone];
  return (
    <div className={cn('flex items-start gap-3 rounded-2xl px-4 py-3.5 text-[13.5px]', bg)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cn('mt-px shrink-0', fg)} aria-hidden>
        <path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Dashed empty / setup state: why it's empty and the one next step. */
export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[22px] border border-dashed border-[#D5DAE4] bg-card/60 px-6 py-6 dark:border-border">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground" aria-hidden>
        <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" /><path d="M12 8v4" /><path d="M12 16h.01" />
      </svg>
      <span className="text-[14px] font-semibold">{title}</span>
      {children && <div className="max-w-[70ch] text-[13px] text-muted-foreground">{children}</div>}
      {action}
    </div>
  );
}

/** Horizontal share bar row: label, track, value. Phones stack it (label and value on one line, the bar full width
 *  under them): side by side, the label column took every pixel and the bar shrank to nothing. */
export function BarRow({ label, value, share, tone = 'cobalt', sub }: { label: ReactNode; value: ReactNode; share: number; tone?: 'cobalt' | 'healthy' | 'watch' | 'weak' | 'muted'; sub?: ReactNode }) {
  const fill = { cobalt: 'bg-primary', healthy: 'bg-[#0B8F6A]', watch: 'bg-[#E8A317]', weak: 'bg-[#C8102E]', muted: 'bg-[#C9D1E6] dark:bg-border' }[tone];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_fit-content(40%)] items-center gap-x-3 gap-y-1.5 text-[13px] sm:grid-cols-[minmax(0,160px)_minmax(0,1fr)_auto]">
      <span className="min-w-0 break-words sm:truncate">{label}</span>
      <span className="col-span-2 row-start-2 h-2.5 overflow-hidden rounded-full bg-secondary sm:col-span-1 sm:row-start-auto sm:h-2"><span className={cn('block h-full rounded-full', fill)} style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} /></span>
      <span className="text-right font-mono text-[12.5px] tabular-nums">{value}{sub && <span className="ml-1.5 hidden text-label sm:inline-block">{sub}</span>}</span>
      {/* phones: the note gets its own line under the bar instead of wrapping beside the number (D, 2026-10-02) */}
      {sub && <span className="col-span-2 row-start-3 font-mono text-[11.5px] text-label sm:hidden">{sub}</span>}
    </div>
  );
}
