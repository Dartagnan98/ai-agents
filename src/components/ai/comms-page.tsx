'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader, Section } from '@/components/shared/page-kit';
import { cn } from '@/lib/utils';
import { AI_PAGE } from './agents-page';
import { relTime } from './use-ai';

// AI › Comms (D, 2026-10-23: "where are the comms between agents"): every ask, message and hand-off between agents (lib/ai/comms.ts),
// who sent it to whom, for whom, its status, the answer, and the conversation each run left.
interface Row { id: number; kind: 'ask' | 'message' | 'handoff'; from_name: string; to_name: string; by: string; text: string; reply: string; reply_to: number | null;
  status: string; origin_thread: number | null; run_thread: number | null; depth: number; created_at: string }
const KIND = { ask: 'Ask', message: 'Message', handoff: 'Hand-off' } as const;
const STATUS: Record<string, string> = { pending: 'Waiting', running: 'Working', read: 'Read', done: 'Done', failed: 'Failed' };
const Tag = ({ children, tone }: { children: React.ReactNode; tone?: string }) => <span className={cn('rounded-full bg-muted px-1.5 py-px text-[11px] font-semibold text-muted-foreground', tone)}>{children}</span>;

export function CommsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [kind, setKind] = useState<'all' | Row['kind']>('all');
  useEffect(() => {
    const load = () => fetch('/api/ai/comms').then((r) => r.json()).then((j) => setRows(j.comms ?? [])).catch(() => setRows([]));
    load();
    const t = setInterval(load, 15_000); // hand-offs finish on the clock; keep the list current while open
    return () => clearInterval(t);
  }, []);
  const shown = (rows ?? []).filter((r) => kind === 'all' || r.kind === kind);
  return (
    <div className="h-full overflow-y-auto">
      <div className={AI_PAGE}>
        <PageHeader title="Comms" purpose="What the agents ask each other, the messages they leave, and the work they hand off, with the answers." />
        <Section flush>
          <div className="flex flex-wrap gap-1.5 px-6 md:px-7">
            {(['all', 'ask', 'message', 'handoff'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
                className={cn('h-8 rounded-full px-3 text-[13px] font-semibold', kind === k ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground')}>
                {k === 'all' ? 'All' : `${KIND[k]}s`}
              </button>
            ))}
          </div>
          <div className="divide-y divide-border border-y border-border">
            {rows === null && <div className="px-6 py-4 text-[13px] text-muted-foreground md:px-7">Loading…</div>}
            {rows && shown.length === 0 && <div className="px-6 py-4 text-[13px] text-muted-foreground md:px-7">Nothing yet. Agents ask each other, leave messages and hand off work here when you ask them to, or when they need another agent.</div>}
            {shown.map((r) => (
              <div key={r.id} className="flex flex-col gap-1.5 px-6 py-3 md:px-7">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <Tag>{KIND[r.kind]}</Tag>
                  <span className="font-semibold">{r.from_name}</span><span className="text-muted-foreground">to</span><span className="font-semibold">{r.to_name}</span>
                  <Tag tone={r.status === 'failed' ? 'bg-weak-bg text-weak' : r.status === 'running' || r.status === 'pending' ? 'bg-watch-bg text-watch' : undefined}>{STATUS[r.status] ?? r.status}</Tag>
                  <span className="ml-auto text-[12px] text-muted-foreground">#{r.id}{r.reply_to ? ` · reply to #${r.reply_to}` : ''} · for {r.by} · {relTime(r.created_at)} ago</span>
                </div>
                <p className="whitespace-pre-wrap text-[13px] leading-5">{r.text}</p>
                {r.reply && <p className="whitespace-pre-wrap border-l-2 border-border pl-3 text-[13px] leading-5 text-muted-foreground"><span className="font-semibold text-foreground">{r.to_name}:</span> {r.reply.length > 1200 ? `${r.reply.slice(0, 1200)}…` : r.reply}</p>}
                <div className="flex gap-3 text-[12px] font-semibold text-muted-foreground">
                  {r.origin_thread && <Link href={`/ai?thread=${r.origin_thread}`} className="hover:text-foreground hover:underline">Where it came from</Link>}
                  {r.run_thread && <Link href={`/ai?thread=${r.run_thread}`} className="hover:text-foreground hover:underline">{r.to_name}&apos;s run</Link>}
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
