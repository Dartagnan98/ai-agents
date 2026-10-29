'use client';

import { useEffect } from 'react';

// After a deploy, a tab opened on the old build calls server actions the new build no longer has ("Server Action ... was not
// found on the server", D 2026-10-09). Reload once so the tab picks up the new build; a sessionStorage stamp stops a loop.
const STALE = /Server Action .* was not found on the server|failed-to-find-server-action|Failed to find Server Action/i;

export function StaleBuildReload() {
  useEffect(() => {
    const reload = (msg: unknown) => {
      if (!STALE.test(String(msg ?? ''))) return;
      try {
        const last = Number(sessionStorage.getItem('fleet-stale-reload') || 0);
        if (Date.now() - last < 60_000) return; // reloaded a minute ago: do not loop
        sessionStorage.setItem('fleet-stale-reload', String(Date.now()));
      } catch { /* storage blocked: still reload once */ }
      window.location.reload();
    };
    const onRejection = (e: PromiseRejectionEvent) => reload((e.reason as { message?: string })?.message ?? e.reason);
    const onError = (e: ErrorEvent) => reload(e.message);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    // Most saves catch the error themselves and show it, so the listeners above never see it (D, 2026-10-09: "saving is glitchy").
    // Watch the server action request instead: Next posts it with a Next-Action header and the new build answers 404.
    const orig = window.fetch;
    const hasAction = (h: HeadersInit | undefined) => {
      if (!h) return false;
      if (h instanceof Headers) return h.has('next-action');
      if (Array.isArray(h)) return h.some(([k]) => k.toLowerCase() === 'next-action');
      return Object.keys(h).some((k) => k.toLowerCase() === 'next-action');
    };
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await orig(input, init);
      if (res.status === 404 && (hasAction(init?.headers) || (input instanceof Request && input.headers.has('next-action')))) {
        reload('Server Action was not found on the server');
      }
      return res;
    };
    return () => { window.removeEventListener('unhandledrejection', onRejection); window.removeEventListener('error', onError); window.fetch = orig; };
  }, []);
  return null;
}
