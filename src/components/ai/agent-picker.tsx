'use client';

import { useRouter } from 'next/navigation';
import { IconCheck, IconChevronDown, IconSettings } from '@tabler/icons-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { AgentMark } from './agent-mark';
import type { UiAgent } from './use-ai';

// The agent picker in every chat header (D, 2026-10-09: corner, split pane and the AI page): the agent's mark and name; the menu lists
// every agent with its line, then Manage agents.
export function AgentPicker({ agents, value, onChange, className }: { agents: UiAgent[]; value: UiAgent | undefined; onChange: (id: number) => void; className?: string }) {
  const router = useRouter();
  // in a split the sidebar's navigation opens pages in the pane in focus (split-view.tsx)
  const manage = () => { if (!window.__fleetSplitNav?.('/ai/agents')) router.push('/ai/agents'); };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Pick an agent" className={cn('flex h-[30px] min-w-0 items-center gap-2 rounded-lg px-1.5 text-[13.5px] font-semibold hover:bg-inset', className)}>
        <AgentMark icon={value?.icon} color={value?.color} avatar={value?.avatar} size={22} />
        <span className="min-w-0 truncate">{value?.name ?? 'Agent'}</span>
        <IconChevronDown size={14} stroke={2} className="shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px]">
        {agents.map((a) => (
          <DropdownMenuItem key={a.id} onClick={() => onChange(a.id)} className="items-start gap-2.5 py-2">
            <AgentMark icon={a.icon} color={a.color} avatar={a.avatar} size={22} className="mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">{a.name}</span>
              {a.description && <span className="block truncate text-[11.5px] text-muted-foreground">{a.description}</span>}
            </span>
            {value?.id === a.id && <IconCheck size={15} className="mt-1 shrink-0" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={manage} className="gap-2.5 text-[13px]"><IconSettings size={15} stroke={1.8} />Manage agents</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
