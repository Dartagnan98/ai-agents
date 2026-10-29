import type { ReactNode } from 'react';
import Link from 'next/link';
import { BarRow, EmptyState, KpiGrid, KpiTile, PageHeader, Quiet, Section } from '@/components/shared/page-kit';
import { cn } from '@/lib/utils';
import type { usageView } from '@/lib/operations/views';

// Operations › Analytics per agency (D, 2026-10-10): the agents use and the plan's AI allowance. Messages people sent and routine runs per
// day, by agent and by model. No runner reports a cost or a per-answer token bill, so the page shows counts and the context size the
// providers do report (how full a conversation is), and says so. Server rendered from lib/operations/views.ts usageView().
type Data = ReturnType<typeof usageView>;
export interface Meter { used: number; limit: number | null; plan: string }
export const RANGES = [7, 30, 90] as const;

const n = (v: number) => v.toLocaleString('en-US');
const k = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${Math.round(v / 1000)}k` : String(v));
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function DailyBars({ daily }: { daily: Data['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.chat + d.routineRuns));
  const step = daily.length > 31 ? 14 : daily.length > 7 ? 7 : 1;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-40 items-end gap-[2px]" role="img" aria-label="Chat messages and routine runs per day">
        {daily.map((d) => (
          <div key={d.day} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end" title={`${dayLabel(d.day)}: ${d.chat} messages, ${d.routineRuns} routine runs${d.failedRuns ? ` (${d.failedRuns} failed)` : ''}`}>
            <span className="block w-full rounded-t-[3px] bg-[#C9D1E6] dark:bg-border" style={{ height: `${(d.routineRuns / max) * 100}%` }} />
            <span className={cn('block w-full bg-primary', d.routineRuns ? '' : 'rounded-t-[3px]')} style={{ height: `${(d.chat / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="flex gap-[2px] text-[10.5px] text-label">
        {daily.map((d, i) => <span key={d.day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">{i % step === 0 ? dayLabel(d.day) : ''}</span>)}
      </div>
      <div className="flex flex-wrap gap-4 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-primary" />Chat messages</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-[#C9D1E6] dark:bg-border" />Routine runs</span>
      </div>
    </div>
  );
}

export function UsageBoard({ data, meter, switcher }: { data: Data; meter: Meter | null; switcher?: ReactNode }) {
  const t = data.totals;
  const when = data.month ? 'this month' : `in the last ${data.days} days`;
  const busiest = [...data.byAgent].sort((a, b) => (b.chat + b.runs) - (a.chat + a.runs))[0];
  const answer = t.chat + t.runs === 0
    ? <>No AI use {when}. <Quiet>Messages and routine runs show here once people use it.</Quiet></>
    : <>{n(t.chat)} chat messages and {n(t.runs)} routine runs {when}.{' '}
      <Quiet>{busiest ? `Busiest agent: ${busiest.label}.` : ''}{t.failedRuns ? ` ${t.failedRuns} runs failed.` : ''}</Quiet></>;
  const range = (
    <span className="flex h-9 w-fit rounded-lg border border-border bg-inset p-0.5">
      <Link href="/analytics?days=tm" className={cn('grid place-items-center rounded-md px-3 text-[12.5px] font-semibold', data.month ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>This month</Link>
      {RANGES.map((d) => (
        <Link key={d} href={`/analytics?days=${d}`} className={cn('grid place-items-center rounded-md px-3 text-[12.5px] font-semibold', !data.month && data.days === d ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{d} days</Link>
      ))}
    </span>
  );
  const maxAgent = Math.max(1, ...data.byAgent.map((a) => a.chat + a.runs));
  const maxModel = Math.max(1, ...data.byModel.map((m) => m.turns));
  const since = data.loggingSince ? new Date(data.loggingSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Analytics" answer={answer} filters={<>{switcher}{range}</>}
        purpose="How much your team and its routines use the agents, by agent and by model, and where the plan's AI allowance stands." />

      <KpiGrid cols={4}>
        <KpiTile label="Chat messages" value={n(t.chat)} sub={`Sent by people, ${when}`} />
        <KpiTile label="Routine runs" value={n(t.runs)} sub={t.failedRuns ? `${t.failedRuns} failed` : 'None failed'} tone={t.failedRuns ? 'watch' : undefined} />
        <KpiTile label="Answers logged" value={n(t.turns)} sub={t.costed ? `$${t.cost.toFixed(2)} at API prices · ${t.read ? Math.round((t.cached / t.read) * 100) : 0}% read from cache` : t.withTokens ? `Avg context ${k(Math.round(t.tokens / t.withTokens))} tokens` : 'Model and size per answer'}
          how="Each answer's tokens summed over its model calls. API price = what the same answer costs on an Anthropic API key (cache reads at a tenth); on a subscription it is a comparison, not a bill. Answers before Oct 12, 2026 have no token count." />
        <KpiTile label="AI allowance, this month" value={meter ? (meter.limit === null ? n(meter.used) : `${n(meter.used)} / ${n(meter.limit)}`) : 'n/a'}
          sub={meter ? `${meter.plan} plan${meter.limit === null ? ', no cap' : ''}` : 'No billing plan'} tone={meter && meter.limit !== null && meter.used > meter.limit ? 'weak' : undefined}
          how="Messages sent to the agents this calendar month (UTC), counted the way billing counts them: each routine run's prompt counts as one too." />
      </KpiGrid>

      <Section title="Per day" description="Chat messages people sent and routine runs started, in the agency's days.">
        {t.chat + t.runs === 0 ? <EmptyState title="Nothing yet">Ask an agent something in AI, or turn on a routine.</EmptyState> : <DailyBars daily={data.daily} />}
      </Section>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Section title="By agent" description="Chat messages and routine runs per agent (a routine counts for the agent it runs as).">
          {data.byAgent.length === 0 ? <Quiet>No use yet.</Quiet> : (
            <div className="flex flex-col gap-3">
              {data.byAgent.map((a) => <BarRow key={a.key} label={a.label} share={(a.chat + a.runs) / maxAgent} value={n(a.chat + a.runs)} sub={`${n(a.chat)} chat · ${n(a.runs)} runs`} />)}
            </div>
          )}
        </Section>
        <Section title="By model" description={since ? `Answers per model since ${since}, when the log started.` : 'Answers per model, from the answer log.'}>
          {data.byModel.length === 0 ? <Quiet>No answers logged yet. Every new answer is logged with its model.</Quiet> : (
            <div className="flex flex-col gap-3">
              {data.byModel.map((m) => <BarRow key={m.key} label={m.label} share={m.turns / maxModel} value={n(m.turns)} tone={m.failed ? 'watch' : 'cobalt'}
                sub={[m.withTokens ? `avg ${k(Math.round(m.tokens / m.withTokens))} tokens` : '', m.costed ? `$${(m.cost / m.costed).toFixed(3)} per answer` : '', m.read ? `${Math.round((m.cached / m.read) * 100)}% cached` : '', m.failed ? `${m.failed} failed` : ''].filter(Boolean).join(' · ') || undefined} />)}
            </div>
          )}
        </Section>
      </div>

      <p className="text-[12px] leading-relaxed text-label">
        Since Oct 12, 2026 every answer logs its tokens. Claude answers also show their price at Anthropic&apos;s API rates: the real bill on an
        API key, a comparison on a Claude subscription (a flat fee). OpenAI, xAI, ChatGPT and Grok answers show tokens only; their bill is on the
        provider&apos;s own dashboard.
      </p>
    </div>
  );
}
