'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { IconMinus, IconPlus, IconFocusCentered, IconSearch, IconX } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

// AI › Graph (D, 2026-10-23: "its own page ... like CTRL Flow, zoom in, find what it is and connections"): team memory as a map. Reps
// and contracts, plus the Slack channels, Knowledge documents and team decisions that name them (lib/ai/team-graph.ts memoryMap).
// Size = how much memory there is; a solid line = a relationship the AI drew, faint = named together (thicker = more often).
// Wheel, pinch or the buttons zoom; drag pans; search jumps to a name; a click opens the side panel (its links and newest memory).
// The layout is a small force simulation run once per data load (no library; a few hundred nodes).
// Motion: the map unfolds from the centre, dots drift a little, the picked dot pulses with light running along its lines, and
// zoom / focus / fit glide. The side panel floats over the map, so a click no longer resizes (and jumps) it.
export type NodeKind = 'person' | 'agent' | 'channel' | 'doc' | 'decision';
export interface GNode { id: string; kind: NodeKind; name: string; weight: number }
export interface GLink { a: string; b: string; w: number; rel?: string }
interface Detail { profile: string | null; profiled: string | null; pieces: { kind: string; title: string; at: string; body: string }[] }

const KINDS: { kind: NodeKind; label: string; color: string }[] = [
  { kind: 'person', label: 'People', color: 'var(--color-cobalt)' },
  { kind: 'agent', label: 'Agents', color: 'var(--color-watch)' },
  { kind: 'channel', label: 'Slack channels', color: 'var(--color-healthy)' },
  { kind: 'doc', label: 'Knowledge', color: '#8b7fd4' },
  { kind: 'decision', label: 'Decisions', color: 'var(--color-weak)' },
];
const COLOR = Object.fromEntries(KINDS.map((k) => [k.kind, k.color])) as Record<NodeKind, string>;
const LABEL: Record<NodeKind, string> = { person: 'Person', agent: 'Agent', channel: 'Slack channel', doc: 'Knowledge', decision: 'Team decision' };
const PIECE: Record<string, string> = { chat: 'AI chat', slack: 'Slack', kb: 'Knowledge', team: 'Team decision' };
export const W = 1600, H = 1000;
export const radius = (n: GNode, maxW: number) => 5 + 19 * Math.sqrt(n.weight / Math.max(1, maxW));

/** Positions for every node: deterministic (same data, same picture), inside W x H, dots not overlapping. */
export function layout(nodes: GNode[], links: GLink[], steps = 300): Map<string, { x: number; y: number }> {
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const pts = nodes.map((_, i) => { const t = (i / Math.max(1, nodes.length)) * Math.PI * 2 * 3.1, r = 80 + (i % 23) * 18; return { x: W / 2 + r * Math.cos(t), y: H / 2 + r * Math.sin(t), vx: 0, vy: 0 }; });
  const ls = links.map((l) => ({ ...l, i: idx.get(l.a), j: idx.get(l.b) })).filter((l): l is GLink & { i: number; j: number } => l.i !== undefined && l.j !== undefined);
  const maxL = Math.max(1, ...ls.map((l) => l.w)), maxW = Math.max(1, ...nodes.map((n) => n.weight)), rad = nodes.map((n) => radius(n, maxW));
  for (let s = 0; s < steps; s++) {
    const heat = 1 - s / steps;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const p = pts[i], q = pts[j], dx = p.x - q.x || 0.01, dy = p.y - q.y || 0.01, d2 = Math.max(dx * dx + dy * dy, 25), f = 5000 / d2;
      p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
    }
    for (const l of ls) {
      const p = pts[l.i], q = pts[l.j], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1;
      const k = (0.01 + 0.03 * (l.rel ? 1 : l.w / maxL)) * (d - (l.rel ? 120 : 160)) / d;
      p.vx += dx * k; p.vy += dy * k; q.vx -= dx * k; q.vy -= dy * k;
    }
    for (const p of pts) {
      p.vx += (W / 2 - p.x) * 0.004; p.vy += (H / 2 - p.y) * 0.006;
      const v = Math.hypot(p.vx, p.vy), cap = 18 * heat + 1;
      if (v > cap) { p.vx *= cap / v; p.vy *= cap / v; }
      p.x += p.vx; p.y += p.vy; p.vx *= 0.5; p.vy *= 0.5;
    }
  }
  const pad = 60, xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const sc = Math.min((W - pad * 2) / (x1 - x0 || 1), (H - pad * 2) / (y1 - y0 || 1));
  const fit = pts.map((p) => ({ x: pad + (p.x - x0) * sc + ((W - pad * 2) - (x1 - x0) * sc) / 2, y: pad + (p.y - y0) * sc + ((H - pad * 2) - (y1 - y0) * sc) / 2 }));
  for (let s = 0; s < 80; s++) { // then keep dots (and a little room) apart on screen, inside the box
    for (let i = 0; i < fit.length; i++) for (let j = i + 1; j < fit.length; j++) {
      const p = fit[i], q = fit[j], dx = p.x - q.x || 0.01, dy = p.y - q.y || 0.01, d = Math.hypot(dx, dy), min = rad[i] + rad[j] + 10;
      if (d < min) { const push = (min - d) / d / 2; p.x += dx * push; p.y += dy * push; q.x -= dx * push; q.y -= dy * push; }
    }
    for (let i = 0; i < fit.length; i++) { fit[i].x = Math.min(W - 10 - rad[i], Math.max(10 + rad[i], fit[i].x)); fit[i].y = Math.min(H - 10 - rad[i], Math.max(10 + rad[i], fit[i].y)); }
  }
  return new Map(nodes.map((n, i) => [n.id, fit[i]]));
}

export function MemoryMap() {
  const [data, setData] = useState<{ nodes: GNode[]; links: GLink[] } | null>(null);
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState<Set<NodeKind>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [q, setQ] = useState('');
  // the most-mentioned few by default, every name readable (D, 2026-10-28: "does the graph make sense?"); Show all draws everything
  const [all, setAll] = useState(false);
  // a phone shows the top 12: 22 names do not fit a 390px map (D, 2026-10-28: phone check)
  const [TOP, setTop] = useState(22);
  useEffect(() => { if (window.innerWidth < 768) setTop(12); }, []);
  const [extra, setExtra] = useState<Set<string>>(new Set()); // nodes opened from search or the side panel stay on the map
  const [view, setView] = useState({ x: 0, y: 0, k: 1 }); // screen = world * k + (x, y), in viewBox units
  const svgRef = useRef<SVGSVGElement>(null);
  const [px, setPx] = useState(0.5); // screen pixels per map unit at zoom 1, so text and lines stay a fixed size on screen
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width) setPx(Math.min(r.width / W, r.height / H)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);
  // one clock for the motion: ms since the map was laid out (unfold) and since load (drift, light); stops when the tab is hidden
  const [clock, setClock] = useState(0);
  const born = useRef(0);
  useEffect(() => {
    if (!data || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setClock(1e9); return; }
    let raf = 0, last = 0;
    const tick = (t: number) => { if (t - last > 33) { last = t; setClock(t); } raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data]);
  const glide = useRef(0);
  const viewNow = useRef(view);
  viewNow.current = view;
  const animateView = useCallback((to: { x: number; y: number; k: number }) => {
    cancelAnimationFrame(glide.current);
    const from = viewNow.current, t0 = performance.now();
    const step = (t: number) => {
      const e = Math.min(1, (t - t0) / 450), k = 1 - (1 - e) ** 3;
      setView({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, k: from.k + (to.k - from.k) * k });
      if (e < 1) glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  }, []);
  const drag = useRef<{ pointers: Map<number, { x: number; y: number }>; last?: { x: number; y: number }; dist?: number; moved: boolean }>({ pointers: new Map(), moved: false });

  useEffect(() => {
    fetch('/api/ai/graph').then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the map.')))).then(setData).catch((e: Error) => setErr(e.message));
  }, []);
  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const maxW = useMemo(() => Math.max(1, ...(data?.nodes ?? []).map((n) => n.weight)), [data]);
  const maxL = useMemo(() => Math.max(1, ...(data?.links ?? []).filter((l) => !l.rel).map((l) => l.w)), [data]);
  const kept = useMemo(() => (data?.nodes ?? []).filter((n) => !hidden.has(n.kind)), [data, hidden]);
  const nodes = useMemo(() => {
    if (all) return kept;
    const top = new Set([...kept].sort((a, b) => b.weight - a.weight).slice(0, TOP).map((n) => n.id));
    return kept.filter((n) => top.has(n.id) || extra.has(n.id));
  }, [kept, all, extra, TOP]);
  const links = useMemo(() => { const ok = new Set(nodes.map((n) => n.id)); return (data?.links ?? []).filter((l) => ok.has(l.a) && ok.has(l.b)); }, [data, nodes]);
  const pos = useMemo(() => layout(nodes, links), [nodes, links]);
  useEffect(() => { born.current = performance.now(); }, [pos]);
  // where each dot is drawn now: unfolding from the centre for the first 0.9 s (bigger dots first), then a slow drift around its place
  const age = clock >= 1e9 ? 1e9 : Math.max(0, clock - born.current);
  const at = useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    nodes.forEach((n, i) => {
      const p = pos.get(n.id)!, e = Math.min(1, Math.max(0, (age - (i % 12) * 25) / 900)), k = 1 - (1 - e) ** 3;
      const ph = i * 2.39, d = age >= 1e9 ? 0 : 3;
      out.set(n.id, { x: W / 2 + (p.x - W / 2) * k + d * Math.sin(age / 2400 + ph), y: H / 2 + (p.y - H / 2) * k + d * Math.cos(age / 2900 + ph) });
    });
    return out;
  }, [nodes, pos, age]);
  const u = 1 / (view.k * px); // one screen pixel in map units at this zoom
  const near = useMemo(() => (sel ? new Set(links.filter((l) => l.a === sel || l.b === sel).flatMap((l) => [l.a, l.b])) : null), [sel, links]);
  const top = useMemo(() => new Set([...nodes].sort((a, b) => b.weight - a.weight).slice(0, 24).map((n) => n.id)), [nodes]);

  // a screen point (client px) in viewBox units (the svg keeps its aspect, centred)
  const toBox = useCallback((cx: number, cy: number) => {
    const r = svgRef.current!.getBoundingClientRect(), s = Math.max(W / r.width, H / r.height);
    return { x: (cx - r.left) * s - (r.width * s - W) / 2, y: (cy - r.top) * s - (r.height * s - H) / 2 };
  }, []);
  const zoomAt = useCallback((f: number, at = { x: W / 2, y: H / 2 }) => setView((v) => {
    const k = Math.min(8, Math.max(0.4, v.k * f)), g = k / v.k;
    return { k, x: at.x - (at.x - v.x) * g, y: at.y - (at.y - v.y) * g };
  }), []);
  // the middle of the map left of the floating side panel (380 px + gaps on desktop), in viewBox units
  const midX = useCallback(() => { const r = svgRef.current?.getBoundingClientRect(); return r && r.width >= 700 ? W / 2 - (200 / r.width) * W : W / 2; }, []);
  const focus = useCallback((id: string, zoom = true) => {
    if (!pos.has(id)) { setExtra((x) => new Set(x).add(id)); setSel(id); return; } // drawn on the next layout; the view stays
    const p = pos.get(id)!;
    setSel(id);
    const k = zoom ? Math.max(viewNow.current.k, 2.2) : viewNow.current.k;
    animateView({ k, x: midX() - p.x * k, y: H / 2 - p.y * k });
  }, [pos, animateView, midX]);
  useEffect(() => { // wheel zoom (not passive, so the page does not scroll instead)
    const el = svgRef.current;
    if (!el) return;
    const on = (e: WheelEvent) => { e.preventDefault(); cancelAnimationFrame(glide.current); zoomAt(Math.exp(-e.deltaY * 0.0015), toBox(e.clientX, e.clientY)); };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, [zoomAt, toBox, data]);
  useEffect(() => {
    if (!sel) return;
    let live = true;
    setDetail(null);
    fetch(`/api/ai/graph?node=${encodeURIComponent(sel)}`).then((r) => r.json()).then((d) => { if (live && !d.error) setDetail(d); }).catch(() => {});
    return () => { live = false; };
  }, [sel]);

  const onDown = (e: React.PointerEvent) => { cancelAnimationFrame(glide.current); drag.current.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); drag.current.moved = false; drag.current.last = toBox(e.clientX, e.clientY); drag.current.dist = undefined; };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.pointers.has(e.pointerId)) return;
    d.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const ps = [...d.pointers.values()];
    if (ps.length >= 2) { // pinch
      const a = toBox(ps[0].x, ps[0].y), b = toBox(ps[1].x, ps[1].y), dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (d.dist) zoomAt(dist / d.dist, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      d.dist = dist; d.moved = true;
      return;
    }
    const p = toBox(e.clientX, e.clientY), last = d.last ?? p;
    if (Math.hypot(p.x - last.x, p.y - last.y) > 3) d.moved = true;
    if (d.moved) setView((v) => ({ ...v, x: v.x + p.x - last.x, y: v.y + p.y - last.y }));
    d.last = p;
  };
  const onUp = (e: React.PointerEvent) => { drag.current.pointers.delete(e.pointerId); drag.current.dist = undefined; drag.current.last = undefined; };

  const matches = q.trim().length < 2 ? [] : (data?.nodes ?? []).filter((n) => n.name.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => b.weight - a.weight).slice(0, 8);
  const s = sel ? byId.get(sel) : undefined;
  const conns = sel ? (data?.links ?? []).filter((l) => l.a === sel || l.b === sel).map((l) => ({ ...l, other: byId.get(l.a === sel ? l.b : l.a) }))
    .filter((c): c is GLink & { other: GNode } => !!c.other).sort((x, y) => Number(!!y.rel) - Number(!!x.rel) || y.w - x.w) : [];
  const counts = Object.fromEntries(KINDS.map((k) => [k.kind, (data?.nodes ?? []).filter((n) => n.kind === k.kind).length])) as Record<NodeKind, number>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 md:px-6">
        <span className="mr-2 text-[15px] font-semibold">Graph</span>
        <div className="relative min-w-[200px] flex-1 md:max-w-[320px]">
          <IconSearch size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a rep, contract, channel or doc" aria-label="Find in the graph"
            onKeyDown={(e) => { if (e.key === 'Enter' && matches[0]) { focus(matches[0].id); setQ(''); } if (e.key === 'Escape') setQ(''); }}
            className="glass-pill h-9 w-full rounded-full pl-8 pr-3 text-[13px] outline-none" />
          {matches.length > 0 && (
            <div className="lg-pop absolute left-0 right-0 top-10 z-20 overflow-hidden rounded-xl">
              {matches.map((m) => (
                <button key={m.id} type="button" onClick={() => { focus(m.id); setQ(''); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-muted">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: COLOR[m.kind] }} /><span className="min-w-0 flex-1 truncate">{m.name}</span><span className="text-[11.5px] text-muted-foreground">{LABEL[m.kind]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {KINDS.filter((k) => counts[k.kind]).map((k) => (
            <button key={k.kind} type="button" aria-pressed={!hidden.has(k.kind)} onClick={() => setHidden((h) => { const n = new Set(h); if (n.has(k.kind)) n.delete(k.kind); else n.add(k.kind); return n; })}
              className={cn('flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold', hidden.has(k.kind) ? 'bg-muted text-muted-foreground/60 line-through' : 'bg-muted text-foreground')}>
              <span className="size-2.5 rounded-full" style={{ background: k.color }} />{k.label} <span className="font-normal text-muted-foreground">{counts[k.kind]}</span>
            </button>
          ))}
        </div>
        <Link href="/ai/memory" className="ml-auto text-[12.5px] font-semibold text-muted-foreground hover:text-foreground hover:underline">Memory</Link>
      </div>
      <div className="relative flex min-h-0 flex-1 gap-3 p-3 md:p-4">
        <div className="lg-glass relative min-w-0 flex-1 overflow-hidden rounded-[22px]">
          {!data && <div className="p-6 text-[13px] text-muted-foreground">{err || 'Drawing the map…'}</div>}
          {data && !data.nodes.length && <div className="p-6 text-[13px] text-muted-foreground">Nothing in team memory names a rep or contract yet.</div>}
          {data && data.nodes.length > 0 && (
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full touch-none select-none"
              role="img" aria-label="Map of team memory" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={onUp}
              onClick={() => { if (!drag.current.moved) setSel(null); }}>
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {links.map((l, i) => {
                  const p = at.get(l.a)!, q2 = at.get(l.b)!, on = !sel || l.a === sel || l.b === sel;
                  return <line key={i} x1={p.x} y1={p.y} x2={q2.x} y2={q2.y} stroke="currentColor" className={l.rel ? 'text-foreground' : 'text-muted-foreground'}
                    strokeWidth={(l.rel ? 1.6 : 0.5 + 2 * (l.w / maxL)) * u} strokeOpacity={on ? (l.rel ? 0.75 : sel ? 0.5 : 0.09) : 0.03} />;
                })}
                {/* light running along the picked dot's lines, outward */}
                {sel && age < 1e9 && links.filter((l) => l.a === sel || l.b === sel).map((l, i) => {
                  const a = at.get(sel)!, b = at.get(l.a === sel ? l.b : l.a)!;
                  return [0, 0.5].map((o) => { const f = ((age / 1600 + o + i * 0.13) % 1); return (
                    <circle key={`${i}-${o}`} cx={a.x + (b.x - a.x) * f} cy={a.y + (b.y - a.y) * f} r={2.6 * u} fill="var(--color-primary)" opacity={Math.sin(f * Math.PI) * 0.9} />
                  ); });
                })}
                {nodes.map((n) => {
                  const p = at.get(n.id)!, r = radius(n, maxW), on = !near || near.has(n.id);
                  const label = !all || n.id === sel || (near?.has(n.id) ?? false) || (!near && (top.has(n.id) || r / u > 9 || view.k * px > 1.2));
                  return (
                    <g key={n.id} opacity={on ? 1 : 0.15} className="cursor-pointer transition-opacity duration-300"
                      onClick={(e) => { e.stopPropagation(); if (drag.current.moved) return; if (n.id === sel) setSel(null); else focus(n.id, false); }}>
                      <title>{`${n.name} (${LABEL[n.kind]})`}</title>
                      {n.id === sel && <circle cx={p.x} cy={p.y} r={Math.max(r, 3.5 * u)} fill="none" stroke={COLOR[n.kind]} strokeWidth={2 * u} className="graph-pulse" />}
                      <circle cx={p.x} cy={p.y} r={Math.max(r, 3.5 * u)} fill={COLOR[n.kind]} stroke={n.id === sel ? 'var(--foreground)' : 'var(--background)'} strokeWidth={(n.id === sel ? 2.5 : 1) * u} />
                      {label && <text x={p.x} y={p.y + Math.max(r, 3.5 * u) + 13 * u} textAnchor="middle" fontSize={12 * u} fontWeight={top.has(n.id) || n.id === sel ? 600 : 400} className="fill-foreground"
                        style={{ paintOrder: 'stroke', stroke: 'var(--card)', strokeWidth: 3 * u }}>{n.name.length > 34 ? `${n.name.slice(0, 33)}…` : n.name}</text>}
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          {data && data.nodes.length > 0 && (
            <div className="glass-pill absolute bottom-3 left-3 flex flex-col overflow-hidden rounded-2xl">
              <button type="button" aria-label="Zoom in" onClick={() => animateView({ k: Math.min(8, view.k * 1.4), x: W / 2 - (W / 2 - view.x) * (Math.min(8, view.k * 1.4) / view.k), y: H / 2 - (H / 2 - view.y) * (Math.min(8, view.k * 1.4) / view.k) })} className="grid size-9 place-items-center hover:bg-muted"><IconPlus size={16} /></button>
              <button type="button" aria-label="Zoom out" onClick={() => animateView({ k: Math.max(0.4, view.k / 1.4), x: W / 2 - (W / 2 - view.x) * (Math.max(0.4, view.k / 1.4) / view.k), y: H / 2 - (H / 2 - view.y) * (Math.max(0.4, view.k / 1.4) / view.k) })} className="grid size-9 place-items-center border-t border-border hover:bg-muted"><IconMinus size={16} /></button>
              <button type="button" aria-label="Fit the whole map" onClick={() => animateView({ x: 0, y: 0, k: 1 })} className="grid size-9 place-items-center border-t border-border hover:bg-muted"><IconFocusCentered size={16} /></button>
            </div>
          )}
          {data && data.nodes.length > 0 && (
            <div className={cn('absolute bottom-3 right-3 flex max-w-[420px] flex-col items-end gap-1.5 text-right', s && 'hidden')}>
              <button type="button" onClick={() => { setAll((a) => !a); animateView({ x: 0, y: 0, k: 1 }); }}
                className="glass-pill rounded-full px-3 py-1.5 text-[12.5px] font-semibold">{all ? `Show the top ${TOP}` : `Show all ${kept.length}`}</button>
              <span className="hidden text-[11.5px] leading-[16px] text-muted-foreground md:block">
                {all ? `All ${kept.length}` : `The most-mentioned ${Math.min(TOP, kept.length)} of ${kept.length}`} · bigger = more memory · solid line = a relationship the AI drew, faint = named together. Scroll to zoom, drag to move, click a dot.
              </span>
            </div>
          )}
        </div>
        {s && (
          <aside className="lg-glass graph-panel absolute inset-x-3 bottom-3 z-10 max-h-[60%] overflow-y-auto rounded-[22px] md:inset-x-auto md:bottom-7 md:right-7 md:top-7 md:max-h-none md:w-[380px]">
            <div className="flex items-start gap-2 border-b border-border px-4 py-3">
              <span className="mt-1.5 size-3 shrink-0 rounded-full" style={{ background: COLOR[s.kind] }} />
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold leading-5">{s.name}</div>
                <div className="text-[12px] text-muted-foreground">{LABEL[s.kind]} · {s.weight.toLocaleString()} {s.kind === 'person' || s.kind === 'agent' ? 'memory pieces name it' : 'mentions of reps and contracts'}</div>
              </div>
              <button type="button" aria-label="Close" onClick={() => setSel(null)} className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><IconX size={16} /></button>
            </div>
            {detail?.profile && (
              <div className="border-b border-border px-4 py-3 text-[13px] leading-[20px]">{detail.profile}
                <span className="mt-1 block text-[11.5px] text-muted-foreground">Profile written {detail.profiled ? new Date(detail.profiled).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''} from memory</span></div>
            )}
            {conns.length > 0 && (
              <div className="border-b border-border px-4 py-3">
                <div className="mb-1.5 text-[12px] font-semibold text-muted-foreground">Connections ({conns.length})</div>
                <div className="flex flex-col">
                  {conns.slice(0, 40).map((c, i) => (
                    <button key={i} type="button" onClick={() => focus(c.other.id)} className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted">
                      <span className="size-2.5 shrink-0 rounded-full" style={{ background: COLOR[c.other.kind] }} />
                      <span className="min-w-0 flex-1 truncate">{c.rel ? <><span className="text-muted-foreground">{c.a === sel ? c.rel : `${c.rel} (of)`}</span> {c.other.name}</> : c.other.name}</span>
                      <span className="shrink-0 text-[11.5px] text-muted-foreground">{c.rel ? 'relationship' : `${c.w}×`}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="px-4 py-3">
              <div className="mb-1.5 text-[12px] font-semibold text-muted-foreground">Newest memory</div>
              {!detail && <div className="text-[13px] text-muted-foreground">Loading…</div>}
              {detail && !detail.pieces.length && <div className="text-[13px] text-muted-foreground">Nothing yet.</div>}
              <div className="flex flex-col gap-3">
                {detail?.pieces.map((p, i) => (
                  <div key={i} className="text-[13px] leading-[19px]">
                    <div className="text-[11.5px] text-muted-foreground">{PIECE[p.kind] ?? p.kind}{p.at ? ` · ${p.at.slice(0, 10)}` : ''}</div>
                    <div className="font-semibold">{p.title}</div>
                    <div className="line-clamp-3 text-foreground/80">{p.body}</div>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
