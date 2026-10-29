'use client';

import { Fragment, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { ctrlView, fmtCell, num, parseBlocks, parseInline, safeHref, stripMd, type Action, type Block, type RecordCard, type TableCol } from './blocks';
import './ai.css';

// A the agents reply as blocks (D, 2026-10-09), ported from agent RichText (G14): markdown (headings, lists, quotes, rules,
// sortable pipe tables, fenced code with Copy) plus the ctrl-table / ctrl-chart / ctrl-cards / ctrl-actions views (parsers in
// blocks.ts). In-app links open in Fleet (in a split, in the pane in focus); outside links open a new tab.

const RichChart = dynamic(() => import('./rich-chart'), {
  ssr: false,
  loading: () => <div className="fai-rich-wait"><span className="fai-shimmer">Drawing chart...</span></div>,
});

/** Opens an in-app path the way the sidebar does: the pane in focus in a split, else this tab. */
function useGo() {
  const router = useRouter();
  return (href: string) => (e: MouseEvent) => {
    if (/^https?:/.test(href) || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (!window.__fleetSplitNav?.(href)) router.push(href);
  };
}

function Link({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const go = useGo();
  const ext = /^https?:/.test(href);
  return <a className={className} href={href} onClick={go(href)} {...(ext ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{children}</a>;
}

function Inline({ text }: { text: string }) {
  return <>{parseInline(text).map((p, i) => {
    if (p.t === 'b') return <strong key={i}>{p.s}</strong>;
    if (p.t === 'i') return <em key={i}>{p.s}</em>;
    if (p.t === 'code') return <code key={i}>{p.s}</code>;
    if (p.t === 'link') return <Link key={i} href={p.href}>{p.s}</Link>;
    return <Fragment key={i}>{p.s}</Fragment>;
  })}</>;
}

/** Copy to the clipboard; "Copied" for a moment after. */
export function CopyButton({ text, label = 'Copy', className = 'fai-mini', children }: { text: string | (() => string); label?: string; className?: string; children?: (done: boolean) => ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={className} aria-label={label} title={done ? 'Copied' : label}
      onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(typeof text === 'function' ? text() : text).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1400); }).catch(() => {}); }}>
      {children ? children(done) : done ? 'Copied' : label}
    </button>
  );
}

// ─── Sortable table ───

function SortTable({ cols, rows, title, markdown }: { cols: TableCol[]; rows: unknown[][]; title?: string; markdown?: boolean }) {
  const [sort, setSort] = useState<{ i: number; dir: 1 | -1 } | null>(null);
  const numeric = useMemo(() => cols.map((c, i) => (c.type && c.type !== 'text' && c.type !== 'date' ? true
    : rows.length > 0 && rows.every((r) => r[i] == null || r[i] === '' || num(stripMd(r[i])) != null) && rows.some((r) => num(stripMd(r[i])) != null))), [cols, rows]);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const { i, dir } = sort;
    return [...rows].sort((a, b) => {
      const x = stripMd(a[i]), y = stripMd(b[i]);
      if (numeric[i]) return ((num(x) ?? -Infinity) - (num(y) ?? -Infinity)) * dir;
      return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true, sensitivity: 'base' }) * dir;
    });
  }, [rows, sort, numeric]);
  const copy = () => [cols.map((c) => c.label).join('\t'), ...sorted.map((r) => r.map((v, i) => (markdown ? stripMd(v) ?? '' : fmtCell(v, cols[i]?.type))).join('\t'))].join('\n');
  return (
    <div className="fai-rich">
      <div className="fai-rich-h">
        <span className="t">{title || `${rows.length} row${rows.length === 1 ? '' : 's'}`}</span>
        <CopyButton text={copy} />
      </div>
      <div className="fai-tbl-scroll">
        <table className="fai-tbl">
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={`${c.key}-${i}`} className={numeric[i] ? 'n' : undefined} aria-sort={sort?.i === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" onClick={() => setSort((s) => (s?.i === i ? (s.dir === 1 ? { i, dir: -1 } : null) : { i, dir: 1 }))}>
                    <span>{c.label}</span>
                    <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true" className={sort?.i === i ? 'on' : ''}>
                      <path d="M4 1L1.5 4h5L4 1z" fill="currentColor" opacity={sort?.i === i && sort.dir === -1 ? 0.3 : 1} />
                      <path d="M4 9L1.5 6h5L4 9z" fill="currentColor" opacity={sort?.i === i && sort.dir === 1 ? 0.3 : 1} />
                    </svg>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, k) => (
              <tr key={k}>
                {cols.map((c, i) => (
                  <td key={`${c.key}-${i}`} className={numeric[i] ? 'n' : undefined} title={markdown ? String(stripMd(r[i]) ?? '') : fmtCell(r[i], c.type)}>
                    {markdown ? <Inline text={String(r[i] ?? '')} /> : fmtCell(r[i], c.type)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Cards (Fleet records: people, contracts, deals, payments, links) ───

const CARD_ICON: Record<string, ReactNode> = {
  person: <><circle cx="8" cy="5.5" r="2.6" /><path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" /></>,
  contract: <><path d="M9 1.8H4.5a1 1 0 00-1 1v10.4a1 1 0 001 1h7a1 1 0 001-1V5.3L9 1.8z" /><path d="M9 1.8v3.5h3.5M5.8 8.5h4.4M5.8 11h3" /></>,
  deal: <><path d="M2 8.5l3-3 2.5 1.5L10 4.5l4 4" /><path d="M2 12.5h12" /></>,
  payment: <><path d="M8 1.8v12.4M10.8 4.3H6.7a1.9 1.9 0 000 3.8h2.6a1.9 1.9 0 010 3.8H5" /></>,
  link: <><path d="M6.6 9.4l2.8-2.8M7 4.4l1-1a2.6 2.6 0 013.7 3.7l-1 1M9 11.6l-1 1a2.6 2.6 0 01-3.7-3.7l1-1" /></>,
};
CARD_ICON.rep = CARD_ICON.person; CARD_ICON.client = CARD_ICON.contract; CARD_ICON.invoice = CARD_ICON.payment;

function Cards({ cards }: { cards: RecordCard[] }) {
  return (
    <div className="fai-cards">
      {cards.map((c, k) => {
        const href = safeHref(c.url);
        const t = (c.type || 'link').toLowerCase();
        const inner = (
          <>
            <span className="ic" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{CARD_ICON[t] || CARD_ICON.link}</svg>
            </span>
            <span className="bd">
              <span className="l1"><span className="tt">{c.title}</span>{c.status && <span className="st">{c.status}</span>}</span>
              {c.subtitle && <span className="sub">{c.subtitle}</span>}
              {!!c.fields.length && <span className="fl">{c.fields.map((f, i) => <span key={i}><span className="k">{f.label}</span> {f.value}</span>)}</span>}
            </span>
          </>
        );
        return href ? <Link key={k} className="fai-card" href={href}>{inner}</Link> : <div key={k} className="fai-card">{inner}</div>;
      })}
    </div>
  );
}

function Actions({ actions, onPrompt }: { actions: Action[]; onPrompt?: (text: string) => void }) {
  return (
    <div className="fai-acts">
      {actions.map((a, k) => {
        const href = safeHref(a.url);
        const cls = `fai-act${a.primary ? ' is-primary' : ''}`;
        if (href) return <Link key={k} className={cls} href={href}>{a.label}</Link>;
        if (a.prompt && onPrompt) return <button key={k} type="button" className={cls} onClick={() => onPrompt(a.prompt!)}>{a.label}</button>;
        return null;
      })}
    </div>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  return (
    <div className="fai-rich fai-code">
      <div className="fai-rich-h"><span className="t">{lang || 'code'}</span><CopyButton text={text} /></div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

function CtrlBlock({ b, onPrompt }: { b: Extract<Block, { k: 'code' }>; onPrompt?: (text: string) => void }) {
  const v = ctrlView(b);
  if (v.v === 'wait') return <div className="fai-rich-wait"><span className="fai-shimmer">Building {v.label}...</span></div>;
  if (v.v === 'table') return <SortTable cols={v.cols} rows={v.rows} title={v.title} />;
  if (v.v === 'chart') return <div className="fai-rich fai-chart">{v.chart.title && <div className="fai-rich-h"><span className="t">{v.chart.title}</span></div>}<RichChart chart={v.chart} /></div>;
  if (v.v === 'cards') return <Cards cards={v.cards} />;
  if (v.v === 'actions') return <Actions actions={v.actions} onPrompt={onPrompt} />;
  return <CodeBlock lang={v.lang} text={v.text} />;
}

/** A reply rendered as blocks. `onPrompt` is what an action button that asks something calls (sends it as the next message). */
export function RichText({ text, className = '', onPrompt }: { text: string; className?: string; onPrompt?: (text: string) => void }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  if (blocks.length === 1 && blocks[0].k === 'p') return <div className={`fai-text ${className}`}><Inline text={blocks[0].text} /></div>;
  return (
    <div className={`fai-text is-blocks ${className}`}>
      {blocks.map((b, i) => {
        switch (b.k) {
          case 'p': return <p key={i}><Inline text={b.text} /></p>;
          case 'h': return <div key={i} className={`fai-h fai-h${Math.min(b.level, 3)}`}><Inline text={b.text} /></div>;
          case 'ul': return <ul key={i}>{b.items.map((it, k) => <li key={k}><Inline text={it} /></li>)}</ul>;
          case 'ol': return <ol key={i}>{b.items.map((it, k) => <li key={k}><Inline text={it} /></li>)}</ol>;
          case 'quote': return <blockquote key={i}><Inline text={b.text} /></blockquote>;
          case 'hr': return <hr key={i} />;
          case 'table': {
            const cols = b.head.map((h, k) => ({ key: `${k}`, label: h.replace(/[*_`]/g, '') }));
            return <SortTable key={i} cols={cols} rows={b.rows.map((r) => cols.map((_, k) => r[k] ?? ''))} markdown />;
          }
          case 'code': return b.lang.startsWith('ctrl-') ? <CtrlBlock key={i} b={b} onPrompt={onPrompt} /> : <CodeBlock key={i} lang={b.lang} text={b.text} />;
        }
      })}
    </div>
  );
}
