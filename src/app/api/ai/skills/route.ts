import { NextRequest } from 'next/server';
import { aiUser, aiDenied } from '@/lib/ai/access';
import { db } from '@/lib/db';
import { canEditSkill, deleteSkill, deleteSkillFile, listSkills, saveSkill, saveSkillFile, skillFilePath, skillFolder, type SkillInput } from '@/lib/ai/store';
import { skillSlug } from '@/lib/ai/catalog';

export const dynamic = 'force-dynamic';

// Skills (D, 2026-10-09, Skills page): saved instructions you run by typing /<name> in the chat. Yours, or shared with the
// team (every owner and admin can run it; only its maker edits it).
function input(b: Record<string, unknown>): SkillInput | string {
  const name = skillSlug(String(b.name ?? ''));
  if (name.length < 2) return 'Give the skill a name (letters, numbers and dashes).';
  const body = String(b.body ?? '').trim().slice(0, 200_000);
  if (!body) return 'Write what the skill should do.';
  return { name, title: String(b.title ?? '').trim().slice(0, 60), folder: skillFolder(b.folder), description: String(b.description ?? '').trim().slice(0, 4000), body, share: b.share === 'team' ? 'team' : 'me' };
}

export async function GET() {
  const me = await aiUser();
  if (!me) return aiDenied();
  // canEdit: the maker, owners and admins on team skills, the owner on all (store.canEditSkill); built-ins are edited by saving over them
  const names = new Map<number, string>();
  try { for (const u of db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[]) names.set(u.id, u.username); } catch { /* no users table: names stay blank */ }
  return Response.json({ skills: listSkills(me.uid, me.role === 'owner').map((s) => ({ ...s, mine: s.user_id === me.uid, maker: names.get(s.user_id) ?? '', canEdit: !s.builtin && canEditSkill(me.uid, s, me.role) })) });
}

async function save(req: NextRequest, id?: number) {
  const me = await aiUser();
  if (!me) return aiDenied();
  const b = await req.json().catch(() => ({}));
  // a file of the skill (D, 2026-10-27: skills as folders): { file: { skill_id, path, body, old_path? } }, or { file: { skill_id, path, delete: true } }
  if (b && typeof b.file === 'object' && b.file) {
    const f = b.file as Record<string, unknown>, sid = Number(f.skill_id), path = skillFilePath(f.path);
    if (!sid || sid < 0) return Response.json({ error: 'Save the skill first, then add files to it.' }, { status: 400 });
    if (!path) return Response.json({ error: 'A file path is letters, numbers, dots, dashes and / (for example references/pricing.md), and not SKILL.md.' }, { status: 400 });
    if (f.delete === true) return deleteSkillFile(me.uid, sid, path, me.role) ? Response.json({ ok: true }) : Response.json({ error: 'Could not remove that file.' }, { status: 400 });
    const body = String(f.body ?? '');
    if (body.length > 200_000) return Response.json({ error: 'A file is at most 200,000 characters.' }, { status: 400 });
    try { saveSkillFile(me.uid, sid, path, body, me.role, skillFilePath(f.old_path) || undefined); return Response.json({ ok: true, path }); }
    catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
  }
  const s = input(b);
  if (typeof s === 'string') return Response.json({ error: s }, { status: 400 });
  try { return Response.json({ skill: saveSkill(me.uid, s, id, me.role) }); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
}
export const POST = (req: NextRequest) => save(req);
export const PATCH = (req: NextRequest) => save(req, Number(req.nextUrl.searchParams.get('id')) || -1);

export async function DELETE(req: NextRequest) {
  const me = await aiUser();
  if (!me) return aiDenied();
  return deleteSkill(me.uid, Number(req.nextUrl.searchParams.get('id')), me.role) ? Response.json({ ok: true }) : Response.json({ error: 'Only the person who made a skill (or an owner or admin, for team skills) can remove it.' }, { status: 400 });
}
