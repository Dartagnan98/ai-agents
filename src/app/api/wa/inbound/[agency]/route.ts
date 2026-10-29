import { handleInbound, hookTokenOk, type Inbound } from '@/lib/wa/inbound';
import { runWithTenant } from '@/lib/platform/context';
import { isMultiTenant } from '@/lib/platform/mode';

export const dynamic = 'force-dynamic';

// The WhatsApp bridges on this server post each allowed message here (lib/wa/numbers.ts sets WEBHOOK_URL with the agency, the number and
// its own token). Loopback only; the agent runs in the background so the bridge gets its answer at once.
export async function POST(req: Request, { params }: { params: Promise<{ agency: string }> }) {
  const { agency } = await params;
  const u = new URL(req.url), key = u.searchParams.get('n') ?? '';
  const host = (req.headers.get('host') ?? '').split(':')[0];
  // Next sets x-forwarded-for itself, so only the Host is checked; the number's own token is the real gate
  if (!['127.0.0.1', 'localhost'].includes(host)) return new Response('forbidden', { status: 403 });
  if (isMultiTenant() && !/^agc_[A-Za-z0-9]{20}$/.test(agency)) return new Response(null, { status: 404 });
  const run = <T,>(fn: () => T): T => (isMultiTenant() ? runWithTenant(agency, fn) : fn());
  const body = await req.json().catch(() => null) as Inbound | null;
  if (!run(() => hookTokenOk(key, u.searchParams.get('t')))) return new Response('unauthorized', { status: 401 });
  if (body) run(() => handleInbound(key, body, run));
  return new Response('ok');
}
