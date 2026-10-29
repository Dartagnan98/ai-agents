import { NextRequest } from 'next/server';
import { aiUser, aiDenied } from '@/lib/ai/access';
import { cronProblem, describeCron, nextRun } from '@/lib/ai/cron';
import { canEditRoutine, canSeeRoutine, createRoutine, deleteRoutine, getRoutine, listRoutines, listRuns, routineInput, setRoutineEnabled, setRoutineFolder, updateRoutine, type Routine } from '@/lib/ai/routines';
import { runRoutine } from '@/lib/ai/routine-run';
import { slackChannels, slackReady, telegramTargets } from '@/lib/ai/routine-deliver';

export const dynamic = 'force-dynamic';
export const maxDuration = 900;

// Routines (D, 2026-10-09, Routines page): team ones (everyone with AI access) and private ones (D, 2026-10-12); the owner and admins list, add, edit, switch on and off, run now
// and remove them. GET also says where results can go (Telegram bots set up in Settings, Slack when linked in Connectors).
// POST ?run=<id> runs one now and answers when it ends.

const view = (r: Routine, me: { uid: number; role: string }) => ({ ...r, schedule_text: describeCron(r.schedule), can_edit: canEditRoutine(r, me.uid, me.role) });

const input = routineInput;

export async function GET(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const runs = Number(req.nextUrl.searchParams.get('runs'));
  if (runs) { const r = getRoutine(runs); return r && canSeeRoutine(r, me.uid) ? Response.json({ runs: listRuns(runs) }) : Response.json({ error: 'Not found' }, { status: 404 }); }
  return Response.json({ can_share: me.role === 'owner', routines: listRoutines(me.uid).map((r) => view(r, me)), telegram: telegramTargets(), slack: await slackReady().catch(() => false), slackChannels: await slackChannels() });
}

export async function POST(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const runId = Number(req.nextUrl.searchParams.get('run'));
  if (runId) {
    const rt = getRoutine(runId);
    if (!rt || !canSeeRoutine(rt, me.uid)) return Response.json({ error: 'Not found' }, { status: 404 });
    const out = await runRoutine(runId, 'manual');
    return 'refused' in out ? Response.json({ error: out.refused }, { status: 409 }) : Response.json({ run: out, routine: view(getRoutine(runId)!, me) });
  }
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  // a schedule check for the editor: { check: "<cron>" } -> words + the next run, or the reason it is not valid
  if (typeof body.check === 'string') {
    const problem = cronProblem(body.check);
    return Response.json(problem ? { error: problem } : { text: describeCron(body.check), next: nextRun(body.check) });
  }
  const a = input(body, me.uid, me.role);
  if (typeof a === 'string') return Response.json({ error: a }, { status: 400 });
  return Response.json({ routine: view(createRoutine({ ...a, shared: a.shared ?? false }, me.uid), me) });
}

export async function PATCH(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const id = Number(req.nextUrl.searchParams.get('id'));
  const cur = getRoutine(id);
  if (!cur || !canSeeRoutine(cur, me.uid)) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!canEditRoutine(cur, me.uid, me.role)) return Response.json({ error: 'A team routine: only the owner or its maker changes it.' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  // the list's switch sends only { enabled }
  if (Object.keys(body).length === 1 && typeof body.enabled === 'boolean') return Response.json({ routine: view(setRoutineEnabled(id, body.enabled)!, me) });
  // the list's Move to folder sends only { folder }
  if (Object.keys(body).length === 1 && 'folder' in body) return Response.json({ routine: view(setRoutineFolder(id, String(body.folder ?? ''))!, me) });
  // the editor does not send script / condition_script yet: they stay as they are (and a script routine keeps its 5-minute floor)
  const a = input({ script: cur.script, condition_script: cur.condition_script, ...body }, me.uid, me.role);
  if (typeof a === 'string') return Response.json({ error: a }, { status: 400 });
  return Response.json({ routine: view(updateRoutine(id, a)!, me) });
}

export async function DELETE(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const cur = getRoutine(Number(req.nextUrl.searchParams.get('id')));
  if (!cur || !canSeeRoutine(cur, me.uid)) return Response.json({ error: 'Not found' }, { status: 404 });
  if (!canEditRoutine(cur, me.uid, me.role)) return Response.json({ error: 'A team routine: only the owner or its maker removes it.' }, { status: 403 });
  return deleteRoutine(cur.id) ? Response.json({ ok: true }) : Response.json({ error: 'Not found' }, { status: 404 });
}
