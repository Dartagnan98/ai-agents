'use client';

import { useState } from 'react';
import { IconHistory } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { TimeAgo } from '@/components/shared/time-ago';
import { Section } from '@/components/shared/page-kit';
import { cn } from '@/lib/utils';

interface GoalHistoryProps {
  events: Array<{ timestamp: string; change: string }>;
}

const PAGE_SIZE = 20;

const isBottleneck = (change: string) => change.toLowerCase().includes('bottleneck');

export function GoalHistory({ events }: GoalHistoryProps) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? events : events.slice(0, PAGE_SIZE);

  if (events.length === 0) {
    return null;
  }

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <IconHistory size={16} className="text-muted-foreground" />
          Goal history
        </span>
      }
      description="Goal and bottleneck changes from the activity log."
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-3.5 text-[12px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-primary" />Goals</span>
          <span className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-[#E8A317]" />Bottleneck</span>
        </div>

        <ol className="flex flex-col">
          {visible.map((event, i) => (
            <li key={`${event.timestamp}-${i}`} className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-3.5 pb-4 last:pb-0">
              {/* Timeline line to the next entry */}
              {i < visible.length - 1 && (
                <span aria-hidden className="absolute bottom-[-5px] left-[6.5px] top-[14px] w-px bg-border" />
              )}
              <span
                aria-hidden
                className={cn('relative mt-[5px] size-[9px] justify-self-center rounded-full ring-[3px] ring-card', isBottleneck(event.change) ? 'bg-[#E8A317]' : 'bg-primary')}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <p className="line-clamp-2 text-[13px] leading-[1.45]">
                  {event.change}
                </p>
                <TimeAgo
                  date={event.timestamp}
                  className="w-fit font-mono text-[11px] text-label"
                />
              </div>
            </li>
          ))}
        </ol>

        {events.length > PAGE_SIZE && !showAll && (
          <Button
            variant="outline"
            onClick={() => setShowAll(true)}
            className="self-start"
          >
            Show {events.length - PAGE_SIZE} more
          </Button>
        )}
      </div>
    </Section>
  );
}
