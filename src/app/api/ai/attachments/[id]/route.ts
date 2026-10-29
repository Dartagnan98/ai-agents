import { aiChatUser, aiDenied } from '@/lib/ai/access';
import { readAttachment } from '@/lib/ai/attachments';

export const dynamic = 'force-dynamic';

// GET a chat file for the person who sent it: pictures and PDFs open inline, text files as plain text (D, 2026-10-23).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await aiChatUser();
  if (!me) return aiDenied();
  const f = readAttachment(me.uid, (await params).id);
  if (!f) return Response.json({ error: 'Not found.' }, { status: 404 });
  const type = f.meta.kind === 'text' ? 'text/plain; charset=utf-8' : f.meta.type;
  const how = f.meta.kind === 'office' ? 'attachment' : 'inline'; // Excel, Word, PowerPoint download as the original file
  return new Response(new Uint8Array(f.bytes), { headers: { 'content-type': type, 'content-length': String(f.bytes.length), 'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff', 'content-disposition': `${how}; filename*=UTF-8''${encodeURIComponent(f.meta.name)}`,
    'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" } });
}
