import type { ReactNode } from 'react';
import Link from 'next/link';
import { IconExternalLink } from '@tabler/icons-react';
import { EmptyState, KpiGrid, KpiTile, PageHeader, Pill, Quiet, Section, type Tone } from '@/components/shared/page-kit';
import type { healthView, HealthState } from '@/lib/operations/views';

// Operations › Fleet health per agency (D, 2026-10-10): the agency's AI agents and routines. Each routine's state (last run, failures in
// the last 7 days, a run that was missed or is stuck), approve cards still waiting, every agent and whether its model is connected, and
// the AI connections. Server rendered from lib/operations/views.ts healthView().
type Data = ReturnType<typeof healthView>;

const STATE: Record<HealthState, { text: string; tone: Tone }> = {
  failing: { text: 'Failing', tone: 'weak' }, warning: { text: 'Needs a look', tone: 'watch' }, never: { text: 'Not run yet', tone: 'neutral' },
  healthy: { text: 'Healthy', tone: 'healthy' }, off: { text: 'Off', tone: 'outline' },
};
const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = (Date.now() - Date.parse(iso)) / 60_000;
  return m < 60 ? `${Math.max(1, Math.round(m))} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const ROW = 'flex items-center gap-3 px-6 py-3 md:px-7';

export function HealthBoard({ data, switcher }: { data: Data; switcher?: ReactNode }) {
  const on = data.health.filter((h) => h.enabled);
  const bad = data.health.filter((h) => h.state === 'failing' || h.state === 'warning');
  const failed7 = on.reduce((s, h) => s + h.failed7, 0), runs7 = on.reduce((s, h) => s + h.runs7, 0);
  const offline = data.agents.filter((a) => !a.connected);
  const answer = data.connected === 0
    ? <>No AI is connected, so no agent or routine can run. <Quiet>Connect one in Settings › AI connections.</Quiet></>
    : on.length === 0
      ? <>No routine is on. <Quiet>{data.agents.length} agent{data.agents.length === 1 ? '' : 's'}, {data.connected} AI connection{data.connected === 1 ? '' : 's'}.</Quiet></>
      : bad.length
        ? <>{bad.length} of {on.length} routines need a look. <Quiet>{failed7} of {runs7} runs failed in the last 7 days.</Quiet></>
        : <>All {on.length} routines that are on are healthy. <Quiet>{runs7} runs in the last 7 days{data.waiting.length ? `, ${data.waiting.length} waiting for approval` : ''}.</Quiet></>;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Fleet health" answer={answer} filters={switcher}
        purpose="Your AI agents and routines: how the last runs went, what failed this week, what waits for someone to approve, and whether each agent's AI is connected." />

      <KpiGrid cols={4}>
        <KpiTile label="Routines on" value={on.length} sub={`${data.health.length} in all`} />
        <KpiTile label="Need a look" value={bad.length} tone={bad.length ? 'weak' : undefined} sub={bad.length ? 'Failing, missed or failed this week' : 'Nothing failing'} />
        <KpiTile label="Failed runs, 7 days" value={failed7} sub={runs7 ? `${runs7} runs in all` : 'No runs this week'} />
        <KpiTile label="Waiting for approval" value={data.waiting.length} tone={data.waiting.length ? 'watch' : undefined} sub="Approve cards not answered yet" />
      </KpiGrid>

      <Section title="Routines" description="Worst first. Missed = due over 15 minutes ago and not started; stuck = a run silent for 30 minutes." flush
        actions={<Link href="/workflows" className="text-[13px] font-medium text-primary hover:underline">Schedule</Link>}>
        {data.health.length === 0 ? <div className="px-6 pb-2 md:px-7"><EmptyState title="No routines yet">Add one in AI › Routines.</EmptyState></div> : (
          <div className="divide-y divide-border border-y border-border">
            {data.health.map((h) => (
              <div key={h.id} className={ROW}>
                <Pill tone={STATE[h.state].tone} dot className="w-[108px] justify-center">{STATE[h.state].text}</Pill>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{h.name}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">{h.agent} · {h.reason}</span>
                </span>
                <span className="hidden w-[120px] shrink-0 text-right text-[12px] text-muted-foreground md:block">
                  <span className="block tabular-nums">{h.runs7} runs · {h.failed7} failed</span>
                  <span className="block text-[11px] text-label">last 7 days</span>
                </span>
                <span className="hidden w-[180px] shrink-0 truncate text-right text-[12px] text-muted-foreground sm:block">{h.lastRunText || 'Never run'}</span>
                {h.lastThreadId ? <Link href={`/ai?thread=${h.lastThreadId}`} aria-label={`Open the last run of ${h.name}`} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-foreground"><IconExternalLink size={15} /></Link> : <span className="size-8 shrink-0" />}
              </div>
            ))}
          </div>
        )}
      </Section>

      {data.waiting.length > 0 && (
        <Section title="Waiting for approval" description="Changes an agent asked to make. Nothing happens until the person the conversation belongs to approves it there." flush>
          <div className="divide-y divide-border border-y border-border">
            {data.waiting.map((w) => (
              <Link key={w.id} href={`/ai?thread=${w.threadId}`} className={`${ROW} hover:bg-inset/60`}>
                <Pill tone="watch" dot>Waiting</Pill>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{w.summary}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">{w.routine ? `Routine: ${w.routine}` : 'From a chat'} · {ago(w.createdAt)}</span>
                </span>
                <IconExternalLink size={15} className="shrink-0 text-muted-foreground" />
              </Link>
            ))}
          </div>
        </Section>
      )}

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Section title="Agents" description={offline.length ? `${offline.length} agent${offline.length === 1 ? ' runs' : 's run'} on a model that is not connected.` : 'Every agent\'s model is connected.'} flush
          actions={<Link href="/ai/agents" className="text-[13px] font-medium text-primary hover:underline">Edit agents</Link>}>
          <div className="divide-y divide-border border-y border-border">
            {data.agents.map((a) => (
              <div key={a.id} className={ROW}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{a.name}{a.isDefault && <span className="ml-1.5 text-[11.5px] font-normal text-label">default</span>}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">{a.model} · {a.provider} · {a.routines} routine{a.routines === 1 ? '' : 's'} · used {ago(a.lastUsed)}</span>
                </span>
                <Pill tone={a.connected ? 'healthy' : 'weak'} dot>{a.connected ? 'Connected' : 'Not connected'}</Pill>
              </div>
            ))}
          </div>
        </Section>
        <Section title="AI connections" description="What the agents can run on. A model whose connection is off cannot answer." flush
          actions={<Link href="/settings?tab=ai" className="text-[13px] font-medium text-primary hover:underline">AI connections</Link>}>
          <div className="divide-y divide-border border-y border-border">
            {data.connections.map((c) => (
              <div key={c.id} className={ROW}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold">{c.label}</span>
                  {c.detail && <span className="block truncate text-[12px] text-muted-foreground">{c.detail}</span>}
                </span>
                <Pill tone={c.on ? (c.status === 'connected' ? 'healthy' : 'watch') : c.status === 'not connected' ? 'outline' : 'weak'} dot={c.status !== 'not connected'}>
                  {c.on ? (c.status === 'connected' ? 'Connected' : c.status) : c.status === 'not connected' ? 'Not connected' : `Problem: ${c.status}`}
                </Pill>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
