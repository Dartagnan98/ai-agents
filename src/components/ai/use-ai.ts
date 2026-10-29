'use client';

import { useEffect, useState } from 'react';
import type { AiModel } from '@/lib/ai/models';

// Client data for the AI section (D, 2026-10-09): agents and skills fetched once per page and shared by every chat on it (corner,
// docked, full page); saving in the editor refreshes them everywhere. Conversations refresh on THREADS_EVENT.
export interface UiAgent {
  id: number; name: string; description: string; instructions: string; model: string; tools: string[]; use_memory: boolean; starters: string[];
  icon: string; color: string; avatar?: string; apps?: string[]; is_default: boolean; shared?: boolean; can_edit?: boolean;
  role?: { title: string; summary: string; owns: string[]; not_owns: string[] }; daily_budget_usd?: number | null; night_shift?: boolean;
}
export interface UiSkill { id: number; name: string; title?: string; folder?: string; files?: { path: string; body: string; updated_at?: string }[]; canEdit?: boolean; maker?: string; updated_at?: string; description: string; body: string; share: 'me' | 'team'; mine: boolean; builtin?: boolean }
export interface UiThread { id: number; title: string; agent_id: number | null; updated_at: string; /** a routine's run (its own section in the AI column) */ routine_id?: number | null; routine?: string | null }

export const THREADS_EVENT = 'fleet-ai-threads';
const AGENTS_EVENT = 'fleet-ai-agents', SKILLS_EVENT = 'fleet-ai-skills';
export const notifyThreads = () => window.dispatchEvent(new Event(THREADS_EVENT));

type AgentsData = { agents: UiAgent[]; models: AiModel[]; can_share?: boolean; apps?: string[] };
let agentsCache: Promise<AgentsData> | null = null;
let skillsCache: Promise<UiSkill[]> | null = null;
const loadAgents = () => (agentsCache ??= fetch('/api/ai/agents').then((r) => (r.ok ? r.json() : { agents: [], models: [] })).catch(() => { agentsCache = null; return { agents: [], models: [] }; }));
const loadSkills = () => (skillsCache ??= fetch('/api/ai/skills').then((r) => (r.ok ? r.json() : { skills: [] })).then((j) => j.skills as UiSkill[]).catch(() => { skillsCache = null; return []; }));
export function refreshAgents() { agentsCache = null; window.dispatchEvent(new Event(AGENTS_EVENT)); }
export function refreshSkills() { skillsCache = null; window.dispatchEvent(new Event(SKILLS_EVENT)); }

export function useAiAgents(enabled = true): AgentsData | null {
  const [data, setData] = useState<AgentsData | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => loadAgents().then((d) => { if (live) setData(d); });
    load(); window.addEventListener(AGENTS_EVENT, load);
    return () => { live = false; window.removeEventListener(AGENTS_EVENT, load); };
  }, [enabled]);
  return data;
}

export function useAiSkills(enabled = true): UiSkill[] | null {
  const [data, setData] = useState<UiSkill[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => loadSkills().then((d) => { if (live) setData(d); });
    load(); window.addEventListener(SKILLS_EVENT, load);
    return () => { live = false; window.removeEventListener(SKILLS_EVENT, load); };
  }, [enabled]);
  return data;
}

/** This login's conversations, `q` searching titles and messages; refreshes on THREADS_EVENT. */
export function useAiThreads(q = '', enabled = true): UiThread[] | null {
  const [data, setData] = useState<UiThread[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => fetch(`/api/ai/chat${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => (r.ok ? r.json() : { threads: [] }))
      .then((j) => { if (live) setData(j.threads); }).catch(() => { if (live) setData([]); });
    load(); window.addEventListener(THREADS_EVENT, load);
    return () => { live = false; window.removeEventListener(THREADS_EVENT, load); };
  }, [q, enabled]);
  return data;
}

/** "2m", "5h", "3d", then "Oct 2" (relTime). */
export function relTime(at: string): string {
  const t = new Date(at.endsWith('Z') || at.includes('+') ? at : `${at}Z`).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
