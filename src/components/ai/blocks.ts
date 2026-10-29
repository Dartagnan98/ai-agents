// the agents reply parsing (D, 2026-10-09), ported from agent RichText (G14). Pure functions, no React, so the parser has a
// unit test. A reply is split into blocks: paragraphs, headings, lists, quotes, rules, pipe tables and fenced code. Fenced blocks whose
// language starts with "ctrl-" carry JSON the chat draws as a view:
//
//   ```ctrl-table   {"title"?, "columns": ["Name", {"key":"amount","label":"Amount","type":"money"}], "rows": [[..], ..] | [{..}, ..]}
//   ```ctrl-chart   {"type":"bar"|"line"|"pie", "title"?, "x":"month", "series":["revenue"], "data":[{"month":"Jan","revenue":10}, ..]}
//   ```ctrl-cards   {"cards":[{"type":"person"|"contract"|"deal"|"payment"|"link", "title", "subtitle"?, "url"?, "status"?, "fields"?:[{"label","value"}]}]}
//   ```ctrl-actions {"actions":[{"label", "url"? | "prompt"?, "primary"?}]}
//
// (ctrl-card, a bare array, or a single object are accepted too.) Bad JSON falls back to a code block; a block still streaming is `open`.
import { agencyCurrency } from '@/lib/currency';

export type Block =
  | { k: 'p'; text: string }
  | { k: 'h'; level: number; text: string }
  | { k: 'ul' | 'ol'; items: string[] }
  | { k: 'quote'; text: string }
  | { k: 'hr' }
  | { k: 'table'; head: string[]; rows: string[][] }
  | { k: 'code'; lang: string; text: string; open: boolean };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w.+-]*)\s*$/;
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

/** Splits a reply into blocks. Unclosed fences (still streaming) are marked open. */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { const t = para.join('\n').trim(); if (t) out.push({ k: 'p', text: t }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = FENCE.exec(l);
    if (f) {
      flush();
      const body: string[] = [];
      const close = new RegExp(`^\\s*${f[1][0] === '`' ? '`' : '~'}{${f[1].length},}\\s*$`);
      let j = i + 1;
      for (; j < lines.length; j++) { if (close.test(lines[j])) break; body.push(lines[j]); }
      out.push({ k: 'code', lang: f[2].toLowerCase(), text: body.join('\n'), open: j >= lines.length });
      i = j;
      continue;
    }
    if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush();
      const head = cells(l);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length && isRow(lines[j]); j++) rows.push(cells(lines[j]));
      out.push({ k: 'table', head, rows });
      i = j - 1;
      continue;
    }
    const h = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) { flush(); out.push({ k: 'h', level: h[1].length, text: h[2] }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push({ k: 'hr' }); continue; }
    const li = /^\s*([-*+•]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      flush();
      const kind = /\d/.test(li[1]) ? 'ol' : 'ul';
      const items = [li[2]];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const m = /^\s*([-*+•]|\d+[.)])\s+(.*)$/.exec(lines[j]);
        if (m && (/\d/.test(m[1]) ? 'ol' : 'ul') === kind) items.push(m[2]);
        else if (lines[j].trim() && /^\s{2,}/.test(lines[j])) items[items.length - 1] += `\n${lines[j].trim()}`;
        else break;
      }
      out.push({ k: kind, items });
      i = j - 1;
      continue;
    }
    if (/^\s*>\s?/.test(l)) {
      flush();
      const q = [l.replace(/^\s*>\s?/, '')];
      let j = i + 1;
      for (; j < lines.length && /^\s*>\s?/.test(lines[j]); j++) q.push(lines[j].replace(/^\s*>\s?/, ''));
      out.push({ k: 'quote', text: q.join('\n') });
      i = j - 1;
      continue;
    }
    if (!l.trim()) { flush(); continue; }
    para.push(l);
  }
  flush();
  return out;
}

// ─── Inline markdown: **bold**, *italic*, `code`, [label](url) and bare http(s) links. React draws the tokens (no HTML strings). ───

export type Inline =
  | { t: 'text'; s: string }
  | { t: 'b' | 'i' | 'code'; s: string }
  | { t: 'link'; s: string; href: string };

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*\n]*\*)/g;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: 'text', s: src.slice(last, at) });
    const [all, code, bold, link, bare, ital] = m;
    if (code) out.push({ t: 'code', s: code.slice(1, -1) });
    else if (bold) out.push({ t: 'b', s: bold.slice(2, -2) });
    else if (link) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(link)!;
      const href = safeHref(lm[2]);
      out.push(href ? { t: 'link', s: lm[1], href } : { t: 'text', s: lm[1] });
    } else if (bare) out.push({ t: 'link', s: bare, href: bare });
    else if (ital) out.push({ t: 'i', s: ital.slice(1, -1) });
    else out.push({ t: 'text', s: all });
    last = at + all.length;
  }
  if (last < src.length) out.push({ t: 'text', s: src.slice(last) });
  return out;
}

/** Only http(s) and in-app paths become links; Fleet's own absolute URL becomes its path. */
export function safeHref(url?: string): string | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (typeof window !== 'undefined' && u.origin === window.location.origin) return `${u.pathname}${u.search}${u.hash}`;
    return u.toString();
  } catch { return null; }
}

// ─── Table values ───

export interface TableCol { key: string; label: string; type?: 'text' | 'number' | 'money' | 'percent' | 'date' }

export const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.replace(/[$,%\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  return t !== '' && /^-?\d*\.?\d+(e-?\d+)?$/i.test(t) ? Number(t) : null;
};

export function fmtCell(v: unknown, type?: TableCol['type']): string {
  if (v == null || v === '') return '';
  const n = num(v);
  if (type === 'money' && n != null) return n.toLocaleString('en-US', { style: 'currency', currency: agencyCurrency(), maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 });
  if (type === 'percent' && n != null) return `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  if (type === 'number' && n != null) return n.toLocaleString('en-US');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function stripMd(v: unknown): unknown {
  return typeof v === 'string' ? v.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '') : v;
}

// ─── ctrl-* views ───

export function asTable(j: unknown): { cols: TableCol[]; rows: unknown[][]; title?: string } | null {
  if (!j || typeof j !== 'object') return null;
  const o = (Array.isArray(j) ? { rows: j } : j) as Record<string, unknown>;
  const rawRows = Array.isArray(o.rows) ? o.rows : Array.isArray(o.data) ? o.data : null;
  if (!rawRows) return null;
  let cols: TableCol[] = Array.isArray(o.columns)
    ? (o.columns as unknown[]).map((c, i) => (typeof c === 'string' ? { key: c, label: c } : { key: String((c as TableCol).key ?? (c as TableCol).label ?? i), label: String((c as TableCol).label ?? (c as TableCol).key ?? ''), type: (c as TableCol).type }))
    : [];
  if (!cols.length && rawRows.length && rawRows[0] && typeof rawRows[0] === 'object' && !Array.isArray(rawRows[0])) cols = Object.keys(rawRows[0] as object).map((k) => ({ key: k, label: k }));
  const rows = rawRows.slice(0, 500).map((r) => (Array.isArray(r) ? r : cols.map((c) => (r as Record<string, unknown>)?.[c.key] ?? (r as Record<string, unknown>)?.[c.label])));
  if (!cols.length) return null;
  return { cols, rows, title: typeof o.title === 'string' ? o.title : undefined };
}

export interface ChartData { kind: 'bar' | 'line' | 'pie'; title: string; x: string; series: string[]; data: Record<string, string | number | null>[] }

export function asChart(j: unknown): ChartData | null {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  const data = Array.isArray(o.data) ? (o.data as Record<string, string | number | null>[]).filter((d) => d && typeof d === 'object').slice(0, 200) : [];
  if (!data.length) return null;
  const kind = (['bar', 'line', 'pie'].includes(String(o.type ?? o.kind)) ? String(o.type ?? o.kind) : 'bar') as ChartData['kind'];
  const keys = Object.keys(data[0]);
  const x = typeof o.x === 'string' ? o.x : keys[0];
  let series = Array.isArray(o.series) ? (o.series as unknown[]).map(String) : typeof o.y === 'string' ? [o.y] : keys.filter((k) => k !== x && typeof data[0][k] === 'number');
  series = series.filter((k) => keys.includes(k));
  if (kind === 'pie') series = series.slice(0, 1);
  if (!series.length) return null;
  // numbers sent as strings ("1,200") still draw
  const clean = data.map((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, series.includes(k) ? num(v) : v])));
  return { kind, title: typeof o.title === 'string' ? o.title : '', x, series, data: clean };
}

export interface RecordCard { type?: string; title: string; subtitle?: string; url?: string; status?: string; fields: { label: string; value: string }[] }

export function asCards(j: unknown): RecordCard[] {
  const arr = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as { cards?: unknown }).cards) ? (j as { cards: unknown[] }).cards : j && typeof j === 'object' ? [j] : [];
  return arr.filter((c) => c && typeof c === 'object' && typeof (c as RecordCard).title === 'string').slice(0, 24).map((c) => {
    const r = c as RecordCard & { fields?: unknown };
    const fields = Array.isArray(r.fields) ? (r.fields as { label?: unknown; value?: unknown }[]).filter((f) => f && f.label != null).map((f) => ({ label: String(f.label), value: String(f.value ?? '') })).slice(0, 6) : [];
    return { type: r.type ? String(r.type) : undefined, title: r.title, subtitle: r.subtitle ? String(r.subtitle) : undefined, url: r.url ? String(r.url) : undefined, status: r.status ? String(r.status) : undefined, fields };
  });
}

export interface Action { label: string; url?: string; prompt?: string; primary?: boolean }

export function asActions(j: unknown): Action[] {
  const arr = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as { actions?: unknown }).actions) ? (j as { actions: unknown[] }).actions : j && typeof j === 'object' ? [j] : [];
  return arr.filter((a) => a && typeof a === 'object' && typeof (a as Action).label === 'string' && (typeof (a as Action).url === 'string' || typeof (a as Action).prompt === 'string'))
    .slice(0, 6).map((a) => { const x = a as Action; return { label: x.label, url: x.url, prompt: x.prompt, primary: !!x.primary }; });
}

export type View =
  | { v: 'table'; cols: TableCol[]; rows: unknown[][]; title?: string }
  | { v: 'chart'; chart: ChartData }
  | { v: 'cards'; cards: RecordCard[] }
  | { v: 'actions'; actions: Action[] }
  | { v: 'code'; lang: string; text: string }
  | { v: 'wait'; label: string };

const LABEL: Record<string, string> = { 'ctrl-table': 'table', 'ctrl-chart': 'chart', 'ctrl-cards': 'cards', 'ctrl-card': 'cards', 'ctrl-actions': 'actions' };

/** What a fenced ctrl-* block draws: its view, a "Building ..." line while it streams, or a code block when the JSON does not fit. */
export function ctrlView(b: { lang: string; text: string; open: boolean }): View {
  if (b.open) return { v: 'wait', label: LABEL[b.lang] || 'view' };
  let j: unknown;
  try { j = JSON.parse(b.text); } catch { return { v: 'code', lang: b.lang, text: b.text }; }
  if (b.lang === 'ctrl-table') { const t = asTable(j); if (t) return { v: 'table', ...t }; }
  if (b.lang === 'ctrl-chart') { const c = asChart(j); if (c) return { v: 'chart', chart: c }; }
  if (b.lang === 'ctrl-cards' || b.lang === 'ctrl-card') { const c = asCards(j); if (c.length) return { v: 'cards', cards: c }; }
  if (b.lang === 'ctrl-actions') { const a = asActions(j); if (a.length) return { v: 'actions', actions: a }; }
  return { v: 'code', lang: b.lang, text: b.text };
}

/** The reply as plain text for Copy: ctrl blocks become tab-separated rows or labels, so a pasted answer still reads. */
export function plainText(src: string): string {
  return parseBlocks(src).map((b) => {
    if (b.k === 'code' && b.lang.startsWith('ctrl-')) {
      const v = ctrlView(b);
      if (v.v === 'table') return [v.title, v.cols.map((c) => c.label).join('\t'), ...v.rows.map((r) => r.map((x) => fmtCell(x, undefined)).join('\t'))].filter(Boolean).join('\n');
      if (v.v === 'chart') return [v.chart.title, [v.chart.x, ...v.chart.series].join('\t'), ...v.chart.data.map((d) => [d[v.chart.x], ...v.chart.series.map((s) => d[s])].join('\t'))].filter(Boolean).join('\n');
      if (v.v === 'cards') return v.cards.map((c) => [c.title, c.subtitle, ...c.fields.map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join(' | ')).join('\n');
      if (v.v === 'actions') return '';
      return b.text;
    }
    if (b.k === 'code') return b.text;
    if (b.k === 'table') return [b.head, ...b.rows].map((r) => r.map((c) => String(stripMd(c))).join('\t')).join('\n');
    if (b.k === 'ul' || b.k === 'ol') return b.items.map((i, n) => `${b.k === 'ol' ? `${n + 1}.` : '-'} ${stripMd(i)}`).join('\n');
    if (b.k === 'hr') return '';
    return 'text' in b ? String(stripMd(b.text)) : '';
  }).filter(Boolean).join('\n\n');
}
