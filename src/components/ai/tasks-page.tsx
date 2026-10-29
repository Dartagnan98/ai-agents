'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { PageHeader, Section } from '@/components/shared/page-kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { AI_PAGE } from './agents-page';
import { relTime } from './use-ai';

// AI › Tasks (D 2026-10-28): the agents' task board (lib/ai/tasks.ts). A task goes to an agent (none = the main
// agent), the clock starts it within a minute, and the card moves Pending -> In progress -> Completed or Blocked with the agent's answer.
interface Task { id: number; title: string; description: string; status: Status; priority: string; agent: string | null; agent_id: number | null; by_agent: string | null;
  result: string; run_thread: number | null; updated_at: string }
type Status = 'pending' | 'in_progress' | 'blocked' | 'completed';
const COLS: { key: Status; label: string; tone: string }[] = [
  { key: 'pending', label: 'Pending', tone: '' }, { key: 'in_progress', label: 'In progress', tone: 'bg-watch-bg text-watch' },
  { key: 'blocked', label: 'Blocked', tone: 'bg-weak-bg text-weak' }, { key: 'completed', label: 'Completed', tone: 'bg-healthy-bg text-healthy' },
];
const PRIORITIES = ['critical', 'urgent', 'high', 'normal', 'low'];
const SELECT = 'h-9 rounded-xl border border-border bg-background px-2 text-[13px]';
const Tag = ({ children, tone }: { children: React.ReactNode; tone?: string }) => <span className={cn('rounded-full bg-muted px-1.5 py-px text-[11px] font-semibold text-muted-foreground', tone)}>{children}</span>;

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [agents, setAgents] = useState<{ id: number; name: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', agentId: '', priority: 'normal' });
  const [err, setErr] = useState('');
  const load = useCallback(() => fetch('/api/ai/tasks').then((r) => r.json()).then((j) => setTasks(j.tasks ?? [])).catch(() => setTasks([])), []);
  useEffect(() => {
    load();
    fetch('/api/ai/agents').then((r) => r.json()).then((j) => setAgents((j.agents ?? []).map((a: { id: number; name: string }) => ({ id: a.id, name: a.name })))).catch(() => {});
    const t = setInterval(load, 15_000); // tasks run on the clock; keep the board current while open
    return () => clearInterval(t);
  }, [load]);
  const call = async (method: string, body?: object, id?: number) => {
    setErr('');
    const r = await fetch(`/api/ai/tasks${id ? `?id=${id}` : ''}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setErr(j.error ?? 'That did not work.');
    await load();
    return r.ok;
  };
  const add = async () => {
    if (await call('POST', { ...form, agentId: form.agentId ? Number(form.agentId) : null })) { setForm({ title: '', description: '', agentId: '', priority: 'normal' }); setOpen(false); }
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className={AI_PAGE}>
        <PageHeader title="Tasks" purpose="Work on the board for the agents. Each one starts within a minute; the result shows on its card."
          actions={<Button size="sm" onClick={() => setOpen((v) => !v)}>New task</Button>} />
        {open && (
          <Section flush>
            <div className="flex flex-col gap-2 px-6 md:px-7">
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What to do" />
              <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="The context and what done looks like" rows={3} />
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label="Agent" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })} className={SELECT}>
                  <option value="">Main agent</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <select aria-label="Priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} className={SELECT}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}
                </select>
                <Button size="sm" onClick={add} disabled={form.title.trim().length < 3}>Add to board</Button>
              </div>
            </div>
          </Section>
        )}
        {err && <p className="text-[13px] text-weak">{err}</p>}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {COLS.map((c) => {
            const col = (tasks ?? []).filter((t) => t.status === c.key);
            return (
              <Section key={c.key} flush>
                <div className="flex items-center gap-2 px-5 text-[13px] font-semibold">{c.label}<Tag tone={c.tone}>{col.length}</Tag></div>
                <div className="flex flex-col divide-y divide-border border-t border-border">
                  {tasks === null && <div className="px-5 py-3 text-[13px] text-muted-foreground">Loading…</div>}
                  {tasks && !col.length && <div className="px-5 py-3 text-[13px] text-muted-foreground">Nothing here.</div>}
                  {col.map((t) => (
                    <div key={t.id} className="flex flex-col gap-1.5 px-5 py-3">
                      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                        <span>#{t.id}</span>{t.priority !== 'normal' && <Tag tone={t.priority === 'critical' || t.priority === 'urgent' ? 'bg-weak-bg text-weak' : undefined}>{t.priority}</Tag>}
                        <span className="font-semibold text-foreground">{t.agent ?? 'Main agent'}</span>
                        <span className="ml-auto">{relTime(t.updated_at)} ago</span>
                      </div>
                      <p className="text-[13px] font-semibold leading-5">{t.title}</p>
                      {t.description && <p className="line-clamp-3 whitespace-pre-wrap text-[12.5px] leading-5 text-muted-foreground">{t.description}</p>}
                      {t.result && <p className="line-clamp-6 whitespace-pre-wrap border-l-2 border-border pl-3 text-[12.5px] leading-5">{t.result}</p>}
                      <div className="flex flex-wrap gap-3 text-[12px] font-semibold text-muted-foreground">
                        {t.by_agent && <span>from {t.by_agent}</span>}
                        {t.run_thread && <Link href={`/ai?thread=${t.run_thread}`} className="hover:text-foreground hover:underline">The run</Link>}
                        {(t.status === 'blocked' || t.status === 'completed') && <button type="button" onClick={() => call('PATCH', { status: 'pending' }, t.id)} className="hover:text-foreground hover:underline">Run again</button>}
                        {t.status !== 'completed' && t.status !== 'in_progress' && <button type="button" onClick={() => call('PATCH', { status: 'completed' }, t.id)} className="hover:text-foreground hover:underline">Mark done</button>}
                        {t.status !== 'in_progress' && <button type="button" onClick={() => { if (confirm(`Delete task #${t.id}?`)) void call('DELETE', undefined, t.id); }} className="hover:text-weak hover:underline">Delete</button>}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
