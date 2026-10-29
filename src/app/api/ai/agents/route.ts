import { NextRequest } from 'next/server';
import { aiUser, aiDenied } from '@/lib/ai/access';
import { canEditAgent, cleanRole, createAgent, deleteAgent, getAgent, listAgents, updateAgent, type AgentInput } from '@/lib/ai/store';
import { DEFAULT_MODEL, findModel, MODEL_PROVIDERS } from '@/lib/ai/models';
import { AGENT_COLORS as COLORS, AGENT_ICONS as ICONS, TOOL_NAMES } from '@/lib/ai/catalog';
import { availableModels, availableProviders } from '@/lib/ai/available';
import { connectedApps } from '@/lib/ai/app-tools';

// an avatar as stored: an https link or a data:image URL, at most 200,000 characters; anything else is dropped
const cleanLogo = (v: unknown): string | undefined => { const s = typeof v === 'string' ? v.trim() : ''; return s && s.length <= 200_000 && (/^https:\/\/[^\s"'<>]+$/.test(s) || /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+\/=]+$/.test(s)) ? s : undefined; };

export const dynamic = 'force-dynamic';

// Agents (D, 2026-10-09, Agents page): install-wide, the owner and admins list, add, edit and remove them. GET also says
// which models can run here (only connected providers: the Claude subscription today), for the editor's model picker.

function input(b: Record<string, unknown>): AgentInput | string {
  const s = (k: string, max: number) => String(b[k] ?? '').trim().slice(0, max);
  const name = s('name', 60);
  if (!name) return 'Give the agent a name.';
  const model = findModel(String(b.model ?? ''))?.id ?? DEFAULT_MODEL;
  const tools = Array.isArray(b.tools) ? TOOL_NAMES.filter((n) => (b.tools as unknown[]).includes(n)) : [];
  const starters = Array.isArray(b.starters) ? (b.starters as unknown[]).map((x) => String(x).trim().slice(0, 160)).filter(Boolean).slice(0, 6) : [];
  return {
    name, description: s('description', 160), instructions: s('instructions', 8000), model, tools, use_memory: b.use_memory !== false, starters,
    icon: ICONS.includes(String(b.icon)) ? String(b.icon) : 'sparkles', color: COLORS.includes(String(b.color)) ? String(b.color) : 'ink',
    shared: b.shared !== false,
    ...(b.role !== undefined ? { role: cleanRole(b.role) } : {}), // the role card; a missing field keeps it
    // its own daily cap in API-price dollars (usage.ts); '' or 0 = none, a missing field keeps it
    ...(typeof b.night_shift === 'boolean' ? { night_shift: b.night_shift } : {}), // a Night shift card each night (tasks.ts)
    ...(b.daily_budget_usd !== undefined ? { daily_budget_usd: Number(b.daily_budget_usd) > 0 ? Math.min(10_000, Number(b.daily_budget_usd)) : null } : {}),
    apps: Array.isArray(b.apps) ? (b.apps as unknown[]).map(String).filter((x) => /^[a-z0-9_]{2,40}$/.test(x)).slice(0, 20) : [],
    // '' removes the avatar; a missing field keeps it
    ...(typeof b.avatar === 'string' ? { avatar: b.avatar === '' ? '' : cleanLogo(b.avatar) ?? '' } : {}),
  };
}

export async function GET() {
  const me = await aiUser();
  if (!me) return aiDenied();
  const on = availableProviders(), providers = MODEL_PROVIDERS.filter((p) => on.includes(p.id));
  return Response.json({ agents: listAgents(me.uid).map((a) => ({ ...a, can_edit: canEditAgent(a, me.uid, me.role) })), can_share: me.role === 'owner', models: availableModels(), providers, apps: await connectedApps() });
}

export async function POST(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const a = input(await req.json().catch(() => ({})));
  if (typeof a === 'string') return Response.json({ error: a }, { status: 400 });
  if (a.shared && me.role !== 'owner') a.shared = false; // only the owner makes team agents
  return Response.json({ agent: createAgent(a, me.uid) });
}

export async function PATCH(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const id = Number(req.nextUrl.searchParams.get('id'));
  const cur = getAgent(id);
  if (!cur || !canEditAgent(cur, me.uid, me.role)) return Response.json({ error: 'Only the owner changes team agents.' }, { status: 403 });
  const a = input(await req.json().catch(() => ({})));
  if (typeof a === 'string') return Response.json({ error: a }, { status: 400 });
  if (a.shared && me.role !== 'owner') a.shared = false;
  return updateAgent(id, a) ? Response.json({ agent: getAgent(id) }) : Response.json({ error: 'Not found' }, { status: 404 });
}

export async function DELETE(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const cur = getAgent(Number(req.nextUrl.searchParams.get('id')));
  if (!cur || !canEditAgent(cur, me.uid, me.role)) return Response.json({ error: 'Only the owner removes team agents.' }, { status: 403 });
  return deleteAgent(Number(req.nextUrl.searchParams.get('id'))) ? Response.json({ ok: true }) : Response.json({ error: 'The default agent cannot be removed.' }, { status: 400 });
}
