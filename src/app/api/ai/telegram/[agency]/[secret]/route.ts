import { NextRequest } from 'next/server';
import { handleUpdate } from '@/lib/ai/telegram';
import { runWithTenant } from '@/lib/platform/context';
import { isMultiTenant } from '@/lib/platform/mode';

export const dynamic = 'force-dynamic';

// Telegram webhook for the agents (D, 2026-10-09). Public path (the middleware lets it through); the secret in the path and Telegram's
// secret header must both match the agency's bot. Answers Telegram at once and works the reply in the background, so a slow AI
// turn never makes Telegram retry the update.
export async function POST(req: NextRequest, { params }: { params: Promise<{ agency: string; secret: string }> }) {
  const { agency, secret } = await params;
  const header = req.headers.get('x-telegram-bot-api-secret-token');
  const update = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!update || !/^[a-f0-9]{48}$/.test(secret)) return new Response(null, { status: 404 });
  const work = () => handleUpdate(secret, header, update).catch(() => false);
  if (isMultiTenant()) { if (!/^agc_[A-Za-z0-9]{20}$/.test(agency)) return new Response(null, { status: 404 }); void runWithTenant(agency, work); }
  else void work();
  return Response.json({ ok: true });
}
