'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { IconRefresh } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { EmptyState, PageHeader, Pill, Section, type Tone } from '@/components/shared/page-kit';
import { AI_PAGE } from './agents-page';
import { relTime } from './use-ai';
import { agencyTz, tzAbbr } from '@/lib/tz';

// Operations › Automations (D 2026-10-28): everything on the server that runs outside the agents' routines
// (lib/ai/system-jobs.ts), read only. Timers first, then the scheduled jobs (/etc/cron.d: the Fleet syncs, scores, backups), then the
// services that are always on. Turning them on or off stays on the server.
interface Job { kind: 'timer' | 'cron' | 'service'; id: string; name: string; on: boolean; schedule: string; lastRun: number | null; nextRun: number | null; ok: boolean | null; note: string }
interface Data { timers: Job[]; cron: Job[]; services: Job[]; errors: string[] }

const at = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: agencyTz(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ` ${tzAbbr()}`;
function state(j: Job): { text: string; tone: Tone } {
  if (!j.on) return { text: j.note.startsWith('Moved') ? 'Moved' : 'Off', tone: 'neutral' };
  if (j.ok === false) return { text: j.kind === 'service' ? 'Down' : 'Last run failed', tone: 'weak' };
  return { text: j.kind === 'service' ? 'Running' : 'On', tone: 'healthy' };
}

function Rows({ jobs, empty }: { jobs: Job[]; empty: string }) {
  if (!jobs.length) return <div className="px-6 py-6 md:px-7"><EmptyState title={empty} /></div>;
  return (
    <div className="divide-y divide-border border-y border-border">
      {[...jobs].sort((a, b) => Number(b.on) - Number(a.on) || a.name.localeCompare(b.name)).map((j) => {
        const st = state(j);
        return (
          <div key={j.kind + j.id} className="flex items-center gap-3 px-6 py-3 md:px-7">
            <div className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold">{j.name}</span>
              <span className="block truncate text-[12px] text-muted-foreground" title={j.note}>
                {j.schedule}{j.on && j.nextRun ? ` · next ${at(j.nextRun)}` : ''}{j.note ? ` · ${j.note}` : ''}
              </span>
            </div>
            <span className="flex shrink-0 flex-col items-end gap-0.5">
              <Pill tone={st.tone} dot>{st.text}</Pill>
              {j.lastRun && <span className="text-[11px] text-label">{j.kind === 'service' ? 'up ' : ''}{relTime(new Date(j.lastRun).toISOString())}{j.kind === 'service' ? '' : ' ago'}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function AutomationsPage() {
  const [data, setData] = useState<Data | null>(null);
  const load = useCallback(() => fetch('/api/ai/automations', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setData(d)).catch(() => {}), []);
  useEffect(() => { void load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);
  const count = (l?: Job[]) => (l ? `${l.filter((j) => j.on).length} of ${l.length} on` : '');

  return (
    <div className="h-full overflow-y-auto">
      <div className={AI_PAGE}>
        <PageHeader title="Automations" answer={<>Everything on the server that runs outside the agents: watchers, syncs, sends and always-on services. Agent work on a schedule is in <Link href="/ai/routines" className="underline">Routines</Link>.</>}
          actions={<Button size="sm" variant="outline" onClick={() => void load()} className="gap-1.5"><IconRefresh size={15} />Refresh</Button>} />
        {data?.errors.length ? <p className="text-[12.5px] text-weak">Could not read: {data.errors.join('; ')}</p> : null}
        {!data && <p className="text-[13px] text-muted-foreground">Loading...</p>}
        {data && <>
          {data.timers.length > 0 && <Section flush title="Timers" description={`Watchers and timers. ${count(data.timers)}.`}><Rows jobs={data.timers} empty="No timers" /></Section>}
          <Section flush title="Scheduled jobs" description={`The Fleet syncs, call scores, show marking, backups and mirrors. ${count(data.cron)}.`}><Rows jobs={data.cron} empty="No scheduled jobs" /></Section>
          <Section flush title="Always running" description={`The app copies and the Slack listeners. ${count(data.services)}.`}><Rows jobs={data.services} empty="No services" /></Section>
        </>}
      </div>
    </div>
  );
}
