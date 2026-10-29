import fs from 'fs';
import { chartFile } from '@/lib/charts/slack-charts';

export const dynamic = 'force-dynamic';

// A chart image from a Slack post (lib/charts/slack-charts.ts), public: the random file name is the key. Private cache, a week: a
// forwarded link does not live on in shared caches (audit 2026-10-23); the file itself is kept 90 days for Slack's history.
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const f = chartFile((await ctx.params).name);
  if (!f || !fs.existsSync(f)) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(f)), { headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=604800', 'x-robots-tag': 'noindex' } });
}
