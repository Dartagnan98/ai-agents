'use client';

import { IconSparkles, IconChartBar, IconCash, IconHeadset, IconTarget, IconUsers, IconBolt, IconRobot } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

// An agent's mark (D, 2026-10-09, ThreadMark): its icon on its colour, in the picker, the conversation list and the editor.
const ICON = { sparkles: IconSparkles, chart: IconChartBar, cash: IconCash, headset: IconHeadset, target: IconTarget, users: IconUsers, bolt: IconBolt, robot: IconRobot } as const;
const COLOR: Record<string, string> = {
  ink: 'bg-[var(--ai)] text-white', cobalt: 'bg-[#3D5AFE] text-white', green: 'bg-[#1F8A5B] text-white', amber: 'bg-[#C98A12] text-white',
  red: 'bg-[#C8102E] text-white', violet: 'bg-[#6E4BD8] text-white',
};
export const AGENT_ICON = ICON;

export function AgentMark({ icon, color, avatar, size = 22, className }: { icon?: string; color?: string; avatar?: string | null; size?: number; className?: string }) {
  // an uploaded avatar (D, 2026-10-09, Upload avatar) replaces the icon tile
  if (avatar) return <img src={avatar} alt="" className={cn('shrink-0 object-cover', className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }} />;
  const I = ICON[(icon ?? 'sparkles') as keyof typeof ICON] ?? IconSparkles;
  return (
    <span className={cn('grid shrink-0 place-items-center', COLOR[color ?? 'ink'] ?? COLOR.ink, className)} style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }}>
      <I size={Math.round(size * 0.62)} stroke={1.8} />
    </span>
  );
}

/** Just the coloured icon, no tile (conversation rows). */
export function AgentGlyph({ icon, color, size = 15 }: { icon?: string; color?: string; size?: number }) {
  const I = ICON[(icon ?? 'sparkles') as keyof typeof ICON] ?? IconSparkles;
  const tone: Record<string, string> = { ink: 'text-[var(--ai)]', cobalt: 'text-[#3D5AFE]', green: 'text-[#1F8A5B]', amber: 'text-[#C98A12]', red: 'text-[#C8102E]', violet: 'text-[#6E4BD8]' };
  return <I size={size} stroke={1.8} className={cn('shrink-0', tone[color ?? 'ink'] ?? tone.ink)} />;
}
