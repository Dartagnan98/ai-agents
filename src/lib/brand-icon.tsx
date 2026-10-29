import { ImageResponse } from 'next/og';
import type { Brand } from '@/components/brand';
import { getBrand } from '@/lib/brand';

// The browser tab, link-preview and home-screen icon (app/icon/[size], app/apple-icon) and the PWA manifest: the app's initials on ink.

/** Initials: the monogram, else the first letters of the name's first two words. */
export const initialsOf = (b: Pick<Brand, 'mono' | 'name'>) => b.mono || b.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

/** The brand an icon draws, and how long it may be cached. */
export async function iconBrand(_req: Request): Promise<{ brand: Brand; logo: string | null; ref: string | null; cache: string }> {
  return { brand: getBrand(), logo: null, ref: null, cache: 'public, max-age=3600' };
}

/** The icon: the agency logo (as sent, or a redirect to its https address), else its initials on ink, else a plain mark. */
export async function brandIconResponse(req: Request, n: number, rounded = true): Promise<Response> {
  const { brand, logo, cache } = await iconBrand(req);
  if (logo) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(logo);
    if (m) return new Response(Buffer.from(m[2], 'base64'), { headers: { 'content-type': m[1], 'cache-control': cache, 'x-content-type-options': 'nosniff' } });
    if (/^https:\/\//.test(logo)) return Response.redirect(logo, 302);
  }
  const mono = initialsOf(brand);
  return new ImageResponse(
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0E1422', borderRadius: rounded ? n * 0.22 : 0, color: '#FFFFFF' }}>
      {mono
        ? <span style={{ fontSize: n * (mono.length > 1 ? 0.42 : 0.56), fontWeight: 700, letterSpacing: -n * 0.02 }}>{mono}</span>
        : <div style={{ width: n * 0.28, height: n * 0.28, borderRadius: n, background: '#FFFFFF' }} />}
    </div>,
    { width: n, height: n, headers: { 'cache-control': cache } },
  );
}
