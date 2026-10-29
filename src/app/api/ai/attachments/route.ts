import { NextRequest } from 'next/server';
import { aiChatUser, aiDenied } from '@/lib/ai/access';
import { MAX_FILES, MAX_UPLOAD_BYTES, saveAttachment } from '@/lib/ai/attachments';
import { limitRequest, POLICIES } from '@/lib/ops/rate-limit';

export const dynamic = 'force-dynamic';

// POST multipart `file` (one or more): the chat composer's paperclip, paste and drop (D, 2026-10-23). Returns the saved files; the next
// message names their ids. Pictures, PDFs and text files, 10 MB each, 10 at a time (50 MB together).
export async function POST(req: NextRequest) {
  const me = await aiChatUser();
  if (!me) return aiDenied();
  const limited = limitRequest(req, 'ai-attach', POLICIES.aiChat, me.uid); if (limited) return limited;
  if (Number(req.headers.get('content-length') ?? 0) > MAX_UPLOAD_BYTES + 64 * 1024) return Response.json({ error: 'Up to 50 MB at a time (10 MB per file).' }, { status: 413 });
  const form = await req.formData().catch(() => null);
  const parts = (form?.getAll('file') ?? []).filter((f): f is File => typeof f !== 'string');
  if (!parts.length) return Response.json({ error: 'No file.' }, { status: 400 });
  if (parts.length > MAX_FILES) return Response.json({ error: `Up to ${MAX_FILES} files at a time.` }, { status: 400 });
  const files = [], errors: string[] = [];
  for (const f of parts) {
    try { files.push(saveAttachment(me.uid, { name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()) })); }
    catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  return Response.json({ files, errors }, { status: files.length ? 200 : 400 });
}
