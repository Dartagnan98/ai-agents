'use client';

import { useEffect } from 'react';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';

export default function AnalyticsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Analytics error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <section className="flex w-full max-w-md flex-col items-center gap-4 rounded-[22px] bg-card px-8 py-8 text-center shadow-[var(--card-shadow)]">
        <span aria-hidden className="flex size-12 items-center justify-center rounded-2xl bg-weak-bg text-weak">
          <IconAlertTriangle size={24} stroke={1.8} />
        </span>
        <h2 className="font-heading text-[20px] font-semibold tracking-[-0.01em]">Failed to load analytics</h2>
        <p className="text-[13.5px] text-muted-foreground">
          {error.message || 'Could not load analytics data.'}
        </p>
        <Button onClick={reset} variant="outline" size="lg">
          <IconRefresh size={16} />
          Try again
        </Button>
      </section>
    </div>
  );
}
