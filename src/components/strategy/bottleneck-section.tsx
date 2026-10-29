'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { IconCheck } from '@tabler/icons-react';
import { Textarea } from '@/components/ui/textarea';
import { TimeAgo } from '@/components/shared/time-ago';
import { Pill } from '@/components/shared/page-kit';

interface BottleneckSectionProps {
  bottleneck: string;
  org: string;
  history: Array<{ timestamp: string; change: string }>;
  /** Where it saves: Operations › Strategy. */
  save: (text: string) => Promise<{ success: boolean; error?: string }>;
}

export function BottleneckSection({
  bottleneck: initialBottleneck,
  org,
  history,
  save,
}: BottleneckSectionProps) {
  const [value, setValue] = useState(initialBottleneck);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(initialBottleneck);

  // Sync with parent if bottleneck changes externally
  useEffect(() => {
    setValue(initialBottleneck);
    lastSavedRef.current = initialBottleneck;
  }, [initialBottleneck]);

  const handleSave = useCallback(async () => {
    const trimmed = value.trim();
    if (trimmed === lastSavedRef.current) return;

    setSaveStatus('saving');
    const result = await save(trimmed);
    if (result.success) {
      lastSavedRef.current = trimmed;
      setSaveStatus('saved');
      // Clear "Saved" after 2s
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
    } else {
      setSaveStatus('error');
    }
  }, [value, org, save]);

  const charCount = value.length;
  const charLimit = 500;

  return (
    <section className="lg-card relative flex flex-col gap-[18px] rounded-[22px] bg-card px-6 py-5 shadow-[var(--card-shadow)] md:px-7">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <span aria-hidden className="size-2 rounded-full bg-[#E8A317]" />
            Current bottleneck
          </h2>
          <p className="text-[12.5px] text-muted-foreground">
            The one thing slowing the team down most. It saves when you click away.
          </p>
        </div>
        <span className="pt-0.5 font-mono text-[11.5px] tabular-nums text-label">
          {charCount} / {charLimit}
        </span>
        <span aria-live="polite" className="flex min-h-6 items-center">
          {saveStatus === 'saving' && (
            <Pill tone="watch" className="animate-pulse">Saving...</Pill>
          )}
          {saveStatus === 'saved' && (
            <Pill tone="healthy"><IconCheck size={13} stroke={2.2} />Saved</Pill>
          )}
          {saveStatus === 'error' && (
            <Pill tone="weak" dot>Error saving</Pill>
          )}
        </span>
      </div>

      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, charLimit))}
        onBlur={handleSave}
        aria-label="Current bottleneck"
        placeholder="What is the current bottleneck for your team?"
        className="min-h-24 resize-none rounded-2xl border-transparent bg-foreground/[0.04] px-[18px] py-4 font-heading text-[17px] font-medium leading-[1.45] tracking-[-0.01em] shadow-none focus-visible:bg-transparent"
      />

      {/* Recent bottleneck changes */}
      {history.length > 0 && (
        <div className="flex flex-col">
          <h3 className="pb-1.5 font-mono text-[10.5px] font-normal uppercase tracking-[0.12em] text-label">
            Recent changes
          </h3>
          <ul className="flex flex-col">
            {history.slice(0, 5).map((entry, i) => (
              <li
                key={`${entry.timestamp}-${i}`}
                className="flex items-center gap-3 border-t border-[#F1F3F7] py-2.5 dark:border-hairline"
              >
                <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-[#E8A317]" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{entry.change}</span>
                <TimeAgo
                  date={entry.timestamp}
                  className="shrink-0 whitespace-nowrap font-mono text-[11.5px] text-label"
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
