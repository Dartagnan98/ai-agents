'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { IconFlask, IconPlus, IconSparkles } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, KpiGrid, KpiTile, PageHeader, Pill, Quiet, Section, type Tone } from '@/components/shared/page-kit';

// Experiments per agency (D, 2026-10-10): a simple log of the tests the team and its agents run. Hypothesis, the metric that decides it,
// start and end, the result and keep or discard. Stored in the agency's own database (/api/operations/experiments); the agents reads them
// with read_experiments and can propose one (an approve card).
type Status = 'planned' | 'running' | 'done';
type Decision = '' | 'keep' | 'discard';
interface Exp {
  id: number; title: string; hypothesis: string; metric: string; business: string; owner: string; started_on: string; ended_on: string;
  status: Status; result: string; decision: Decision; source: 'person' | 'ai'; updated_at: string;
}
interface Summary { total: number; running: number; planned: number; done: number; kept: number; discarded: number; keepRate: number | null }
type Draft = Omit<Exp, 'id' | 'source' | 'updated_at'> & { id?: number };

const API = '/api/operations/experiments';
const FIELD = 'flex flex-col gap-1.5';
const LABEL = 'text-[12.5px] font-semibold text-muted-foreground';
const SELECT = 'h-9 rounded-lg border border-border bg-card px-2.5 text-[13px]';
const today = () => new Date().toLocaleDateString('en-CA');
const BLANK: Draft = { title: '', hypothesis: '', metric: '', business: '', owner: '', started_on: '', ended_on: '', status: 'planned', result: '', decision: '' };
const STATUS: Record<Status, { label: string; tone: Tone }> = { running: { label: 'Running', tone: 'info' }, planned: { label: 'Planned', tone: 'neutral' }, done: { label: 'Done', tone: 'outline' } };
const DECISION: Record<Exclude<Decision, ''>, { label: string; tone: Tone }> = { keep: { label: 'Keep', tone: 'healthy' }, discard: { label: 'Discard', tone: 'weak' } };
const when = (d: string) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const span = (e: Pick<Exp, 'started_on' | 'ended_on'>) => (e.started_on && e.ended_on ? `${when(e.started_on)} to ${when(e.ended_on)}` : e.started_on ? `Since ${when(e.started_on)}` : e.ended_on ? `Until ${when(e.ended_on)}` : 'No dates');

export function ExperimentsBoard({ switcher }: { switcher?: ReactNode }) {
  const [list, setList] = useState<Exp[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(API, { cache: 'no-store' }).catch(() => null);
    const j = r?.ok ? await r.json() : null;
    setList(j?.experiments ?? []); setSummary(j?.summary ?? null);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true); setErr('');
    const r = await fetch(draft.id ? `${API}?id=${draft.id}` : API, { method: draft.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setErr((await r?.json().catch(() => ({})))?.error ?? 'Could not save.'); return; }
    setDraft(null); void load();
  };
  const remove = async () => {
    if (!draft?.id || !confirm(`Delete "${draft.title}"? This cannot be undone.`)) return;
    const r = await fetch(`${API}?id=${draft.id}`, { method: 'DELETE' }).catch(() => null);
    if (r?.ok) { setDraft(null); void load(); }
  };
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
  const setStatus = (status: Status) => setDraft((d) => d && { ...d, status,
    started_on: status !== 'planned' && !d.started_on ? today() : d.started_on, ended_on: status === 'done' && !d.ended_on ? today() : d.ended_on });

  const decided = summary ? summary.kept + summary.discarded : 0;
  const answer = !list || !summary ? undefined : summary.total === 0 ? undefined
    : decided ? <>Kept {summary.kept} of {decided} decided experiments ({summary.keepRate}%). <Quiet>{summary.running} running, {summary.planned} planned.</Quiet></>
      : <>{summary.total} experiment{summary.total === 1 ? '' : 's'}, none decided yet. <Quiet>{summary.running} running.</Quiet></>;
  const groups: { status: Status; title: string }[] = [{ status: 'running', title: 'Running' }, { status: 'planned', title: 'Planned' }, { status: 'done', title: 'Done' }];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Experiments" answer={answer} filters={switcher}
        purpose="The tests your team and agents run: what you expect, the number that decides it, and whether you keep it. Only this agency sees them; the agents can read them."
        actions={<Button size="sm" className="gap-1.5" onClick={() => { setErr(''); setDraft({ ...BLANK }); }}><IconPlus size={15} />New experiment</Button>} />

      {summary && summary.total > 0 && (
        <KpiGrid cols={4}>
          <KpiTile label="Running" value={summary.running} sub={`${summary.planned} planned`} />
          <KpiTile label="Done" value={summary.done} sub={`${summary.total} in all`} />
          <KpiTile label="Kept" value={summary.kept} sub={`${summary.discarded} discarded`} />
          <KpiTile label="Keep rate" value={summary.keepRate === null ? 'n/a' : `${summary.keepRate}%`} sub="Of the decided ones" />
        </KpiGrid>
      )}

      {list && list.length === 0 ? (
        <EmptyState title="No experiments yet" action={<Button variant="outline" size="sm" onClick={() => setDraft({ ...BLANK })}>Log the first one</Button>}>
          Write down each test before you run it: a new opener for setters, a different offer page, a reminder text before calls. Say the number that decides it, then record the result and whether you keep it.
        </EmptyState>
      ) : (
        groups.map((g) => {
          const rows = (list ?? []).filter((e) => e.status === g.status);
          if (!rows.length) return null;
          return (
            <Section key={g.status} title={`${g.title} · ${rows.length}`} flush>
              <div className="divide-y divide-border border-y border-border">
                {rows.map((e) => (
                  <button key={e.id} type="button" onClick={() => { setErr(''); setDraft({ ...e }); }} className="group flex w-full items-center gap-3 px-6 py-3 text-left hover:bg-inset/50 md:px-7">
                    <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-inset text-muted-foreground">{e.source === 'ai' ? <IconSparkles size={16} stroke={1.8} /> : <IconFlask size={16} stroke={1.8} />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold group-hover:underline">{e.title}</span>
                      <span className="block truncate text-[12px] text-muted-foreground">
                        {[e.metric && `Metric: ${e.metric}`, e.business, e.owner, span(e)].filter(Boolean).join(' · ')}
                      </span>
                      {e.status === 'done' && e.result && <span className="block truncate text-[12px] text-foreground/80">{e.result}</span>}
                    </span>
                    {e.decision ? <Pill tone={DECISION[e.decision].tone} dot>{DECISION[e.decision].label}</Pill> : <Pill tone={STATUS[e.status].tone}>{STATUS[e.status].label}</Pill>}
                  </button>
                ))}
              </div>
            </Section>
          );
        })
      )}
      {!list && <div className="h-40 animate-pulse rounded-[22px] bg-card shadow-[var(--card-shadow)]" />}

      <Dialog open={!!draft} onOpenChange={(o) => { if (!o) setDraft(null); }}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[680px]">
          <DialogHeader className="border-b border-border px-6 py-4">
            <DialogTitle>{draft?.id ? 'Experiment' : 'New experiment'}</DialogTitle>
            <DialogDescription>Say what you expect and the number that decides it before you start.</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
              <div className={FIELD}><label className={LABEL} htmlFor="ex-title">Title</label>
                <Input id="ex-title" value={draft.title} maxLength={160} onChange={(e) => set('title', e.target.value)} placeholder="Text reminder 2 hours before calls" /></div>
              <div className={FIELD}><label className={LABEL} htmlFor="ex-hyp">Hypothesis</label>
                <Textarea id="ex-hyp" value={draft.hypothesis} rows={3} maxLength={2000} onChange={(e) => set('hypothesis', e.target.value)} placeholder="If we text a reminder 2 hours before, more booked calls show up." /></div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className={FIELD}><label className={LABEL} htmlFor="ex-metric">Metric that decides it</label>
                  <Input id="ex-metric" value={draft.metric} maxLength={200} onChange={(e) => set('metric', e.target.value)} placeholder="Show rate" /></div>
                <div className={FIELD}><label className={LABEL} htmlFor="ex-biz">Contract or area</label>
                  <Input id="ex-biz" value={draft.business} maxLength={60} onChange={(e) => set('business', e.target.value)} placeholder="Optional" /></div>
                <div className={FIELD}><label className={LABEL} htmlFor="ex-owner">Who runs it</label>
                  <Input id="ex-owner" value={draft.owner} maxLength={80} onChange={(e) => set('owner', e.target.value)} placeholder="A person or an agent" /></div>
                <div className={FIELD}><label className={LABEL} htmlFor="ex-status">Status</label>
                  <select id="ex-status" className={SELECT} value={draft.status} onChange={(e) => setStatus(e.target.value as Status)}>
                    <option value="planned">Planned</option><option value="running">Running</option><option value="done">Done</option>
                  </select></div>
                <div className={FIELD}><label className={LABEL} htmlFor="ex-start">Start</label>
                  <Input id="ex-start" type="date" value={draft.started_on} onChange={(e) => set('started_on', e.target.value)} /></div>
                <div className={FIELD}><label className={LABEL} htmlFor="ex-end">End</label>
                  <Input id="ex-end" type="date" value={draft.ended_on} onChange={(e) => set('ended_on', e.target.value)} /></div>
              </div>
              <div className={FIELD}><label className={LABEL} htmlFor="ex-result">Result</label>
                <Textarea id="ex-result" value={draft.result} rows={3} maxLength={4000} onChange={(e) => set('result', e.target.value)} placeholder="What the number did, with the before and after." /></div>
              <div className={FIELD}>
                <span className={LABEL}>Decision</span>
                <span className="flex h-9 w-fit rounded-lg border border-border bg-inset p-0.5">
                  {(['', 'keep', 'discard'] as Decision[]).map((d) => (
                    <button key={d || 'none'} type="button" onClick={() => set('decision', d)}
                      className={`rounded-md px-3 text-[12.5px] font-semibold ${draft.decision === d ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
                      {d === '' ? 'Not decided' : d === 'keep' ? 'Keep' : 'Discard'}
                    </button>
                  ))}
                </span>
              </div>
              {err && <div className="rounded-lg bg-weak-bg px-3 py-2 text-[12.5px] text-weak">{err}</div>}
            </div>
          )}
          <DialogFooter className="flex-row justify-end gap-2 border-t border-border px-6 py-3">
            {draft?.id && <Button variant="outline" onClick={() => void remove()} className="mr-auto text-weak">Delete</Button>}
            <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={busy || !draft?.title.trim()} onClick={() => void save()}>{draft?.id ? 'Save' : 'Add experiment'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
