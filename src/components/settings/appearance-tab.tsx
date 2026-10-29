'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Section } from '@/components/shared/page-kit';

type Density = 'comfortable' | 'compact';

export function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [density, setDensity] = useState<Density>('comfortable');

  useEffect(() => {
    setMounted(true);
    // Read density from localStorage
    const saved = localStorage.getItem('ctx-density') as Density | null;
    if (saved === 'compact' || saved === 'comfortable') {
      setDensity(saved);
    }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    localStorage.setItem('ctx-density', density);
    // Apply density class to document
    document.documentElement.dataset.density = density;
  }, [density, mounted]);

  if (!mounted) {
    return <div className="h-48 animate-pulse rounded-[22px] bg-card shadow-[var(--card-shadow)]" />;
  }

  const isDark = theme === 'dark';

  return (
    // Compact rows like the rest of Settings; no title repeating the page header (D, 2026-10-09).
    <Section description="Saved in this browser only." flush>
      <div className="divide-y divide-border border-y border-border">
        <div className="flex items-center justify-between gap-4 px-6 py-3 md:px-7">
          <span className="flex min-w-0 flex-col">
            <span id="appearance-dark-label" className="text-[13.5px] font-semibold">Dark mode</span>
            <span className="text-[11.5px] text-label">Light or dark theme.</span>
          </span>
          <Switch aria-labelledby="appearance-dark-label" checked={isDark} onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')} />
        </div>
        <div className="flex items-center justify-between gap-4 px-6 py-3 md:px-7">
          <span className="flex min-w-0 flex-col">
            <span id="appearance-density-label" className="text-[13.5px] font-semibold">Density</span>
            <span className="text-[11.5px] text-label">Spacing and font size across the dashboard.</span>
          </span>
          <Select value={density} onValueChange={(v) => setDensity(v as Density)}>
            <SelectTrigger className="h-8 w-36 shrink-0 text-[12.5px]" aria-labelledby="appearance-density-label"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="comfortable">Comfortable</SelectItem>
              <SelectItem value="compact">Compact</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </Section>
  );
}
