import { NextRequest } from 'next/server';
import { opsAccess } from '@/lib/operations/access';
import { addGoal, deleteGoal, getStrategy, goalHistory, isStrategyField, listGoals, saveGoals, setStrategyField } from '@/lib/operations/store';

export const dynamic = 'force-dynamic';

// Strategy per agency (D, 2026-10-10): north star, bottleneck, daily focus, goals with progress, history. The agency's own SQLite rows;
// owner, or an admin with the Strategy page. GET = everything; PATCH {field, value} = one strategy line; POST {title} = add a goal;
// PUT {goals: [{id, title, progress}]} = save the list in that order; DELETE ?id = remove a goal.
const bad = (error: string, status = 400) => Response.json({ error }, { status });
const all = () => ({ strategy: getStrategy(), goals: listGoals(), history: goalHistory() });

export async function GET() {
  const me = await opsAccess('/strategy'); if (me instanceof Response) return me;
  return Response.json(all());
}

export async function PATCH(req: NextRequest) {
  const me = await opsAccess('/strategy'); if (me instanceof Response) return me;
  const b = await req.json().catch(() => ({})) as { field?: unknown; value?: unknown };
  if (!isStrategyField(b.field)) return bad('Unknown field.');
  setStrategyField(b.field, String(b.value ?? ''), me.uid);
  return Response.json(all());
}

export async function POST(req: NextRequest) {
  const me = await opsAccess('/strategy'); if (me instanceof Response) return me;
  const b = await req.json().catch(() => ({})) as { title?: unknown };
  const g = addGoal(String(b.title ?? ''), me.uid);
  return typeof g === 'string' ? bad(g) : Response.json(all());
}

export async function PUT(req: NextRequest) {
  const me = await opsAccess('/strategy'); if (me instanceof Response) return me;
  const b = await req.json().catch(() => ({})) as { goals?: unknown };
  if (!Array.isArray(b.goals)) return bad('Send the goals list.');
  saveGoals(b.goals.filter((g): g is { id: number; title?: string; progress?: number } => !!g && typeof g === 'object').slice(0, 200), me.uid);
  return Response.json(all());
}

export async function DELETE(req: NextRequest) {
  const me = await opsAccess('/strategy'); if (me instanceof Response) return me;
  return deleteGoal(Number(req.nextUrl.searchParams.get('id')), me.uid) ? Response.json(all()) : bad('Not found.', 404);
}
