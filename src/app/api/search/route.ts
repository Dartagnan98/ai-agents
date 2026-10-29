import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getGrant, sessionUserId } from '@/lib/user-access';
import { searchDocs } from '@/lib/knowledge/docs';
import { listAgents, listSkills, listThreads } from '@/lib/ai/store';
import { listRoutines } from '@/lib/ai/routines';

export const dynamic = 'force-dynamic';

// The top bar search (⌘K): agents, this login's conversations, skills, routines and Knowledge documents. Every hit is a link it can open.
export interface SearchHit { kind: 'agent' | 'chat' | 'skill' | 'routine' | 'doc'; title: string; sub: string; href: string }
const LIMIT = 8;

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 120);
  const uid = sessionUserId(await auth());
  if (!uid) return NextResponse.json({ error: 'Sign in.' }, { status: 401 });
  if (q.length < 2) return NextResponse.json({ hits: [] });
  const lc = q.toLowerCase(), has = (...s: (string | undefined)[]) => s.some((x) => x?.toLowerCase().includes(lc));
  const admin = ['owner', 'admin'].includes(getGrant(uid).role);
  const hits: SearchHit[] = [];
  if (admin) for (const a of listAgents(uid).filter((x) => has(x.name, x.description)).slice(0, LIMIT)) hits.push({ kind: 'agent', title: a.name, sub: a.description || 'Agent', href: '/ai/agents' });
  for (const t of listThreads(uid, q).slice(0, LIMIT)) hits.push({ kind: 'chat', title: t.title || 'Conversation', sub: 'Conversation', href: `/ai?thread=${t.id}` });
  for (const s of listSkills(uid).filter((x) => has(x.name, x.title, x.description)).slice(0, LIMIT)) hits.push({ kind: 'skill', title: `/${s.name}`, sub: s.description || s.title || 'Skill', href: `/ai/skills/${s.name}` });
  if (admin) for (const r of listRoutines(uid).filter((x) => has(x.name, x.prompt)).slice(0, LIMIT)) hits.push({ kind: 'routine', title: r.name, sub: r.enabled ? 'Routine' : 'Routine (off)', href: '/ai/routines' });
  if (admin) for (const d of searchDocs(q, { space: 'knowledge', limit: 5 })) hits.push({ kind: 'doc', title: d.title, sub: `Knowledge${d.folder ? ` · ${d.folder}` : ''}`, href: `/knowledge-base?doc=${d.id}` });
  return NextResponse.json({ hits });
}
