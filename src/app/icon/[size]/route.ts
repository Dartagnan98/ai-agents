import { brandIconResponse } from '@/lib/brand-icon';

export const dynamic = 'force-dynamic';

// /icon/32, /icon/192, /icon/512: the tab, link-preview and home-screen icon of whoever's page it is (lib/brand-icon.tsx).
const SIZES = [32, 192, 512];
export async function GET(req: Request, { params }: { params: Promise<{ size: string }> }) {
  const n = Number((await params).size);
  return brandIconResponse(req, SIZES.includes(n) ? n : 32);
}
