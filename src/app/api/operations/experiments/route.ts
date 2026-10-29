import { NextRequest } from 'next/server';
import { opsAccess } from '@/lib/operations/access';
import { cleanExperiment, deleteExperiment, EXP_STATUSES, experimentSummary, getExperiment, listExperiments, saveExperiment, type ExpStatus } from '@/lib/operations/store';

export const dynamic = 'force-dynamic';

// Experiments per agency (D, 2026-10-10): a simple log of tests (hypothesis, metric, start and end, result, keep or discard) in the
// agency's own SQLite. Owner, or an admin with the Experiments page. Fleet AI reads them with read_experiments and proposes new ones
// with propose_experiment (an approve card).
const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function GET(req: NextRequest) {
  const me = await opsAccess('/experiments'); if (me instanceof Response) return me;
  const id = Number(req.nextUrl.searchParams.get('id'));
  if (id) { const e = getExperiment(id); return e ? Response.json({ experiment: e }) : bad('Not found.', 404); }
  const status = req.nextUrl.searchParams.get('status');
  const list = listExperiments(EXP_STATUSES.includes(status as ExpStatus) ? status as ExpStatus : undefined);
  return Response.json({ experiments: list, summary: experimentSummary(status ? listExperiments() : list) });
}

async function save(req: NextRequest, id?: number) {
  const me = await opsAccess('/experiments'); if (me instanceof Response) return me;
  const cur = id !== undefined ? getExperiment(id) : undefined;
  if (id !== undefined && !cur) return bad('Not found.', 404);
  const e = cleanExperiment(await req.json().catch(() => ({})), cur);
  if (typeof e === 'string') return bad(e);
  try { return Response.json({ experiment: saveExperiment(me.uid, e, id) }); }
  catch (err) { return bad(err instanceof Error ? err.message : String(err)); }
}
export const POST = (req: NextRequest) => save(req);
export const PATCH = (req: NextRequest) => save(req, Number(req.nextUrl.searchParams.get('id')) || -1);

export async function DELETE(req: NextRequest) {
  const me = await opsAccess('/experiments'); if (me instanceof Response) return me;
  return deleteExperiment(Number(req.nextUrl.searchParams.get('id'))) ? Response.json({ ok: true }) : bad('Not found.', 404);
}
