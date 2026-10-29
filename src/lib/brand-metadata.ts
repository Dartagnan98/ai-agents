import type { Metadata } from 'next';
import { brandContext } from '@/lib/brand';

// The root layout's metadata: the name on the tab, the link preview, the icons and the home-screen app are the agency's (lib/brand.ts),
// not the product's. White label (D, 2026-10-10): signed-out client pages (/join, /upload, /help, /invite, an agency's sign-in) get
// their agency's too, and a client page with no known agency gets neither (lib/brand-surface.ts). Icon and manifest links carry the
// agency (?b=<ref>, or ?b=- for none) so those separate requests draw the right one (lib/brand-icon.tsx).
export function rootMetadata(): Metadata {
  const { brand, ref, neutral } = brandContext();
  const name = brand.name;
  const q = ref ? `?b=${encodeURIComponent(ref)}` : neutral ? '?b=-' : '';
  return {
    ...(name
      ? { title: name, description: `${name} dashboard`, applicationName: name, openGraph: { title: name, siteName: name, description: `${name} dashboard`, type: 'website' } }
      : { openGraph: { type: 'website' } }),
    icons: { icon: [{ url: `/icon/32${q}`, sizes: '32x32', type: 'image/png' }], apple: [{ url: `/apple-icon${q}`, sizes: '180x180', type: 'image/png' }] },
    ...(neutral ? {} : { manifest: `/manifest.webmanifest${q}` }),
    robots: { index: false, follow: false }, // private app: no page (sign-in, forms, dashboards) belongs in search results
    appleWebApp: { capable: true, statusBarStyle: 'default', ...(name ? { title: name } : {}) },
    // ponytail: iOS standalone needs the apple-prefixed flag; Next only emits the generic
    // `mobile-web-app-capable`, so add the apple one explicitly or the home-screen app opens in Safari.
    other: { 'apple-mobile-web-app-capable': 'yes' },
  };
}
