import { NextRequest } from 'next/server';
import { staffOnly } from '@/lib/api-guard';
import { currentUserId } from '@/lib/user-access';
import { cleanDoc, deleteDoc, getDoc, isSpace, listDocs, saveDoc, searchDocs } from '@/lib/knowledge/docs';

export const dynamic = 'force-dynamic';

// Intelligence documents per agency (D, 2026-10-10): Knowledge and Wiki pages. Owner and admins (like every AI side route); rows are
// the current agency's own (lib/knowledge/docs.ts reads the agency's SQLite).
const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function GET(req: NextRequest) {
  const denied = await staffOnly(); if (denied) return denied;
  const p = req.nextUrl.searchParams;
  const id = Number(p.get('id'));
  if (id) { const doc = getDoc(id); return doc ? Response.json({ doc }) : bad('Not found.', 404); }
  const space = p.get('space');
  if (space !== null && !isSpace(space)) return bad('Unknown space.');
  const q = (p.get('q') ?? '').trim();
  if (q) return Response.json({ hits: searchDocs(q, { space: space ?? undefined, limit: 30 }) });
  if (!space) return bad('Pick a space.');
  return Response.json({ docs: listDocs(space) });
}

async function save(req: NextRequest, id?: number) {
  const denied = await staffOnly(); if (denied) return denied;
  const d = cleanDoc(await req.json().catch(() => ({})));
  if (typeof d === 'string') return bad(d);
  try { return Response.json({ doc: saveDoc(await currentUserId(), d, id) }); }
  catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
}
export const POST = (req: NextRequest) => save(req);
export const PATCH = (req: NextRequest) => save(req, Number(req.nextUrl.searchParams.get('id')) || -1);

export async function DELETE(req: NextRequest) {
  const denied = await staffOnly(); if (denied) return denied;
  return deleteDoc(Number(req.nextUrl.searchParams.get('id'))) ? Response.json({ ok: true }) : bad('Not found.', 404);
}
