import { NextRequest } from 'next/server';
import { aiUser, aiDenied } from '@/lib/ai/access';
import { addMemory, agentLogs, agentNotes, clearMemory, deleteAgentNote, deleteMemory, editAgentNote, editMemory, lastMemoryRun, listAgents, listMemory, setStale } from '@/lib/ai/store';
import { nightlyMemory } from '@/lib/ai/memory-nightly';
import { addTeamItem, allTeamItems, deleteCommitment, deleteTeamItem, editTeamItem, listCommitments, searchMemory, setCommitment, setTeamStatus, teamStats } from '@/lib/ai/team-memory';
import { deleteEdge, entityStats } from '@/lib/ai/team-graph';
import { listLog, setCoreByPerson, undoChange } from '@/lib/ai/memory-layers';
import { getCore } from '@/lib/ai/store';

export const dynamic = 'force-dynamic';

// Memory (D, 2026-10-09, Memory page): this login's notes, the ones the AI saved with remember plus ones added here.
// Agent notebooks and daily logs (D, 2026-10-12): every agent this login can use, its notes (stale ones flagged) and its logs.
// Team memory (D, 2026-10-23, phase 2): the shared decisions and facts, what is ingested, and ?q= a search over all of it (as recall sees it).
export async function GET(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const q = req.nextUrl.searchParams.get('q');
  if (q !== null) return Response.json({ hits: q.trim().length < 2 ? [] : (await searchMemory(q.slice(0, 500), 15, 4000)).map(({ id, kind, title, body, at }) => ({ id, kind, title, body: body.slice(0, 1200), at })) });
  const agents = listAgents(me.uid).filter((a) => a.use_memory).map((a) => ({ id: a.id, name: a.name, icon: a.icon, color: a.color, notes: agentNotes(a.id, true), logs: agentLogs(a.id, 30), core: getCore(a.id) }));
  return Response.json({ notes: listMemory(me.uid, true), agents, lastRun: lastMemoryRun() ?? null, team: allTeamItems(), teamStats: teamStats(), commitments: listCommitments(), entities: entityStats(), log: listLog(me.uid) });
}

// { content } a new note of yours; ?nightly=1 runs the nightly memory pass for yesterday now (&day=YYYY-MM-DD: that day)
export async function POST(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  if (req.nextUrl.searchParams.get('nightly') === '1') { const d = req.nextUrl.searchParams.get('day'); return Response.json({ summary: await nightlyMemory({ force: true, day: d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined }) }); }
  // ?undo=<change> puts back what the AI changed; ?core=<agent> { body } rewrites what that agent always remembers (memory-layers.ts)
  const undo = Number(req.nextUrl.searchParams.get('undo')), core = Number(req.nextUrl.searchParams.get('core'));
  if (undo) { try { return Response.json({ ok: undoChange(undo, me.uid) }); } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); } }
  if (core) {
    const body = await req.json().catch(() => ({})) as { body?: string };
    if (!listAgents(me.uid).some((a) => a.id === core)) return Response.json({ error: 'Not found' }, { status: 404 });
    setCoreByPerson(core, String(body.body ?? ''), me.uid);
    return Response.json({ ok: true });
  }
  const b = await req.json().catch(() => ({})) as { content?: string; team?: 'decision' | 'fact' };
  const who = String(me.session?.user?.name ?? '').slice(0, 80);
  try {
    if (b.team) { // a team decision or fact added by hand, by this person, today
      const id = addTeamItem({ kind: b.team === 'fact' ? 'fact' : 'decision', content: String(b.content ?? ''), who, day: new Date().toISOString().slice(0, 10) });
      if (id) { const { syncTeam } = await import('@/lib/ai/team-memory'); syncTeam(); }
      return id ? Response.json({ id }) : Response.json({ error: 'Empty, or already in team memory.' }, { status: 400 });
    }
    return Response.json({ id: addMemory(me.uid, String(b.content ?? ''), null) });
  }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
}

// ?id= your note, ?agentNote= an agent's note; { content } edits it, { keep: true, agent } clears its stale flag
export async function PATCH(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const b = await req.json().catch(() => ({})) as { content?: string; keep?: boolean; agent?: number; retire?: boolean };
  const sp = req.nextUrl.searchParams, agentNote = Number(sp.get('agentNote')), id = Number(sp.get('id')), teamItem = Number(sp.get('teamItem'));
  try {
    // ?teamItem= : { content } edits it, { keep: true } makes it active again, { retire: true } marks it no longer true (agents stop reading it)
    // ?commitment= : { done: true } closes it, { done: false } opens it again
    const commitment = Number(sp.get('commitment'));
    if (commitment) return setCommitment(commitment, (b as { done?: boolean }).done === false ? 'open' : 'done') ? Response.json({ ok: true }) : Response.json({ error: 'Not found' }, { status: 404 });
    if (teamItem) {
      const ok = b.retire ? setTeamStatus(teamItem, 'stale') : b.keep ? setTeamStatus(teamItem, 'active') : editTeamItem(teamItem, String(b.content ?? ''));
      return ok ? Response.json({ ok: true }) : Response.json({ error: 'Not found' }, { status: 404 });
    }
    const ok = agentNote
      ? (b.keep ? setStale([agentNote], false, { agentId: Number(b.agent) }) > 0 : editAgentNote(agentNote, String(b.content ?? '')))
      : (b.keep ? setStale([id], false, { userId: me.uid }) > 0 : editMemory(me.uid, id, String(b.content ?? '')));
    return ok ? Response.json({ ok: true }) : Response.json({ error: 'Not found' }, { status: 404 });
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
}

// ?id= one note, ?all=1 every note of yours, ?agentNote= one agent note or log
export async function DELETE(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const sp = req.nextUrl.searchParams;
  if (sp.get('agentNote')) return Response.json({ ok: deleteAgentNote(Number(sp.get('agentNote'))) });
  if (sp.get('teamItem')) return Response.json({ ok: deleteTeamItem(Number(sp.get('teamItem'))) });
  if (sp.get('commitment')) return Response.json({ ok: deleteCommitment(Number(sp.get('commitment'))) });
  if (sp.get('edge')) return Response.json({ ok: deleteEdge(Number(sp.get('edge'))) }); // a wrong relationship
  if (sp.get('all') === '1') return Response.json({ deleted: clearMemory(me.uid) });
  return Response.json({ ok: deleteMemory(me.uid, Number(sp.get('id'))) });
}
