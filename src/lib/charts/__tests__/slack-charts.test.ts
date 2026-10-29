import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Charts in Slack (D, 2026-10-23): ctrl-chart and ctrl-table blocks become PNGs and image blocks; plain text is left alone.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/currency', () => ({ agencyCurrency: () => 'USD' }));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charts-'));
process.env.CHART_DIR = dir;
process.env.APP_URL = 'https://app.example.com';
const C = await import('../slack-charts');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

const text = `Booked calls, next 72 hours:
\`\`\`ctrl-chart
{"type":"bar","title":"ACME <booked> & open","x":"day","series":["booked","open"],"data":[{"day":"Oct 23","booked":12,"open":20},{"day":"Oct 24","booked":"9","open":14}]}
\`\`\`
\`\`\`ctrl-table
{"title":"Closers","columns":[{"key":"name","label":"Closer"},{"key":"open","label":"Open","type":"number"}],"rows":[{"name":"Benny Prince","open":25}]}
\`\`\`
\`\`\`ctrl-actions
{"actions":[{"label":"x","prompt":"y"}]}
\`\`\`
Done.`;

describe('slack charts', () => {
  it('draws charts and tables as PNGs, escapes text, drops other blocks', async () => {
    const { text: rest, images } = await C.chartImages(text);
    expect(images.map((i) => i.title)).toEqual(['ACME <booked> & open', 'Closers']);
    for (const i of images) expect(i.png.subarray(0, 4)).toEqual(PNG);
    expect(rest).toBe('Booked calls, next 72 hours:\n\nDone.');
    expect(C.chartSvg({ kind: 'bar', title: 'a<b', x: 'd', series: ['v'], data: [{ d: 'x', v: 1 }] })).toContain('a&lt;b');
    expect(C.chartSvg({ kind: 'pie', title: '', x: 'd', series: ['v'], data: [{ d: 'a', v: 3 }, { d: 'b', v: 1 }] })).toContain('75%');
    expect(C.chartSvg({ kind: 'line', title: '', x: 'd', series: ['v'], data: [{ d: 'a', v: -3 }, { d: 'b', v: 1 }] })).toContain('polyline');
  });
  it('Slack blocks: text sections + image blocks served by name; plain text untouched', async () => {
    const c = await C.slackWithCharts(text);
    const pics = (c.blocks ?? []).filter((b) => (b as { type: string }).type === 'image') as { image_url: string }[];
    expect(pics).toHaveLength(2);
    const name = pics[0].image_url.replace('https://app.example.com/api/chart-img/', '');
    expect(C.chartFile(name)).toBe(path.join(dir, name));
    expect(fs.existsSync(path.join(dir, name))).toBe(true);
    expect(C.chartFile('../etc/passwd')).toBeNull();
    expect(await C.slackWithCharts('just words')).toEqual({ text: 'just words' });
    const card = 'https://app.example.com/api/chart-img/' + 'a'.repeat(32) + '.png';
    const s = await C.slackWithCharts(`### GAMMA snapshot\n[View capacity card](${card})`) as { blocks: { type: string; image_url?: string }[] };
    expect(s.blocks.at(-1)).toMatchObject({ type: 'image', image_url: card }); // a published card shows as the picture
    const md = await C.slackWithCharts(`### BETA\n[View capacity card](${card})`, true) as { blocks: { type: string; text?: string; image_url?: string }[] };
    expect(md.blocks.map((b) => b.type)).toEqual(['markdown', 'image']); // a script's Markdown drawn by Slack, card attached
    const cap = await C.slackWithCharts('### BETA\n```ctrl-capacity\n' + JSON.stringify({ title: 'BETA', hours: 72, booked: 2, open: 3, days: [{ day: '2026-10-28', booked: 2, open: 3 }], closers: [] }) + '\n```', true) as { blocks: { type: string; text?: string }[] };
    expect(cap.blocks.map((b) => b.type)).toEqual(['markdown', 'image']);
    expect(cap.blocks[0].text).not.toContain('ctrl-capacity');

  });
});
