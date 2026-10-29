import { NextRequest } from 'next/server';
import { aiDenied, aiUser } from '@/lib/ai/access';
import { boardTasks, createTask, deleteTask, updateTask } from '@/lib/ai/tasks';

export const dynamic = 'force-dynamic';

// AI › Tasks (D 2026-10-28): the AI agents' task board. GET the board; POST {title, description?, agentId?, priority?} a new task;
// PATCH ?id= {title?, description?, agentId?, priority?, status?, note?}; DELETE ?id=.
export async function GET() {
  const me = await aiUser();
  if (!me) return aiDenied();
  return Response.json({ tasks: boardTasks() });
}
export async function POST(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const b = await req.json().catch(() => ({})) as { title?: string; description?: string; agentId?: number | null; priority?: string };
  const r = createTask({ title: String(b.title ?? ''), description: b.description, agentId: typeof b.agentId === 'number' ? b.agentId : null, priority: b.priority, createdBy: me.uid });
  return typeof r === 'string' ? Response.json({ error: r }, { status: 400 }) : Response.json({ task: r });
}
export async function PATCH(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const b = await req.json().catch(() => ({})) as { title?: string; description?: string; agentId?: number | null; priority?: string; status?: string; note?: string };
  const r = updateTask(Number(req.nextUrl.searchParams.get('id')), { ...b, agentId: b.agentId === undefined ? undefined : typeof b.agentId === 'number' ? b.agentId : null });
  return typeof r === 'string' ? Response.json({ error: r }, { status: 400 }) : Response.json({ task: r });
}
export async function DELETE(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  return Response.json({ ok: deleteTask(Number(req.nextUrl.searchParams.get('id'))) });
}
