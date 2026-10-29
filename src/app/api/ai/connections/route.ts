import { NextRequest } from 'next/server';
import { aiUser, aiDenied } from '@/lib/ai/access';
import { isConnKind, listConnections, planSignOut, pollPlanSignIn, refreshPlanModels, removeConnection, saveKey, startPlanSignIn } from '@/lib/ai/connections';
import { availableProviders } from '@/lib/ai/available';
import { finishClaudeSignIn, startClaudeSignIn } from '@/lib/ai/claude-signin';
import { connectTelegram, disconnectTelegram, linkCode, linkedChats, telegramStatus, unlinkChats } from '@/lib/ai/telegram';
import { isMultiTenant } from '@/lib/platform/mode';
import { currentAgencySync } from '@/lib/platform/tenant-db';

export const dynamic = 'force-dynamic';

// Settings › AI connections (D, 2026-10-09). GET: every connection's status (never a secret) and which providers can run.
// POST {kind, action: 'save' | 'start' | 'poll' | 'refresh' | 'remove', key?}: the owner manages them.
export async function GET() {
  const me = await aiUser();
  if (!me) return aiDenied();
  return Response.json({ connections: listConnections(), available: availableProviders(), owner: me.role === 'owner', telegram: { ...telegramStatus(), linked: linkedChats(me.uid) } });
}

export async function POST(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const b = await req.json().catch(() => ({})) as { kind?: string; action?: string; key?: string; account?: string };
  // Slack (D, 2026-10-12): everyone with AI links their own Slack user with a code sent to the AI Agents bot in a DM ("link CODE")
  if (b.kind === 'slack' && b.action === 'link-code') return Response.json({ code: linkCode(me.uid) });
  // Telegram (D, 2026-10-09): everyone with AI links their own chat; the owner connects the bot
  if (b.kind === 'telegram') {
    if (b.action === 'link-code') return Response.json({ code: linkCode(me.uid), bot: telegramStatus().username });
    if (b.action === 'unlink') { unlinkChats(me.uid); return Response.json({ ok: true }); }
    if (me.role !== 'owner') return Response.json({ error: 'Only the owner connects the bot.' }, { status: 403 });
    if (b.action === 'connect') { const r = await connectTelegram(String(b.key ?? ''), isMultiTenant() ? currentAgencySync().id : 'default'); return r.ok ? Response.json(r) : Response.json({ error: r.error }, { status: 400 }); }
    if (b.action === 'disconnect') { await disconnectTelegram(); return Response.json({ ok: true }); }
    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  }
  if (me.role !== 'owner') return Response.json({ error: 'Only the owner connects AI.' }, { status: 403 });
  if (!isConnKind(b.kind)) return Response.json({ error: 'Unknown connection.' }, { status: 400 });
  const kind = b.kind;
  try {
    if (b.action === 'save') {
      if (kind === 'chatgpt-plan' || kind === 'grok-plan') return Response.json({ error: 'Plans sign in, they take no key.' }, { status: 400 });
      const r = await saveKey(kind, String(b.key ?? ''), me.uid);
      return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: 400 });
    }
    // the Claude subscription signs in through Claude Code's own setup-token on the server (lib/ai/claude-signin.ts)
    if (b.action === 'start' && kind === 'claude-token') return Response.json(await startClaudeSignIn());
    if (b.action === 'finish' && kind === 'claude-token') { const r = await finishClaudeSignIn(String(b.key ?? ''), me.uid, String(b.account ?? '')); return 'ok' in r ? Response.json(r) : Response.json({ error: r.error }, { status: 400 }); }
    if (b.action === 'start' && (kind === 'chatgpt-plan' || kind === 'grok-plan')) return Response.json(await startPlanSignIn(kind, me.uid));
    if (b.action === 'poll' && (kind === 'chatgpt-plan' || kind === 'grok-plan')) return Response.json(await pollPlanSignIn(kind, me.uid));
    if (b.action === 'refresh' && (kind === 'chatgpt-plan' || kind === 'grok-plan')) return Response.json({ models: await refreshPlanModels(kind) });
    if (b.action === 'remove') { if (kind === 'chatgpt-plan' || kind === 'grok-plan') await planSignOut(kind); else removeConnection(kind); return Response.json({ ok: true }); }
    return Response.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
