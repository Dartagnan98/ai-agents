import { describe, expect, it } from 'vitest';
import { ctrlView, parseBlocks, parseInline, plainText, safeHref } from '@/components/ai/blocks';

// Fleet AI rich blocks (D, 2026-10-09): ctrl-* fences parse into views, bad JSON falls back to a code block.
const fence = (lang: string, body: string) => `Intro line.\n\n\`\`\`${lang}\n${body}\n\`\`\`\n\nAfter.`;
const view = (src: string) => { const b = parseBlocks(src).find((x) => x.k === 'code'); if (!b || b.k !== 'code') throw new Error('no fence'); return ctrlView(b); };

describe('ctrl blocks', () => {
  it('parses a ctrl-table with object rows', () => {
    const v = view(fence('ctrl-table', JSON.stringify({ title: 'Closers', columns: ['Rep', { key: 'cash', label: 'Cash', type: 'money' }], rows: [{ Rep: 'Ana', cash: 1200 }, { Rep: 'Ben', cash: 800 }] })));
    expect(v.v).toBe('table');
    if (v.v !== 'table') return;
    expect(v.title).toBe('Closers');
    expect(v.cols.map((c) => c.label)).toEqual(['Rep', 'Cash']);
    expect(v.rows).toEqual([['Ana', 1200], ['Ben', 800]]);
  });

  it('parses a ctrl-chart and keeps only real series', () => {
    const v = view(fence('ctrl-chart', JSON.stringify({ type: 'line', x: 'week', series: ['cash', 'nope'], data: [{ week: 'W1', cash: '1,200' }, { week: 'W2', cash: 900 }] })));
    expect(v.v).toBe('chart');
    if (v.v !== 'chart') return;
    expect(v.chart.kind).toBe('line');
    expect(v.chart.series).toEqual(['cash']);
    expect(v.chart.data[0].cash).toBe(1200);
  });

  it('parses ctrl-actions (prompt and url) and drops actions with neither', () => {
    const v = view(fence('ctrl-actions', JSON.stringify({ actions: [{ label: 'Compare', prompt: 'Compare with last month' }, { label: 'Invoices', url: '/b/acme/money?part=invoices' }, { label: 'Nothing' }] })));
    expect(v.v).toBe('actions');
    if (v.v !== 'actions') return;
    expect(v.actions.map((a) => a.label)).toEqual(['Compare', 'Invoices']);
  });

  it('falls back to a code block on bad JSON or a shape that does not fit', () => {
    expect(view(fence('ctrl-table', '{"rows": [1, 2'))).toEqual({ v: 'code', lang: 'ctrl-table', text: '{"rows": [1, 2' });
    expect(view(fence('ctrl-chart', '{"data": []}')).v).toBe('code');
  });

  it('marks a fence still streaming as waiting', () => {
    expect(view('```ctrl-table\n{"rows": [')).toEqual({ v: 'wait', label: 'table' });
  });

  it('reads pipe tables, lists and paragraphs', () => {
    const b = parseBlocks('Hi\n\n| Rep | Cash |\n| --- | ---: |\n| Ana | $1,200 |\n\n- one\n- two');
    expect(b.map((x) => x.k)).toEqual(['p', 'table', 'ul']);
  });

  it('links only http(s) and in-app paths', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('//evil.com')).toBeNull();
    expect(safeHref('/b/acme/money')).toBe('/b/acme/money');
    expect(parseInline('see [x](javascript:alert(1)) and **bold**').map((p) => p.t)).toEqual(['text', 'text', 'text', 'b']);
  });

  it('copies a ctrl-table as tab-separated text', () => {
    expect(plainText(fence('ctrl-table', JSON.stringify({ columns: ['Rep', 'Cash'], rows: [['Ana', 1200]] })))).toBe('Intro line.\n\nRep\tCash\nAna\t1200\n\nAfter.');
  });
});
