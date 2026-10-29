import Link from 'next/link';
import { IconBulb, IconGitCompare, IconAlertTriangle, IconRepeat, IconShieldCheck, IconArrowLeft, IconChecklist } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { EmptyState, PageHeader, Pill, Section } from '@/components/shared/page-kit';
import { agencyTz } from '@/lib/tz';
import { AI_PAGE } from './agents-page';
import { ApprovalDecide, ClearItem, ConflictDecide, LessonDecide } from './inbox-actions';
import type { InboxItem } from '@/lib/ai/inbox';

// The notifications Inbox: the list on the left, the picked item open on the right with what
// it needs. Phones show the list, then the item on its own with a way back.
const ICON = { approval: IconShieldCheck, lesson: IconBulb, conflict: IconGitCompare, routine: IconRepeat, task: IconChecklist } as const;
const KIND = { approval: 'AI approval', lesson: 'Lesson', conflict: 'Notes that disagree', routine: 'Routine run', task: 'Task' } as const;

function ago(isoAt: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(isoAt)) / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}
const when = (isoAt: string) => new Date(isoAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: agencyTz() });
const href = (show: string, key?: string) => `/ai/inbox?${new URLSearchParams({ ...(show === 'all' ? { show } : {}), ...(key ? { item: key } : {}) })}`;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <span className="w-36 shrink-0 text-[12.5px] text-muted-foreground">{label}</span>
      <span className="min-w-0 text-[13.5px]">{children}</span>
    </div>
  );
}

function Detail({ item }: { item: InboxItem }) {
  const Icon = item.run?.failed ? IconAlertTriangle : ICON[item.kind];
  const warn = !!item.run?.failed;
  return (
    <Section title={<span className="flex items-center gap-2.5"><Icon size={20} stroke={1.8} className={warn ? 'text-weak' : 'text-primary'} />{KIND[item.kind]}</span>}
      actions={item.needsYou ? <Pill tone="watch" dot>Needs you</Pill> : item.run ? <Pill tone={item.run.failed ? 'weak' : 'healthy'} dot>{item.run.failed ? 'Failed' : 'Done'}</Pill> : null}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-[17px] font-semibold leading-snug">{item.title}</h2>
          <span className="text-[12.5px] text-muted-foreground">{when(item.at)}</span>
        </div>

        {item.approval && (<>
          <div className="flex flex-col divide-y divide-border/60">
            <Row label="What it changes">{item.approval.tool.replace(/^propose_/, '').replace(/_/g, ' ')}</Row>
            {Object.entries(item.approval.args).slice(0, 12).map(([k, v]) => (
              <Row key={k} label={k.replace(/_/g, ' ')}><span className="whitespace-pre-wrap break-words">{typeof v === 'string' ? v : JSON.stringify(v)}</span></Row>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <ApprovalDecide id={item.approval.id} />
            <Link href={`/ai?thread=${item.approval.thread_id}`} className="text-[13px] font-semibold text-primary hover:underline">Open the conversation</Link>
          </div>
        </>)}

        {item.lesson && (<>
          <p className="text-[15px] leading-relaxed">“{item.lesson.content}”</p>
          <p className="text-[12.5px] text-muted-foreground">{item.lesson.agent} wrote this after someone corrected it, and follows it in every conversation from now on. Keep it, or Drop it to stop.</p>
          <div className="flex flex-wrap items-center gap-3">
            <LessonDecide id={item.lesson.id} itemKey={item.key} />
            {item.lesson.threadId && <Link href={`/ai?thread=${item.lesson.threadId}`} className="text-[13px] font-semibold text-primary hover:underline">Open the conversation</Link>}
          </div>
        </>)}

        {item.conflict && (<>
          <p className="text-[12.5px] text-muted-foreground">The nightly cleanup found two notes in {item.conflict.agent}&apos;s notebook that disagree{item.conflict.why ? ` (${item.conflict.why})` : ''}. It never guesses: pick the right one and the other is retired (Undo on AI › Memory).</p>
          <div className="flex flex-col divide-y divide-border/60">
            <Row label="First">{item.conflict.a}</Row>
            <Row label="Second">{item.conflict.b}</Row>
          </div>
          <ConflictDecide id={item.conflict.id} />
        </>)}

        {item.task && (<>
          <div className="flex flex-col divide-y divide-border/60">
            <Row label="Agent">{item.task.agent ?? 'None yet'}</Row>
            <Row label="Status">{item.task.status.replace('_', ' ')}</Row>
            <Row label="Priority">{item.task.priority}</Row>
          </div>
          {item.task.description && <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{item.task.description}</p>}
          {item.task.result && <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-xl bg-inset p-3 font-mono text-[11.5px] leading-relaxed">{item.task.result.slice(-6000)}</pre>}
          <div className="flex flex-wrap items-center gap-3">
            {item.task.threadId && <Link href={`/ai?thread=${item.task.threadId}`} className="text-[13px] font-semibold text-primary hover:underline">Open the run</Link>}
            <Link href="/ai/tasks" className="text-[13px] font-semibold text-primary hover:underline">Tasks</Link>
            <ClearItem itemKey={item.key} />
          </div>
        </>)}

        {item.run && (<>
          <p className="text-[13.5px] leading-relaxed">{item.run.summary || (item.run.failed ? 'It failed without a reason.' : 'It finished.')}</p>
          {item.run.output && <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap rounded-xl bg-inset p-3 font-mono text-[11.5px] leading-relaxed">{item.run.output.slice(-6000)}</pre>}
          <div className="flex flex-wrap items-center gap-3">
            {item.run.thread_id && <Link href={`/ai?thread=${item.run.thread_id}`} className="text-[13px] font-semibold text-primary hover:underline">Open the run</Link>}
            <Link href="/ai/routines" className="text-[13px] font-semibold text-primary hover:underline">Routines</Link>
            <ClearItem itemKey={item.key} />
          </div>
        </>)}
      </div>
    </Section>
  );
}

/** `picked`: the URL named an item. Desktop opens the first item anyway; phones show the list until one is picked. */
export function InboxPage({ items, counts, show, open, picked }: { items: InboxItem[]; counts: { needs: number; all: number }; show: 'needs' | 'all'; open: InboxItem | null; picked: boolean }) {
  const tab = (v: 'needs' | 'all', label: string, n: number) => (
    <Link href={href(v)} className={cn('rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold', show === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>{label} <span className="tabular-nums opacity-80">{n}</span></Link>
  );
  return (
    <div className="h-full overflow-y-auto">
      <div className={AI_PAGE}>
        <PageHeader title="Inbox" purpose="Everything that needs you: what the agents ask you to approve, the lessons they learned, notes to check and tasks that are blocked or have no agent; then routine runs from the last 7 days."
          actions={<div className="flex w-fit items-center gap-0.5 rounded-xl border border-border bg-card p-[3px]">{tab('needs', 'Needs you', counts.needs)}{tab('all', 'Everything', counts.all)}</div>} />
        {!items.length ? (
          <EmptyState title={show === 'needs' ? 'Nothing needs you' : 'Nothing here'}>{show === 'needs' ? <>Approvals and lessons show up here. <Link href={href('all')} className="font-semibold text-primary hover:underline">See everything</Link></> : 'Routine runs and requests from the last 7 days show up here.'}</EmptyState>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
            <nav aria-label="Inbox" className={cn('lg-card flex flex-col gap-0.5 rounded-[20px] bg-card p-2 shadow-[var(--card-shadow)]', picked && 'max-lg:hidden')}>
              {items.map((x) => {
                const Icon = x.run?.failed ? IconAlertTriangle : ICON[x.kind];
                return (
                  <Link key={x.key} href={href(show, x.key)} aria-current={open?.key === x.key ? 'true' : undefined}
                    className={cn('flex items-start gap-3 rounded-[14px] px-3 py-2.5', open?.key === x.key ? 'bg-primary/10' : 'hover:bg-inset')}>
                    <Icon size={18} stroke={1.8} className={cn('mt-0.5 shrink-0', x.run?.failed ? 'text-weak' : x.needsYou ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn('line-clamp-2 text-[13.5px] leading-snug', !x.read && 'font-semibold')}>{x.title}</span>
                      <span className="truncate text-[12px] text-muted-foreground">{x.sub}</span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1.5">
                      <span className="text-[11.5px] tabular-nums text-muted-foreground">{ago(x.at)}</span>
                      {!x.read && <span aria-label="Unread" className="size-2 rounded-full bg-primary" />}
                    </span>
                  </Link>
                );
              })}
            </nav>
            {open && (
              <div className={cn('flex flex-col gap-3 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:rounded-[22px]', !picked && 'max-lg:hidden')}>
                <Link href={href(show)} className="flex items-center gap-1 text-[13px] font-semibold text-primary lg:hidden"><IconArrowLeft size={15} />Inbox</Link>
                <Detail item={open} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
