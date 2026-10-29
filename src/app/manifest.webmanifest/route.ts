import { iconBrand } from '@/lib/brand-icon';

export const dynamic = 'force-dynamic';

// PWA manifest: makes the dashboard installable as a standalone home-screen app, named after the agency (white label, D 2026-10-10:
// `?b=<agency>` from the root layout names it on signed-out pages too; lib/brand-icon.tsx).
export async function GET(req: Request) {
  const { brand, ref, cache } = await iconBrand(req);
  const name = brand.name || 'Dashboard';
  const q = ref ? `?b=${encodeURIComponent(ref)}` : '';
  const body = {
    name, short_name: brand.short || name, description: `${name} dashboard`, start_url: '/', scope: '/', display: 'standalone',
    background_color: '#F4F6F8', theme_color: '#F4F6F8',
    icons: [
      { src: `/icon/192${q}`, sizes: '192x192', type: 'image/png' },
      { src: `/icon/512${q}`, sizes: '512x512', type: 'image/png' },
      { src: `/icon/512${q}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/manifest+json', 'cache-control': cache } });
}
