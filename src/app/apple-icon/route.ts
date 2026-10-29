import { brandIconResponse } from '@/lib/brand-icon';

export const dynamic = 'force-dynamic';

// iOS home screen and link previews: square (iOS rounds the corners itself). Whose icon: lib/brand-icon.tsx.
export async function GET(req: Request) { return brandIconResponse(req, 180, false); }
