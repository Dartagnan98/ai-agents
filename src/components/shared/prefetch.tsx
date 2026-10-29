'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Fetch these pages in full in the background once the page is up (D, 2026-10-02: "first click on a fresh page for all date
// ranges on all tabs ... until it's literally instant"). A later click on one of them is served from the browser's router
// cache with no trip to the server. Next runs 4 prefetches at a time and starts the NEWEST queued one first, so the list
// (likeliest first) is queued last to first; Next keeps each for 5 minutes (staleTimes.static in next.config.ts) and never
// fetches the same URL twice.
// ponytail: no network-aware scheduling; add one if phones on slow data complain.
export function usePrefetchAll(hrefs: (string | null | undefined | false)[]) {
  const router = useRouter();
  const key = hrefs.filter(Boolean).join('\n');
  useEffect(() => {
    if (!key) return;
    // 'full' = the whole page with its data (PrefetchKind.FULL); the public types only export the enum
    const timer = setTimeout(() => { for (const h of key.split('\n').reverse()) router.prefetch(h, { kind: 'full' as never }); }, 100);
    return () => clearTimeout(timer);
  }, [key, router]);
}

/** The same for server components: renders nothing. */
export function PrefetchPages({ hrefs }: { hrefs: (string | null | undefined | false)[] }) {
  usePrefetchAll(hrefs);
  return null;
}
