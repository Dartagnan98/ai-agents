import 'server-only';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { asChart, asTable, fmtCell, type ChartData } from '@/components/ai/blocks';

// Charts in Slack (D, 2026-10-23: "where are the graphs"): the ctrl-chart, ctrl-table and ctrl-capacity (capacity card) blocks an agent writes are drawn as PNGs
// (hand-built SVG, @resvg/resvg-js with the box's DejaVu fonts) and posted as Slack image blocks under the text, so the post keeps its
// "(via the AI)" name and the bot needs no files:write scope. Each image is a file named by 16 random bytes in CHART_DIR, served by
// app/api/chart-img/[name]: the name is the key (anyone with the link sees that one image, like a Slack-hosted image). Kept 90 days.
const DIR = process.env.CHART_DIR || (process.env.NODE_ENV === 'production' ? '/var/cache/ctrl-os-charts' : path.join(os.tmpdir(), 'ctrl-os-charts'));
const KEEP_MS = 90 * 86_400_000;
export const chartFile = (name: string) => (/^[a-f0-9]{32}\.png$/.test(name) ? path.join(DIR, name) : null);

const COLORS = ['#3b5bdb', '#2f9e44', '#f08c00', '#e03131', '#7048e8', '#1098ad', '#c2255c', '#5c940d'];
const INK = '#1c1b19', MUTED = '#6b6a66', LINE = '#e6e3dc', FONT = 'DejaVu Sans, Helvetica, Arial, sans-serif';
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const compact = (v: number) => {
  const a = Math.abs(v);
  return a >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : `${+v.toFixed(a < 10 ? 1 : 0)}`;
};
/** Round axis ticks from 0 (or the minimum, when below 0) to the maximum. */
function ticks(min: number, max: number, n = 5): number[] {
  const lo = Math.min(0, min), span = (max - lo) || 1, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= max + step * 0.999; v += step) out.push(+v.toFixed(10));
  return out;
}
const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${FONT}"><rect width="${w}" height="${h}" fill="#ffffff"/>${body}</svg>`;
const title = (t: string) => (t ? `<text x="32" y="44" font-size="24" font-weight="700" fill="${INK}">${esc(cut(t, 70))}</text>` : '');
const legend = (series: string[], y: number) => series.length < 2 ? '' : series.map((s, i) =>
  `<rect x="${32 + i * 180}" y="${y - 12}" width="14" height="14" rx="3" fill="${COLORS[i % COLORS.length]}"/><text x="${52 + i * 180}" y="${y}" font-size="16" fill="${MUTED}">${esc(cut(s, 18))}</text>`).join('');

export function chartSvg(c: ChartData): string {
  const W = 1000, H = 560, val = (r: Record<string, unknown>, s: string) => Number(r[s]) || 0;
  if (c.kind === 'pie') {
    const s = c.series[0], rows = c.data.filter((r) => val(r, s) > 0), total = rows.reduce((n, r) => n + val(r, s), 0) || 1;
    let a = -Math.PI / 2, body = '';
    rows.forEach((r, i) => {
      const f = val(r, s) / total, b = a + f * Math.PI * 2, cx = 300, cy = 310, R = 200;
      const p = (t: number) => `${(cx + R * Math.cos(t)).toFixed(1)} ${(cy + R * Math.sin(t)).toFixed(1)}`;
      body += f >= 0.9999 ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${COLORS[i % COLORS.length]}"/>`
        : `<path d="M${cx} ${cy} L${p(a)} A${R} ${R} 0 ${f > 0.5 ? 1 : 0} 1 ${p(b)} Z" fill="${COLORS[i % COLORS.length]}" stroke="#fff" stroke-width="2"/>`;
      if (i < 12) body += `<rect x="560" y="${118 + i * 34}" width="16" height="16" rx="3" fill="${COLORS[i % COLORS.length]}"/>`
        + `<text x="586" y="${132 + i * 34}" font-size="18" fill="${INK}">${esc(cut(String(r[c.x] ?? ''), 22))}  <tspan fill="${MUTED}">${compact(val(r, s))} · ${Math.round(f * 100)}%</tspan></text>`;
      a = b;
    });
    return svg(W, H, title(c.title) + body);
  }
  const L = 84, R = 24, T = 80, B = 96, pw = W - L - R, ph = H - T - B;
  const all = c.data.flatMap((r) => c.series.map((s) => val(r, s)));
  const tk = ticks(Math.min(0, ...all), Math.max(0, ...all)), lo = tk[0], hi = tk[tk.length - 1] || 1;
  const y = (v: number) => T + ph - ((v - lo) / (hi - lo || 1)) * ph;
  let body = tk.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${LINE}"/><text x="${L - 10}" y="${y(t) + 5}" font-size="15" fill="${MUTED}" text-anchor="end">${compact(t)}</text>`).join('');
  const n = c.data.length || 1, band = pw / n, every = Math.ceil(n / 14);
  c.data.forEach((r, i) => {
    if (i % every === 0) body += `<text x="${L + band * (i + 0.5)}" y="${H - B + 26}" font-size="15" fill="${MUTED}" text-anchor="middle">${esc(cut(String(r[c.x] ?? ''), Math.max(4, Math.floor(band * every / 9))))}</text>`;
  });
  if (c.kind === 'bar') {
    const bw = Math.min(56, (band * 0.72) / c.series.length);
    c.data.forEach((r, i) => c.series.forEach((s, j) => {
      const v = val(r, s), x = L + band * (i + 0.5) - (bw * c.series.length) / 2 + j * bw, top = Math.min(y(v), y(0));
      body += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, bw - 3).toFixed(1)}" height="${Math.max(1, Math.abs(y(v) - y(0))).toFixed(1)}" rx="3" fill="${COLORS[j % COLORS.length]}"/>`;
      if (n * c.series.length <= 16) body += `<text x="${(x + (bw - 3) / 2).toFixed(1)}" y="${(top - 7).toFixed(1)}" font-size="14" fill="${INK}" text-anchor="middle">${compact(v)}</text>`;
    }));
  } else {
    c.series.forEach((s, j) => {
      const pts = c.data.map((r, i) => `${(L + band * (i + 0.5)).toFixed(1)},${y(val(r, s)).toFixed(1)}`);
      body += `<polyline points="${pts.join(' ')}" fill="none" stroke="${COLORS[j % COLORS.length]}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (n <= 31) body += pts.map((p) => { const [px, py] = p.split(','); return `<circle cx="${px}" cy="${py}" r="4.5" fill="${COLORS[j % COLORS.length]}"/>`; }).join('');
    });
  }
  return svg(W, H, title(c.title) + body + legend(c.series, H - 24));
}

export function tableSvg(t: { cols: { label: string; type?: string }[]; rows: unknown[][]; title?: string }): string {
  const MAX = 30, rows = t.rows.slice(0, MAX), more = t.rows.length - rows.length;
  const cells = rows.map((r) => t.cols.map((c, i) => fmtCell(r[i], c.type as never)));
  // column widths from the longest text (~9.5 px a character at 17 px), within 1000-1600 wide
  const want = t.cols.map((c, i) => Math.min(380, Math.max(70, 9.5 * Math.max(c.label.length, ...cells.map((r) => r[i].length)) + 32)));
  const W = Math.min(1600, Math.max(1000, want.reduce((a, b) => a + b, 0) + 48)), scale = (W - 48) / want.reduce((a, b) => a + b, 0);
  const ws = want.map((w) => w * scale), xs = ws.map((_, i) => 24 + ws.slice(0, i).reduce((a, b) => a + b, 0));
  const top = t.title ? 72 : 24, rh = 40, H = top + rh * (rows.length + 1) + (more > 0 ? 40 : 16);
  const right = (i: number) => ['number', 'money', 'percent'].includes(t.cols[i].type ?? '');
  const cell = (s: string, i: number, yy: number, weight: number, fill: string) => {
    const maxc = Math.floor((ws[i] - 24) / 9.5);
    return `<text x="${(right(i) ? xs[i] + ws[i] - 12 : xs[i] + 12).toFixed(1)}" y="${yy}" font-size="17" font-weight="${weight}" fill="${fill}" text-anchor="${right(i) ? 'end' : 'start'}">${esc(cut(s, maxc))}</text>`;
  };
  let body = title(t.title ?? '') + `<rect x="24" y="${top}" width="${W - 48}" height="${rh}" fill="#f4f2ec"/>`;
  body += t.cols.map((c, i) => cell(c.label, i, top + 26, 700, INK)).join('');
  cells.forEach((r, j) => {
    const yy = top + rh * (j + 1);
    body += `<line x1="24" x2="${W - 24}" y1="${yy}" y2="${yy}" stroke="${LINE}"/>` + r.map((s, i) => cell(s, i, yy + 26, i === 0 ? 600 : 400, INK)).join('');
  });
  if (more > 0) body += `<text x="36" y="${H - 14}" font-size="15" fill="${MUTED}">and ${more} more rows</text>`;
  return svg(Math.round(W), H, body);
}

/** The capacity card (D, 2026-10-23: the old 72-hour snapshot's "View capacity card"), from the capacity tool's own numbers. */
export interface CapacityCard {
  title: string; window: string; zone?: string; booked: number; open: number; closersBooked: number;
  days: { label: string; booked: number; open: number }[]; top?: { name: string; open: number }[]; calendars?: { name: string; booked: number }[];
  kpi?: { lo: number; hi: number; minOpen: number }; // the contract's Process KPIs: bars green inside the target, red outside, as on Calls › Capacity
}
/** The capacity card's data from lib/data/capacity.ts numbers (the capacity tool's card and Calls › Capacity show the same one). */
export function capacityCardOf(name: string, hours: number, cap: { booked: number; open: number; closersBooked: number; days: { day: string; booked: number; open: number }[]; closers: { name: string; open: number }[]; calendars: { name: string; booked: number }[] }, zone: string, kpi?: CapacityCard['kpi']): CapacityCard {
  const lab = (d: string, o: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...o });
  const first = cap.days[0]?.day, last = cap.days.at(-1)?.day;
  return {
    title: `${name}: ${hours}-Hour Capacity`, zone, ...(kpi ? { kpi } : {}),
    window: !first || !last ? '' : first.slice(0, 7) === last.slice(0, 7)
      ? `${lab(first, { month: 'long', day: 'numeric' })} to ${Number(last.slice(8))}, ${last.slice(0, 4)}` // "October 22 to 24, 2026"
      : `${lab(first, { month: 'long', day: 'numeric' })} to ${lab(last, { month: 'long', day: 'numeric', year: 'numeric' })}`,
    booked: cap.booked, open: cap.open, closersBooked: cap.closersBooked,
    days: cap.days.map((d) => ({ label: lab(d.day, { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', ''), booked: d.booked, open: d.open })),
    top: cap.closers.slice(0, 3).map(({ name: n, open }) => ({ name: n, open })), calendars: cap.calendars.map(({ name: n, booked }) => ({ name: n, booked })),
  };
}

export function capacityCardSvg(c: CapacityCard): string {
  // the snapshot layout: light page, white cards, navy totals like the Booked
  // calls tile, green / red bars by the contract's Process KPI targets like Calls › Capacity
  const BG = '#eef0f3', PANEL = '#ffffff', NAVY = '#0f172a', TXT = '#111827', DIM = '#6b7280', TRACK = '#eceef1', EDGE = '#e3e6ea', W = 1000;
  const GREEN = '#0f9b6c', RED = '#d0112b', k = c.kpi ?? { lo: 20, hi: 90, minOpen: 0 };
  const toneOf = (p: number, open?: number) => (open != null && open < k.minOpen) || p < k.lo || p > k.hi ? RED : GREEN, GOLD = NAVY;
  const pct = (b: number, o: number) => (b + o ? (b / (b + o)) * 100 : 0), total = c.booked + c.open, u = pct(c.booked, c.open);
  const days = c.days.slice(0, 7);
  let y = 0, b = '';
  b += `<text x="34" y="62" font-size="34" font-weight="700" fill="${TXT}">${esc(cut(c.title, 44))}</text>`;
  const nd = c.days.length, all = nd ? `All ${nd} days` : 'All days', span = c.days.length ? `${String(c.days[0].label ?? '').replace(/^\w+ /, '')} to ${String(c.days[nd - 1].label ?? '').replace(/^\w+ \w+ /, '')}` : '';
  b += `<text x="34" y="92" font-size="15" fill="${DIM}">Booked sales calls and open closer capacity${nd ? ` · next ${nd} days` : ''}</text>`;
  b += `<text x="${W - 34}" y="46" font-size="15" fill="${DIM}" text-anchor="end">${esc(c.window)}</text>`;
  if (c.zone) b += `<text x="${W - 34}" y="66" font-size="15" fill="${DIM}" text-anchor="end">${esc(c.zone)}</text>`;
  b += `<line x1="34" x2="${W - 34}" y1="112" y2="112" stroke="${EDGE}"/>`;
  b += `<rect x="34" y="130" width="${W - 68}" height="112" rx="14" fill="${NAVY}"/><text x="58" y="158" font-size="11" font-weight="700" letter-spacing="1.6" fill="#9ca3af">${esc((/(\d+-Hour)/.exec(c.title)?.[1] ?? '').toUpperCase())} TOTALS</text>`;
  [['BOOKED CALLS', c.booked, all], ['OPEN SLOTS', c.open, all], ['TOTAL CAPACITY', total, 'Booked + open'], ['CLOSERS BOOKED', c.closersBooked, all]].forEach(([lab, v, sub], i) => {
    const x = 58 + i * 232;
    b += `<text x="${x}" y="182" font-size="11" font-weight="700" letter-spacing="1.4" fill="#9ca3af">${lab}</text><text x="${x}" y="216" font-size="30" font-weight="700" fill="#ffffff">${v}</text><text x="${x}" y="234" font-size="11" fill="#9ca3af">${sub}</text>`;
  });
  b += `<rect x="34" y="258" width="${W - 68}" height="90" rx="14" fill="${PANEL}" stroke="${EDGE}"/><text x="54" y="292" font-size="16" fill="${TXT}">Window utilization</text>`;
  b += `<text x="${W - 54}" y="294" font-size="22" font-weight="700" fill="${toneOf(u)}" text-anchor="end">${u.toFixed(1)}%</text>`;
  b += `<rect x="54" y="306" width="${W - 108}" height="8" rx="4" fill="${TRACK}"/><rect x="54" y="306" width="${((W - 108) * Math.min(100, u)) / 100}" height="8" rx="4" fill="${toneOf(u)}"/>`;
  b += `<text x="54" y="336" font-size="12" fill="${DIM}">${c.booked} of ${total} available call slots are booked</text>`;
  y = 384;
  b += `<text x="34" y="${y}" font-size="12" letter-spacing="1.6" fill="${DIM}">DAY-BY-DAY BREAKDOWN</text>`;
  y += 22;
  b += `<text x="52" y="${y}" font-size="11" letter-spacing="1.4" fill="${DIM}">DATE</text><text x="190" y="${y}" font-size="11" letter-spacing="1.4" fill="${DIM}">UTILIZATION BAR</text><text x="${W - 250}" y="${y}" font-size="11" letter-spacing="1.4" fill="${DIM}" text-anchor="end">BOOKED</text><text x="${W - 150}" y="${y}" font-size="11" letter-spacing="1.4" fill="${DIM}" text-anchor="end">OPEN</text><text x="${W - 52}" y="${y}" font-size="11" letter-spacing="1.4" fill="${DIM}" text-anchor="end">UTIL</text>`;
  y += 12;
  for (const d of days) {
    const p = pct(d.booked, d.open);
    b += `<rect x="34" y="${y}" width="${W - 68}" height="50" rx="10" fill="${PANEL}" stroke="${EDGE}"/><text x="52" y="${y + 32}" font-size="18" font-weight="700" fill="${TXT}">${esc(d.label)}</text>`;
    b += `<rect x="190" y="${y + 21}" width="360" height="8" rx="4" fill="${TRACK}"/><rect x="190" y="${y + 21}" width="${(360 * Math.min(100, p)) / 100}" height="8" rx="4" fill="${toneOf(p, d.open)}"/>`;
    b += `<text x="${W - 250}" y="${y + 32}" font-size="18" font-weight="700" fill="${GOLD}" text-anchor="end">${d.booked}</text><text x="${W - 150}" y="${y + 32}" font-size="18" font-weight="700" fill="${TXT}" text-anchor="end">${d.open}</text><text x="${W - 52}" y="${y + 32}" font-size="18" font-weight="700" fill="${toneOf(p, d.open)}" text-anchor="end">${Math.round(p)}%</text>`;
    y += 58;
  }
  y += 6;
  const top = (c.top ?? []).filter((t) => t.open > 0).slice(0, 3);
  b += `<rect x="34" y="${y}" width="${W - 68}" height="68" rx="12" fill="${PANEL}" stroke="${NAVY}"/><text x="54" y="${y + 26}" font-size="12" letter-spacing="1.6" fill="${DIM}">TOTAL BOOKED CALLS ${esc(span.toUpperCase())}</text>`;
  b += `<text x="54" y="${y + 50}" font-size="13" fill="${DIM}">${c.open} slots still open${top.length ? ` · most availability: ${top.map((t) => `${esc(t.name)} <tspan fill="${TXT}" font-weight="700">${t.open}</tspan>`).join('  ·  ')}` : ''}</text>`;
  b += `<text x="${W - 54}" y="${y + 46}" font-size="30" font-weight="700" fill="${GOLD}" text-anchor="end">${c.booked}</text>`;
  y += 92;
  const cals = (c.calendars ?? []).filter((k) => k.booked > 0).slice(0, 8);
  if (cals.length) {
    let x = 34;
    for (const k of cals) {
      const label = `${cut(k.name, 26)} `, w = (label.length + String(k.booked).length) * 7.6 + 18;
      if (x + w > W - 34) break;
      b += `<text x="${x}" y="${y}" font-size="13" fill="${DIM}">${esc(label)}<tspan fill="${TXT}" font-weight="700">${k.booked}</tspan></text>`;
      x += w;
    }
    y += 20;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y + 14}" viewBox="0 0 ${W} ${y + 14}" font-family="${FONT}"><rect width="${W}" height="${y + 14}" rx="0" fill="${BG}"/>${b}</svg>`;
}

export async function svgToPng(src: string): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  const w = Number(/width="(\d+)"/.exec(src)?.[1]) || 1000;
  return Buffer.from(new Resvg(src, { fitTo: { mode: 'width', value: Math.min(2400, w * 1.6) }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng());
}

const FENCED = /```(ctrl-[a-z]+)[^\n]*\n([\s\S]*?)```/g;
/** The ctrl-chart / ctrl-table blocks of a reply as images (others dropped), and the text without any ctrl- block. */
export async function chartImages(text: string): Promise<{ text: string; images: { png: Buffer; title: string }[] }> {
  const images: { png: Buffer; title: string }[] = [];
  for (const m of text.matchAll(FENCED)) {
    let j: unknown;
    try { j = JSON.parse(m[2]); } catch { continue; }
    if (images.length >= 6) break; // Slack shows a handful well; more is a wall
    const c = m[1] === 'ctrl-chart' ? asChart(j) : null, t = m[1] === 'ctrl-table' ? asTable(j) : null;
    const k = m[1] === 'ctrl-capacity' && j && typeof j === 'object' && Array.isArray((j as CapacityCard).days) ? j as CapacityCard : null;
    try {
      if (k) images.push({ png: await svgToPng(capacityCardSvg(k)), title: `${k.title} capacity card` });
      else if (c) images.push({ png: await svgToPng(chartSvg(c)), title: c.title || 'Chart' });
      else if (t) images.push({ png: await svgToPng(tableSvg(t)), title: t.title || 'Table' });
    } catch (e) { console.warn(`[charts] ${e instanceof Error ? e.message : String(e)}`); }
  }
  return { text: text.replace(FENCED, '').replace(/\n{3,}/g, '\n\n').trim(), images };
}

let swept = 0;
export function saveChartPng(png: Buffer): string {
  fs.mkdirSync(DIR, { recursive: true });
  if (Date.now() - swept > 3_600_000) { // old ones out, at most hourly
    swept = Date.now();
    for (const f of fs.readdirSync(DIR)) { try { const p = path.join(DIR, f); if (Date.now() - fs.statSync(p).mtimeMs > KEEP_MS) fs.unlinkSync(p); } catch { /* gone */ } }
  }
  const name = `${crypto.randomBytes(16).toString('hex')}.png`;
  fs.writeFileSync(path.join(DIR, name), png);
  return name;
}

/** Slack content for an agent's text: unchanged when it has no chart or table (or no public address); else the text in sections
 *  (Slack's 3,000 per section) and an image block per chart or table. The text stays as the notification fallback. */
export async function slackWithCharts(text: string, markdown = false): Promise<{ text: string; blocks?: unknown[] }> {
  const base = (process.env.APP_URL || '').replace(/\/$/, '');
  if (markdown) { // a script's standard Markdown: drawn by Slack, our own chart links attached as pictures
    const own = base ? [...new Set(text.match(new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/chart-img/[0-9a-f]{32}\\.png`, 'g')) ?? [])] : [];
    const { text: rest, images } = /```ctrl-(chart|table|capacity)/.test(text) ? await chartImages(text) : { text, images: [] };
    const pics = [...images.map((im) => ({ url: `${base}/api/chart-img/${saveChartPng(im.png)}`, title: im.title })), ...own.slice(0, 5).map((url) => ({ url, title: 'Capacity card' }))];
    return { text: rest.replace(/[#*]/g, '').slice(0, 3000), blocks: [{ type: 'markdown', text: rest.slice(0, 11_900) },
      ...pics.map((im) => ({ type: 'image', image_url: im.url, alt_text: cut(im.title, 1900), title: { type: 'plain_text', text: cut(im.title, 1900) } }))] };
  }
  // links to images already published here (scripts' publish_image: the 72-hour capacity cards) show as the picture too (D, 2026-10-28)
  const own = base ? [...new Set(text.match(new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/chart-img/[0-9a-f]{32}\\.png`, 'g')) ?? [])] : [];
  if (!base || (!own.length && !/```ctrl-(chart|table|capacity)/.test(text))) return { text };
  const { text: rest, images } = own.length && !/```ctrl-/.test(text) ? { text, images: [] } : await chartImages(text);
  if (!images.length && !own.length) return { text };
  const sections: unknown[] = [];
  for (let i = 0; i < rest.length && sections.length < 40; i += 2900) sections.push({ type: 'section', text: { type: 'mrkdwn', text: rest.slice(i, i + 2900) } });
  const pics = [...images.map((im) => ({ url: `${base}/api/chart-img/${saveChartPng(im.png)}`, title: im.title })), ...own.slice(0, 5).map((url) => ({ url, title: 'Chart' }))]
    .map((im) => ({ type: 'image', image_url: im.url, alt_text: cut(im.title, 1900), title: { type: 'plain_text', text: cut(im.title, 1900) } }));
  return { text: rest || images.map((i) => i.title).join(', '), blocks: [...sections, ...pics] };
}
