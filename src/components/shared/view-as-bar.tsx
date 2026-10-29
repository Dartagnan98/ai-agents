'use client';

import { useState } from 'react';

// The bar while an owner views as someone (lib/view-as.ts): who, that it is read-only, and Stop.
export function ViewAsBar({ name }: { name: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-watch-bg px-4 py-2 text-[12.5px] text-watch">
      <span className="font-semibold">Viewing as {name}</span>
      <span className="text-muted-foreground">Read-only: you see their pages and numbers, and nothing can be changed.</span>
      <button disabled={busy} onClick={async () => { setBusy(true); await fetch('/api/view-as', { method: 'DELETE' }).catch(() => null); window.location.href = '/settings?tab=users'; }}
        className="ml-auto font-semibold underline-offset-2 hover:underline disabled:opacity-60">{busy ? 'Stopping…' : 'Stop viewing'}</button>
    </div>
  );
}
