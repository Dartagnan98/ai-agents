'use client';

import { useEffect } from 'react';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Dashboard error:', error);
    // A deploy replaced the build under an open tab, so its old JS chunks are gone: reload once to pick
    // up the new build (at most every 30s, so a real chunk failure can't loop).
    if (/Failed to load chunk|ChunkLoadError|Loading chunk [\w-]+ failed/i.test(`${error.name} ${error.message}`)) {
      try {
        if (Date.now() - Number(sessionStorage.getItem('chunk-reload-at') || 0) > 30_000) {
          sessionStorage.setItem('chunk-reload-at', String(Date.now()));
          window.location.reload();
        }
      } catch { /* storage blocked: leave the Try again button */ }
    }
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex max-w-md flex-col items-center gap-4 rounded-[24px] bg-card px-8 py-9 text-center shadow-[var(--card-shadow)]">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-weak-bg">
          <IconAlertTriangle size={26} className="text-weak" stroke={1.8} />
        </div>
        <span className="micro-label">Page error</span>
        <h2 className="font-heading text-[22px] font-semibold tracking-[-0.01em]">Something went wrong</h2>
        <p className="text-[13.5px] text-muted-foreground">
          {error.message || 'An unexpected error occurred while loading this page.'}
        </p>
        <Button onClick={reset} variant="outline" className="gap-2">
          <IconRefresh size={16} />
          Try again
        </Button>
      </div>
    </div>
  );
}
