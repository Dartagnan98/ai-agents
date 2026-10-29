import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// The page kit's card shells: a KpiTile's card and a Section's card, light or the ink (dark) card.
const DARK_CARD = 'dark ink-card bg-[#0E1422] text-foreground shadow-[0_14px_34px_-16px_rgba(14,20,34,0.65)] dark:ring-1 dark:ring-white/10 print:bg-card print:shadow-none';

export function TileShell({ dark, className, tabIndex, children }: { dark?: boolean; className?: string; tabIndex?: number; children: ReactNode }) {
  return <div data-kpi="" tabIndex={tabIndex} className={cn(className, dark && DARK_CARD)}>{children}</div>;
}

export function SectionShell({ dark, className, children }: { dark?: boolean; className?: string; children: ReactNode }) {
  return <section className={cn(className, dark && DARK_CARD)}>{children}</section>;
}

export function GrowValue({ className, children }: { chars: number; className?: string; children: ReactNode }) {
  return <span className={cn(className, 'text-[26px] md:text-[28px]')}>{children}</span>;
}

export const TileLabel = ({ children }: { children: ReactNode }) => <>{children}</>;
