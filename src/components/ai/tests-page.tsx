'use client';

import { useCallback, useEffect, useState } from 'react';
import { IconPlayerPlay, IconPlus, IconSparkles, IconTrash } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, PageHeader, Pill, Section, type Tone } from '@/components/shared/page-kit';
import { AI_PAGE } from './agents-page';
import { AgentMark } from './agent-mark';
import { relTime } from './use-ai';

// Operations › Tests (D 2026-10-28; first agent tests; lib/ai/evals.ts): per agent, the questions it should answer well and what a good
// answer contains, the last score 0-10 and its trend. Runs ask the agent read only; every test also runs each Sunday night.
interface Test { id: number; agent_id: number; question: string; expect: string; last_score: number | null; last_at: string | null; last_answer: string; last_why: string; trend: { at: string; score: number | null }[] }
interface Data { agents: { id: number; name: string; icon: string; color: string }[]; tests: Test[] }

const tone = (s: number | null): Tone => (s === null ? 'neutral' : s >= 8 ? 'healthy' : s >= 5 ? 'watch' : 'weak');

export function TestsPage() {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string>('');
  const [adding, setAdding] = useState<{ agent: number; question: string; expect: string } | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => fetch('/api/ai/tests', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setData(d)).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  const post = async (q: string, label: string, body?: unknown) => {
    setBusy(label); setErr('');
    const r = await fetch(`/api/ai/tests${q}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    if (!r?.ok) setErr((await r?.json().catch(() => ({})))?.error ?? 'That did not work.');
    setBusy(''); void load();
    return !!r?.ok;
  };
  const remove = async (t: Test) => { if (!confirm('Delete this test and its scores?')) return; await fetch(`/api/ai/tests?id=${t.id}`, { method: 'DELETE' }); void load(); };

  return (
    <div className="h-full overflow-y-auto">
      <div className={AI_PAGE}>
        <PageHeader title="Tests" answer="Questions each agent should answer well, and what a good answer contains. A run asks the agent read only and scores the answer 0 to 10. Every test runs again each Sunday night, so a change to instructions or memory shows up as a score that moved." />
        {err && <p className="text-[12.5px] text-weak">{err}</p>}
        {!data && <p className="text-[13px] text-muted-foreground">Loading...</p>}
        {data?.agents.map((a) => {
          const tests = data.tests.filter((t) => t.agent_id === a.id);
          const scored = tests.filter((t) => t.last_score !== null), avg = scored.length ? scored.reduce((s, t) => s + (t.last_score ?? 0), 0) / scored.length : null;
          return (
            <Section key={a.id} flush>
              <div className="flex flex-wrap items-center gap-2.5 px-6 md:px-7">
                <AgentMark icon={a.icon} color={a.color} size={22} />
                <span className="min-w-0 flex-1 text-[15px] font-semibold">{a.name}</span>
                {avg !== null && <Pill tone={tone(Math.round(avg))} dot>Average {avg.toFixed(1)}</Pill>}
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void post(`?write=${a.id}`, `write${a.id}`)} className="gap-1.5"><IconSparkles size={14} />{busy === `write${a.id}` ? 'Writing...' : 'Write tests'}</Button>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setAdding({ agent: a.id, question: '', expect: '' })} className="gap-1.5"><IconPlus size={14} />Add</Button>
                {tests.length > 0 && <Button size="sm" disabled={!!busy} onClick={() => void post(`?runAgent=${a.id}`, `all${a.id}`)} className="gap-1.5"><IconPlayerPlay size={14} />{busy === `all${a.id}` ? 'Running...' : 'Run all'}</Button>}
              </div>
              {adding?.agent === a.id && (
                <div className="flex flex-col gap-2 px-6 md:px-7">
                  <Input autoFocus placeholder="The question" value={adding.question} onChange={(e) => setAdding({ ...adding, question: e.target.value })} aria-label="Question" />
                  <Textarea placeholder="What a good answer contains" rows={3} value={adding.expect} onChange={(e) => setAdding({ ...adding, expect: e.target.value })} aria-label="Expected answer" />
                  <div className="flex gap-2"><Button size="sm" onClick={() => void post('', 'add', adding).then((ok) => ok && setAdding(null))}>Save</Button><Button size="sm" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button></div>
                </div>
              )}
              <div className="divide-y divide-border border-y border-border">
                {tests.length === 0 && <div className="px-6 py-4 md:px-7"><EmptyState title="No tests yet">Write tests drafts 5 from {a.name}&rsquo;s instructions and memory.</EmptyState></div>}
                {tests.map((t) => (
                  <details key={t.id} className="group px-6 py-3 md:px-7">
                    <summary className="flex cursor-pointer list-none items-center gap-3">
                      <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-semibold">{t.question}</span>
                        <span className="block truncate text-[12px] text-muted-foreground">{t.last_at ? `${relTime(t.last_at)} ago · ${t.last_why}` : 'Not run yet'}{t.trend.length > 1 ? ` · trend ${t.trend.map((x) => x.score ?? '-').join(' ')}` : ''}</span></span>
                      <Pill tone={tone(t.last_score)} dot>{t.last_score === null ? 'No score' : `${t.last_score}/10`}</Pill>
                      <Button size="sm" variant="ghost" disabled={!!busy} onClick={(e) => { e.preventDefault(); void post(`?run=${t.id}`, `run${t.id}`); }} aria-label="Run this test">{busy === `run${t.id}` ? 'Running...' : 'Run'}</Button>
                      <Button size="sm" variant="ghost" className="text-weak" onClick={(e) => { e.preventDefault(); void remove(t); }} aria-label="Delete this test"><IconTrash size={14} /></Button>
                    </summary>
                    <div className="mt-2 grid gap-2 text-[13px] leading-[20px]">
                      <div><span className="text-[12px] font-semibold text-muted-foreground">A good answer contains</span><div className="whitespace-pre-wrap">{t.expect}</div></div>
                      {t.last_answer && <div><span className="text-[12px] font-semibold text-muted-foreground">Last answer</span><div className="whitespace-pre-wrap text-foreground/90">{t.last_answer}</div></div>}
                    </div>
                  </details>
                ))}
              </div>
            </Section>
          );
        })}
      </div>
    </div>
  );
}
