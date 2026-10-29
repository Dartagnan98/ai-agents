'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconCheck, IconStar, IconTarget } from '@tabler/icons-react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader, Pill, Quiet } from '@/components/shared/page-kit';
import { BottleneckSection } from '@/components/strategy/bottleneck-section';
import { GoalsList, type GoalsApi } from '@/components/strategy/goals-list';
import { GoalHistory } from '@/components/strategy/goal-history';
import { cn } from '@/lib/utils';
import type { Goal } from '@/lib/types';

// Operations › Strategy per agency (D, 2026-10-10): the same page as the cortextOS goals.json one (today's focus, bottleneck, goals in
// priority order with progress, history), plus a north star, stored in the agency's own database (/api/operations/goals). the agents reads
// it with read_goals.
interface Strategy { north_star: string; bottleneck: string; daily_focus: string; daily_focus_set_at: string | null }
interface Data { strategy: Strategy; goals: { id: number; title: string; progress: number; sort: number }[]; history: { timestamp: string; change: string }[] }
type Field = 'north_star' | 'bottleneck' | 'daily_focus';

const API = '/api/operations/goals';
const gist = (text: string) => { const first = text.trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, ''); return first.length > 70 ? `${first.slice(0, 68).trimEnd()}...` : first; };

async function call(method: string, body?: unknown, query = ''): Promise<{ data: Data | null; error?: string }> {
  const r = await fetch(`${API}${query}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }).catch(() => null);
  if (!r?.ok) return { data: null, error: (await r?.json().catch(() => ({})))?.error ?? 'Could not save.' };
  return { data: await r.json() };
}

/** The north star: one line that says where the agency is going, big, across the top with the goals' numbers under it (D, 2026-10-28
 *  redesign). Saves when you click away, like the bottleneck. */
function NorthStar({ value, onSave, stats }: { value: string; onSave: (v: string) => Promise<boolean>; stats: { label: string; value: string; sub: string }[] }) {
  const [v, setV] = useState(value);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const last = useRef(value);
  useEffect(() => { setV(value); last.current = value; }, [value]);
  const save = async () => {
    if (v.trim() === last.current) return;
    setState('saving');
    const ok = await onSave(v.trim());
    if (ok) { last.current = v.trim(); setState('saved'); setTimeout(() => setState('idle'), 2000); } else setState('error');
  };
  return (
    <section className="lg-card relative flex flex-col gap-5 rounded-[24px] bg-card px-6 py-6 shadow-[var(--card-shadow)] md:px-8 md:py-7">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex min-w-0 flex-1 items-center gap-2 text-[15px] font-semibold"><IconStar size={16} stroke={1.8} className="text-primary" />North star</h2>
        <span aria-live="polite" className="flex min-h-6 items-center">
          {state === 'saving' && <Pill tone="watch" className="animate-pulse">Saving...</Pill>}
          {state === 'saved' && <Pill tone="healthy"><IconCheck size={13} stroke={2.2} />Saved</Pill>}
          {state === 'error' && <Pill tone="weak" dot>Error saving</Pill>}
        </span>
      </div>
      <Textarea value={v} onChange={(e) => setV(e.target.value.slice(0, 500))} onBlur={() => void save()} aria-label="North star" rows={2}
        placeholder="Where the agency is going, in one line. For example: 40 active contracts at a 30% close rate by June."
        className="min-h-20 resize-none rounded-2xl border-transparent bg-foreground/[0.04] px-5 py-4 font-heading text-[22px] font-semibold leading-[1.3] tracking-[-0.01em] shadow-none placeholder:font-medium placeholder:text-muted-foreground/70 focus-visible:bg-transparent md:text-[26px]" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map((x) => (
          <div key={x.label} className="flex flex-col gap-0.5 rounded-2xl bg-foreground/[0.04] px-4 py-3">
            <span className="text-[12.5px] font-semibold text-muted-foreground">{x.label}</span>
            <span className="font-heading text-[24px] font-semibold tabular-nums">{x.value}</span>
            <span className="text-[12px] text-muted-foreground">{x.sub}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function StrategyBoard({ switcher }: { switcher?: ReactNode }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [focusDraft, setFocusDraft] = useState<string | null>(null);

  const load = useCallback(async () => { const r = await call('GET'); if (r.data) setData(r.data); else setErr(r.error ?? 'Could not load.'); }, []);
  useEffect(() => { void load(); }, [load]);

  const setField = useCallback(async (field: Field, value: string) => {
    const r = await call('PATCH', { field, value });
    if (r.data) setData(r.data);
    return { success: !!r.data, error: r.error };
  }, []);
  const api = useMemo<GoalsApi>(() => {
    const wrap = async (p: Promise<{ data: Data | null; error?: string }>) => { const r = await p; if (r.data) setData(r.data); return { success: !!r.data, error: r.error }; };
    return {
      addGoal: (title) => wrap(call('POST', { title })),
      updateGoals: (goals) => wrap(call('PUT', { goals: goals.map((g) => ({ id: Number(g.id), title: g.title, progress: g.progress })) })),
      reorderGoals: (ids) => wrap(call('PUT', { goals: ids.map((id) => ({ id: Number(id) })) })),
      deleteGoal: (id) => wrap(call('DELETE', undefined, `?id=${encodeURIComponent(id)}`)),
    };
  }, []);
  const goals: Goal[] = useMemo(() => (data?.goals ?? []).map((g, i) => ({ id: String(g.id), title: g.title, progress: g.progress, order: i })), [data?.goals]);

  if (!data) {
    return (
      <div className="flex flex-col gap-6" aria-busy={!err}>
        <PageHeader title="Strategy" filters={switcher} />
        {err ? <p className="text-[13px] text-weak">{err}</p> : <div className="h-56 animate-pulse rounded-[22px] bg-card shadow-[var(--card-shadow)]" />}
      </div>
    );
  }

  const s = data.strategy;
  const bottleneckEvents = data.history.filter((h) => h.change.toLowerCase().includes('bottleneck'));
  const pastHalf = goals.filter((g) => g.progress > 50).length;
  const done = goals.length > 0 && goals.every((g) => g.progress >= 100);
  const tail = s.bottleneck.trim() ? `Bottleneck: ${gist(s.bottleneck)}.` : 'No bottleneck set.';
  const answer = goals.length === 0 ? <>No goals set yet. <Quiet>{tail}</Quiet></>
    : done ? <>All {goals.length} goals are done. <Quiet>{tail}</Quiet></>
      : <>{pastHalf} of {goals.length} goals are past halfway. <Quiet>{tail}</Quiet></>;
  const focusAt = s.daily_focus_set_at ? new Date(s.daily_focus_set_at) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Strategy" answer={answer} filters={switcher}
        purpose="Where the agency is going, what slows it down, today's focus and the goals in priority order. Only this agency sees it; the agents can read it." />

      <NorthStar value={s.north_star} onSave={async (v) => (await setField('north_star', v)).success} stats={[
        { label: 'Goals', value: String(goals.length), sub: goals.length ? `${goals.filter((g) => g.progress >= 100).length} done` : 'none set yet' },
        { label: 'Average progress', value: goals.length ? `${Math.round(goals.reduce((x, g) => x + g.progress, 0) / goals.length)}%` : '–', sub: 'across every goal' },
        { label: 'Past halfway', value: goals.length ? `${pastHalf} of ${goals.length}` : '–', sub: 'goals over 50%' },
      ]} />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
      <section className="lg-card relative flex flex-wrap items-center gap-4 rounded-[22px] bg-card px-6 py-5 shadow-[var(--card-shadow)] md:px-7">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><IconTarget size={20} stroke={1.8} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[15px] font-semibold">Today&apos;s focus</span>
          {focusDraft !== null ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input autoFocus value={focusDraft} maxLength={500} onChange={(e) => setFocusDraft(e.target.value)} aria-label="Today's focus" placeholder="The one thing the team works on today"
                onKeyDown={(e) => { if (e.key === 'Enter') void setField('daily_focus', focusDraft).then(() => setFocusDraft(null)); if (e.key === 'Escape') setFocusDraft(null); }} className="h-9 min-w-0 flex-1 bg-card" />
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setFocusDraft(null)}>Cancel</Button>
                <Button size="sm" onClick={() => void setField('daily_focus', focusDraft).then(() => setFocusDraft(null))}>Save</Button>
              </div>
            </div>
          ) : (
            <p className={cn('font-heading text-[16px] font-medium leading-snug tracking-[-0.01em] md:text-[17px]', !s.daily_focus && 'text-muted-foreground')}>{s.daily_focus || 'No focus set for today.'}</p>
          )}
        </div>
        {focusDraft === null && (
          <span className="flex items-center gap-3">
            {focusAt && !Number.isNaN(focusAt.getTime()) && s.daily_focus && <span title={focusAt.toLocaleString()} className="text-[12px] text-muted-foreground">Set {focusAt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>}
            <Button size="sm" variant="outline" onClick={() => setFocusDraft(s.daily_focus)}>{s.daily_focus ? 'Change' : 'Set focus'}</Button>
          </span>
        )}
      </section>

        </div>
        <BottleneckSection bottleneck={s.bottleneck} org="" history={bottleneckEvents} save={(v) => setField('bottleneck', v)} />
      </div>
      <div className={cn('grid grid-cols-[minmax(0,1fr)] items-start gap-6', data.history.length > 0 && 'xl:grid-cols-[minmax(0,1fr)_400px]')}>
        <GoalsList goals={goals} org="" onRefresh={() => { /* every call returns the fresh list */ }} api={api} />
        <GoalHistory events={data.history} />
      </div>
    </div>
  );
}
