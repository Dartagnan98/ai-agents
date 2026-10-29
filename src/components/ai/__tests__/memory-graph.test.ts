import { describe, expect, it } from 'vitest';
import { H, layout, radius, W } from '../memory-graph';

// The Memory graph's layout (D, 2026-10-23): same input, same picture; every dot inside the box and apart from the others.
describe('memory graph layout', () => {
  it('is stable, in the box, without overlaps', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `e:${i + 1}`, kind: (i < 3 ? 'agent' : 'person') as 'person' | 'agent', name: `n${i}`, weight: i < 3 ? 400 : 5 + i }));
    const links = nodes.slice(3).map((n, i) => ({ a: `e:${1 + (i % 3)}`, b: n.id, w: 3 + (i % 7) }));
    const a = layout(nodes, links), b = layout(nodes, links);
    expect([...a.values()]).toEqual([...b.values()]);
    const pts = nodes.map((n) => ({ ...a.get(n.id)!, r: radius(n, 400) }));
    for (const p of pts) { expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(W); expect(p.y).toBeGreaterThan(0); expect(p.y).toBeLessThan(H); }
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) expect(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)).toBeGreaterThan(pts[i].r + pts[j].r);
  });
});
