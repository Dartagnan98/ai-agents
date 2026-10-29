'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { IconChevronRight, IconCopy, IconDots, IconFolder, IconFolderMinus, IconFolderPlus, IconPencil, IconPlayerPlay, IconPlus, IconRepeat, IconSearch, IconTrash } from '@tabler/icons-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { EmptyState, PageHeader, Pill, Section, type Tone } from '@/components/shared/page-kit';
import { cn } from '@/lib/utils';
import { cronProblem, describeCron, nextRun, reactiveProblem } from '@/lib/ai/cron';
import { AI_PAGE } from './agents-page';
import { AgentGlyph } from './agent-mark';
import { notifyThreads, relTime, useAiAgents, useAiSkills } from './use-ai';
import { agencyTz, tzAbbr, tzName } from '@/lib/tz';

// AI › Routines (D, 2026-10-09: "Where are routines", RoutinesPage): an agent runs a prompt on a schedule (Eastern Time)
// and the result lands in a conversation, plus Telegram or Slack when picked. List: switch, schedule in words, agent, last run and its
// conversation, Run now, a menu (edit, duplicate, delete). Editor: a centered dialog like the agent editor, with the runs history.
interface Deliver { conversation: true; telegram?: string | null; slack?: string | null }
interface Routine {
  id: number; name: string; agent_id: number | null; prompt: string; schedule: string; schedule_text: string; enabled: boolean; deliver: Deliver; condition: string;
  last_run_at: number | null; next_run_at: number | null; last_status: string | null; last_thread_id: number | null; running_since: number | null;
  shared: boolean; can_edit?: boolean; folder: string;
}
interface Run { id: number; started_at: number; finished_at: number | null; status: 'running' | 'ok' | 'skipped' | 'error'; thread_id: number | null; summary: string; how: string }
interface Data { can_share?: boolean; routines: Routine[]; telegram: { id: string; label: string }[]; slack: boolean; slackChannels?: { id: string; name: string }[] }
type Draft = Omit<Routine, 'id' | 'schedule_text' | 'last_run_at' | 'next_run_at' | 'last_status' | 'last_thread_id' | 'running_since'> & { id?: number };

const FIELD = 'flex flex-col gap-1.5';
const LABEL = 'text-[12.5px] font-semibold text-muted-foreground';
const SELECT = 'h-9 rounded-lg border border-border bg-card px-2.5 text-[13px]';
const BLANK: Draft = { name: '', agent_id: null, prompt: '', schedule: '0 8 * * 1-5', enabled: true, deliver: { conversation: true }, condition: '', shared: false, folder: '' };

const at = (ms: number | null) => (ms ? new Date(ms).toLocaleString('en-US', { timeZone: agencyTz(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ` ${tzAbbr()}` : '');
function status(r: Routine): { text: string; tone: Tone } {
  const s = r.last_status ?? '';
  if (s === 'running' && r.running_since && Date.now() - r.running_since < 30 * 60_000) return { text: 'Running', tone: 'info' };
  if (s.startsWith('error')) return { text: 'Failed', tone: 'weak' };
  if (s === 'skipped') return { text: 'Skipped', tone: 'neutral' };
  if (s === 'ok') return { text: 'Ran', tone: 'healthy' };
  return { text: 'Not run yet', tone: 'neutral' };
}

export function RoutinesPage() {
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [running, setRunning] = useState<Set<number>>(new Set());
  const agents = useAiAgents()?.agents ?? [];
  const load = useCallback(() => fetch('/api/ai/routines', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((d) => d && setData(d)).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  // Operations › Workflows links here to edit one (?edit=<id>) or add one (?new=1) instead of keeping a second editor (2026-10-10)
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !data) return;
    const q = new URLSearchParams(window.location.search);
    const id = Number(q.get('edit'));
    const r = id ? data.routines.find((x) => x.id === id) : undefined;
    if (r) setDraft({ ...r });
    else if (q.get('new') === '1') setDraft({ ...BLANK, agent_id: agents.find((a) => a.is_default)?.id ?? null });
    opened.current = true;
  }, [data, agents]);

  const toggle = async (r: Routine) => {
    setData((d) => d && { ...d, routines: d.routines.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)) });
    const res = await fetch(`/api/ai/routines?id=${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !r.enabled }) });
    if (!res.ok) alert((await res.json().catch(() => ({}))).error ?? 'Could not change it.');
    void load();
  };
  const runNow = async (r: Routine) => {
    setRunning((s) => new Set(s).add(r.id));
    const res = await fetch(`/api/ai/routines?run=${r.id}`, { method: 'POST' }).catch(() => null);
    setRunning((s) => { const n = new Set(s); n.delete(r.id); return n; });
    if (!res?.ok) alert((await res?.json().catch(() => ({})))?.error ?? 'Could not run it.');
    notifyThreads(); void load();
  };
  const remove = async (r: Routine) => {
    if (!confirm(`Delete the routine "${r.name}"? Its past conversations stay.`)) return;
    const res = await fetch(`/api/ai/routines?id=${r.id}`, { method: 'DELETE' });
    if (res.ok) void load();
  };
  const agentOf = (id: number | null) => agents.find((a) => a.id === id) ?? agents.find((a) => a.is_default);
  const [selId, setSelId] = useState<number | null>(null);
  const sel = data?.routines.find((r) => r.id === selId) ?? data?.routines[0];
  // folders (D, 2026-10-28: "categories and folders we can make for routines so it's not so many we have to scroll"): closed until opened,
  // except the picked routine's; a search opens every match
  const [q, setQ] = useState('');
  const [openF, setOpenF] = useState<Set<string>>(new Set());
  const [shut, setShut] = useState<Set<string>>(new Set());
  const flip = (f: string, open: boolean) => {
    setOpenF((x) => { const n = new Set(x); if (open) n.delete(f); else n.add(f); return n; });
    setShut((x) => { const n = new Set(x); if (open) n.add(f); else n.delete(f); return n; });
  };
  const folders = [...new Set((data?.routines ?? []).map((r) => r.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const needle = q.trim().toLowerCase();
  const shown = (data?.routines ?? []).filter((r) => !needle || `${r.name} ${r.folder} ${r.prompt}`.toLowerCase().includes(needle));
  const groups = [...folders, ''].map((f) => [f, shown.filter((r) => r.folder === f)] as const).filter(([, l]) => l.length);
  const move = async (r: Routine, folder: string) => {
    setData((d) => d && { ...d, routines: d.routines.map((x) => (x.id === r.id ? { ...x, folder } : x)) });
    const res = await fetch(`/api/ai/routines?id=${r.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
    if (!res.ok) alert((await res.json().catch(() => ({}))).error ?? 'Could not move it.');
    void load();
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className={AI_PAGE}>
        <PageHeader title="Routines" purpose={`An agent does the work on a schedule (${tzName()}) and the result lands in a conversation, and on Telegram or Slack when you pick it. Shared by the owner and every admin.`}
          actions={<Button size="sm" onClick={() => setDraft({ ...BLANK, agent_id: agents.find((a) => a.is_default)?.id ?? null })} className="gap-1.5"><IconPlus size={15} />New routine</Button>} />
        {/* the canvas (D, 2026-10-28): the routines on the left, no lines between them; the picked one in full on the right with its runs */}
        {!data && <p className="text-[13px] text-muted-foreground">Loading...</p>}
        {data?.routines.length === 0 && <EmptyState title="No routines yet">Try a weekday morning summary of every contract.</EmptyState>}
        {sel && (
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <Section title="Routines" description={`${data!.routines.length} routines · ${data!.routines.filter((r) => r.enabled).length} on${folders.length ? ` · ${folders.length} folder${folders.length === 1 ? '' : 's'}` : ''}`}>
              <div className="flex flex-col gap-2">
                <div className="flex h-9 items-center gap-2 rounded-xl bg-foreground/[0.04] px-3">
                  <IconSearch size={15} className="shrink-0 text-muted-foreground" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a routine" aria-label="Find a routine" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
                </div>
                {/* a folder holds at least one routine: New folder files the open one into it (D, 2026-10-28: "where are the folders") */}
                {sel.can_edit !== false && (
                  <button type="button" onClick={() => { const f = prompt(`New folder name. "${sel.name}" goes in it; move others in from their ••• menu.`); if (f?.trim()) { void move(sel, f.trim()); setOpenF((x) => new Set(x).add(f.trim())); } }}
                    className="flex items-center gap-2 self-start rounded-lg px-2 py-1.5 text-[13px] font-semibold text-primary hover:bg-foreground/[0.04]"><IconFolderPlus size={15} />New folder</button>
                )}
                {!folders.length && <p className="px-2 text-[12.5px] text-muted-foreground">No folders yet. Open a routine, then New folder, or Move to from its ••• menu.</p>}
                {groups.map(([f, list]) => {
                  const open = !!q || openF.has(f) || (sel.folder === f && !shut.has(f));
                  return (
                    <div key={f || '-'} className="flex flex-col gap-1">
                      {(folders.length > 0 || f) && (
                        <button type="button" onClick={() => flip(f, open)} aria-expanded={open} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold hover:bg-foreground/[0.04]">
                          <IconChevronRight size={14} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
                          <IconFolder size={15} className="shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate">{f || 'No folder'}</span>
                          <span className="text-[12px] font-normal text-muted-foreground">{list.length}</span>
                        </button>
                      )}
                      {(open || (!folders.length && !f)) && list.map((r) => {
                        const a = agentOf(r.agent_id);
                        const st = running.has(r.id) ? { text: 'Running', tone: 'info' as Tone } : status(r);
                        return (
                          <div key={r.id} className={cn('flex items-center gap-3 rounded-xl px-3 py-2.5', folders.length > 0 && 'ml-4', r.id === sel.id ? 'lg-tint' : 'hover:bg-foreground/[0.04]')}>
                            <Switch checked={r.enabled} disabled={r.can_edit === false} onCheckedChange={() => void toggle(r)} aria-label={`${r.name} on`} />
                            <button type="button" onClick={() => setSelId(r.id)} aria-pressed={r.id === sel.id} className="min-w-0 flex-1 text-left">
                              <span className="block truncate text-[13.5px] font-semibold">{r.name}</span>
                              <span className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-muted-foreground">
                                <IconRepeat size={12} className="shrink-0" />{r.schedule_text}<span className="text-label">·</span><AgentGlyph icon={a?.icon} color={a?.color} size={12} />{a?.name ?? 'Agent'}
                              </span>
                            </button>
                            <Pill tone={r.enabled ? st.tone : 'neutral'} dot>{r.enabled ? st.text : 'Off'}</Pill>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                {!groups.length && <p className="px-2 py-3 text-[13px] text-muted-foreground">No routine matches &ldquo;{q}&rdquo;.</p>}
              </div>
            </Section>
            <RoutineDetail r={sel} agent={agentOf(sel.agent_id)} running={running.has(sel.id)} onRun={() => void runNow(sel)} onToggle={() => void toggle(sel)}
              onEdit={() => setDraft({ ...sel })} onCopy={() => setDraft({ ...sel, id: undefined, name: `${sel.name} (copy)`, enabled: false })} onDelete={() => void remove(sel)}
              folders={folders} onMove={(f) => void move(sel, f)} />
          </div>
        )}
      </div>
      <RoutineEditor draft={draft} data={data} onClose={() => setDraft(null)} onSaved={() => { setDraft(null); void load(); }} />
    </div>
  );
}

function RoutineDetail({ r, agent, running, onRun, onToggle, onEdit, onCopy, onDelete, folders, onMove }: {
  r: Routine; agent?: { name: string; icon?: string | null; color?: string | null }; running: boolean; onRun: () => void; onToggle: () => void; onEdit: () => void; onCopy: () => void; onDelete: () => void;
  folders: string[]; onMove: (folder: string) => void;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  useEffect(() => {
    let live = true;
    setRuns(null);
    fetch(`/api/ai/routines?runs=${r.id}`).then((x) => (x.ok ? x.json() : { runs: [] })).then((j) => { if (live) setRuns(j.runs); }).catch(() => {});
    return () => { live = false; };
  }, [r.id, r.last_run_at]);
  const sends = ['a conversation', r.deliver.telegram && 'Telegram', r.deliver.slack && 'Slack'].filter(Boolean).join(' + ');
  const tone: Record<Run['status'], Tone> = { ok: 'healthy', running: 'info', skipped: 'neutral', error: 'weak' };
  const word: Record<Run['status'], string> = { ok: 'Done', running: 'Running', skipped: 'Skipped', error: 'Failed' };
  return (
    // stays in view while the list scrolls (a wrapper: the glass card rule sets position on the card itself)
    <div className="lg:sticky lg:top-0 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:rounded-[22px]">
    <Section title={r.name} description={r.folder ? `In ${r.folder}` : undefined}
      actions={<div className="flex items-center gap-2">
        <Switch checked={r.enabled} disabled={r.can_edit === false} onCheckedChange={onToggle} aria-label={`${r.name} on`} />
        <Button variant="outline" size="sm" disabled={running} onClick={onRun} className="gap-1.5"><IconPlayerPlay size={13} />{running ? 'Running' : 'Run now'}</Button>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label={`More for ${r.name}`} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-foreground"><IconDots size={16} /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[200px]">
            <DropdownMenuItem onClick={onEdit}><IconPencil size={15} stroke={1.8} />Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={onCopy}><IconCopy size={15} stroke={1.8} />Duplicate</DropdownMenuItem>
            {r.can_edit !== false && <>
              {folders.filter((f) => f !== r.folder).map((f) => <DropdownMenuItem key={f} onClick={() => onMove(f)}><IconFolder size={15} stroke={1.8} />Move to {f}</DropdownMenuItem>)}
              <DropdownMenuItem onClick={() => { const f = prompt('New folder name'); if (f?.trim()) onMove(f.trim()); }}><IconFolderPlus size={15} stroke={1.8} />Move to a new folder</DropdownMenuItem>
              {r.folder && <DropdownMenuItem onClick={() => onMove('')}><IconFolderMinus size={15} stroke={1.8} />Take out of {r.folder}</DropdownMenuItem>}
            </>}
            <DropdownMenuItem onClick={onDelete} className="text-weak"><IconTrash size={15} stroke={1.8} />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>}>
      <dl className="flex flex-col gap-4">
        <div className="flex flex-col gap-1"><dt className={LABEL}>Schedule</dt><dd className="text-[13.5px]">{r.schedule_text}{r.enabled && r.next_run_at ? <span className="text-muted-foreground"> · next {at(r.next_run_at)}</span> : null}</dd></div>
        <div className="flex flex-col gap-1"><dt className={LABEL}>Runs with</dt><dd className="flex items-center gap-1.5 text-[13.5px]"><AgentGlyph icon={agent?.icon ?? undefined} color={agent?.color ?? undefined} size={14} />{agent?.name ?? 'Agent'}</dd></div>
        <div className="flex flex-col gap-1"><dt className={LABEL}>What to do each time</dt><dd><pre className="whitespace-pre-wrap rounded-xl bg-foreground/[0.04] px-3.5 py-3 font-sans text-[13px] leading-relaxed">{r.prompt}</pre></dd></div>
        {r.condition && <div className="flex flex-col gap-1"><dt className={LABEL}>Only when</dt><dd className="text-[13.5px]">{r.condition}</dd></div>}
        <div className="flex flex-col gap-1"><dt className={LABEL}>Send results to</dt><dd className="text-[13.5px]">{sends}</dd></div>
        <div className="flex flex-col gap-1.5"><dt className={LABEL}>Runs</dt>
          <dd className="flex flex-col gap-1">
            {!runs && <span className="text-[13px] text-muted-foreground">Loading...</span>}
            {runs?.length === 0 && <span className="text-[13px] text-muted-foreground">Not run yet.</span>}
            {runs?.slice(0, 12).map((x) => (
              <div key={x.id} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-foreground/[0.04]">
                <Pill tone={tone[x.status]} dot>{word[x.status]}</Pill>
                <span className="min-w-0 flex-1 truncate text-[13px]">{x.summary || x.how || '—'}</span>
                {x.thread_id ? <Link href={`/ai?thread=${x.thread_id}`} className="shrink-0 text-[12px] text-muted-foreground hover:text-foreground hover:underline">{at(x.started_at)}</Link>
                  : <span className="shrink-0 text-[12px] text-muted-foreground">{at(x.started_at)}</span>}
              </div>
            ))}
          </dd>
        </div>
      </dl>
    </Section>
    </div>
  );
}

// ─── schedule presets <-> cron ───
type Kind = 'posts' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';
interface Sched { kind: Kind; time: string; minute: number; day: number; dom: number; cron: string }
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function toSched(cron: string): Sched {
  const base: Sched = { kind: 'custom', time: '08:00', minute: 0, day: 1, dom: 1, cron };
  if (!cron.trim()) return { ...base, kind: 'posts' };
  const [mi, h, d, mo, w] = cron.trim().split(/\s+/);
  const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : null);
  if (mo !== '*' || num(mi) === null) return base;
  if (h === '*' && d === '*' && w === '*') return { ...base, kind: 'hourly', minute: num(mi)! };
  const hh = num(h);
  if (hh === null) return base;
  const time = `${String(hh).padStart(2, '0')}:${String(num(mi)).padStart(2, '0')}`;
  if (d === '*' && w === '*') return { ...base, kind: 'daily', time };
  if (d === '*' && w === '1-5') return { ...base, kind: 'weekdays', time };
  if (d === '*' && num(w) !== null) return { ...base, kind: 'weekly', time, day: num(w)! % 7 };
  if (num(d) !== null && w === '*') return { ...base, kind: 'monthly', time, dom: num(d)! };
  return base;
}
function toCron(s: Sched): string {
  const [h, m] = s.time.split(':').map(Number);
  if (s.kind === 'posts') return '';
  if (s.kind === 'hourly') return `${s.minute} * * * *`;
  if (s.kind === 'daily') return `${m} ${h} * * *`;
  if (s.kind === 'weekdays') return `${m} ${h} * * 1-5`;
  if (s.kind === 'weekly') return `${m} ${h} * * ${s.day}`;
  if (s.kind === 'monthly') return `${m} ${h} ${s.dom} * *`;
  return s.cron.trim();
}

function RoutineEditor({ draft, data, onClose, onSaved }: { draft: Draft | null; data: Data | null; onClose: () => void; onSaved: () => void }) {
  const agents = useAiAgents()?.agents ?? [];
  const skills = useAiSkills();
  const [d, setD] = useState<Draft>(BLANK);
  const [sched, setSched] = useState<Sched>(toSched(BLANK.schedule));
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Draft | null>(null);
  const [slashAt, setSlashAt] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  if (draft !== shown) {
    setShown(draft);
    if (draft) { setD(draft); setSched(toSched(draft.schedule)); setErr(''); setRuns(null); }
  }
  useEffect(() => {
    if (!draft?.id) return;
    let live = true;
    fetch(`/api/ai/routines?runs=${draft.id}`).then((r) => (r.ok ? r.json() : { runs: [] })).then((j) => { if (live) setRuns(j.runs); }).catch(() => {});
    return () => { live = false; };
  }, [draft]);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const setS = (p: Partial<Sched>) => setSched((x) => ({ ...x, ...p, ...(p.kind === 'custom' ? { cron: toCron(x) } : {}) }));
  const cron = toCron(sched);
  const problem = cron ? cronProblem(cron) : reactiveProblem(d.condition);
  const next = problem || !cron ? null : nextRun(cron);

  // "/" skills while the first word is typed (same as the chat): the run expands /skill on the server
  const slash = /^\/([a-z0-9-]*)$/i.exec(d.prompt);
  const slashList = slash && skills ? skills.filter((s) => s.name.startsWith(slash[1].toLowerCase())).slice(0, 8) : [];
  const pickSkill = (name: string) => { set({ prompt: `/${name} ` }); setSlashAt(0); box.current?.focus(); };

  const save = async () => {
    if (problem) { setErr(problem); return; }
    setBusy(true); setErr('');
    const body = { ...d, schedule: cron };
    const r = await fetch(d.id ? `/api/ai/routines?id=${d.id}` : '/api/ai/routines', { method: d.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (r?.ok) onSaved(); else setErr((await r?.json().catch(() => ({})))?.error ?? 'Could not save.');
  };
  const tg = data?.telegram ?? [], chans = data?.slackChannels ?? [];
  return (
    <Dialog open={!!draft} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>{d.id ? `Edit ${d.name || 'routine'}` : 'New routine'}</DialogTitle>
          <DialogDescription>{d.can_edit === false ? 'A team routine: only the owner or its maker changes it. ' : ''}Runs as {d.id ? 'its maker' : 'you'}, with the agent&apos;s tools. Times are {tzName()}.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          <div className={FIELD}><label className={LABEL} htmlFor="rt-name">Name</label><Input id="rt-name" value={d.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} placeholder="Morning review" /></div>
          <div className={FIELD}><label className={LABEL} htmlFor="rt-folder">Folder</label>
            <Input id="rt-folder" list="rt-folders" value={d.folder} maxLength={60} onChange={(e) => set({ folder: e.target.value })} placeholder="None (pick one or type a new name)" />
            <datalist id="rt-folders">{[...new Set((data?.routines ?? []).map((x) => x.folder).filter(Boolean))].map((f) => <option key={f} value={f} />)}</datalist></div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="rt-agent">Runs with</label>
            <select id="rt-agent" value={d.agent_id ?? ''} onChange={(e) => set({ agent_id: Number(e.target.value) || null })} className={SELECT}>
              {!d.agent_id && <option value="">Default agent</option>}
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.description ? `: ${a.description}` : ''}</option>)}
            </select>
          </div>
          <div className={cn(FIELD, 'relative')}>
            <label className={LABEL} htmlFor="rt-prompt">What to do each time</label>
            {slashList.length > 0 && (
              <div role="listbox" aria-label="Skills" className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-[0_12px_30px_-12px_rgba(14,20,34,0.35)]">
                {slashList.map((s, k) => (
                  <button key={s.id} type="button" role="option" aria-selected={k === slashAt} onMouseEnter={() => setSlashAt(k)} onClick={() => pickSkill(s.name)}
                    className={cn('flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]', k === slashAt && 'bg-inset')}>
                    <span className="font-semibold">/{s.name}</span><span className="truncate text-[12px] text-muted-foreground">{s.description}</span>
                  </button>
                ))}
              </div>
            )}
            <Textarea id="rt-prompt" ref={box} value={d.prompt} rows={7} className="min-h-36 text-[13px]" onChange={(e) => { set({ prompt: e.target.value }); setSlashAt(0); }}
              onKeyDown={(e) => {
                if (!slashList.length) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); setSlashAt((k) => (k + 1) % slashList.length); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setSlashAt((k) => (k - 1 + slashList.length) % slashList.length); }
                else if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); pickSkill(slashList[Math.min(slashAt, slashList.length - 1)].name); }
              }}
              placeholder="Summarise yesterday for every contract: cash collected, calls, show and close rates. Or start with /skill." />
          </div>
          <div className={FIELD}>
            <span className={LABEL}>Schedule</span>
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Repeat" value={sched.kind} onChange={(e) => setS({ kind: e.target.value as Kind })} className={SELECT}>
                <option value="posts">New posts only</option><option value="hourly">Every hour</option><option value="daily">Every day</option><option value="weekdays">Weekdays</option>
                <option value="weekly">Every week</option><option value="monthly">Every month</option><option value="custom">Custom (cron)</option>
              </select>
              {sched.kind === 'hourly' && <label className="flex items-center gap-1.5 text-[13px]">at minute<Input type="number" min={0} max={59} value={sched.minute} onChange={(e) => setS({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} className="h-9 w-20" /></label>}
              {sched.kind === 'weekly' && <select aria-label="Day" value={sched.day} onChange={(e) => setS({ day: Number(e.target.value) })} className={SELECT}>{DAYS.map((n, i) => <option key={n} value={i}>on {n}</option>)}</select>}
              {sched.kind === 'monthly' && <select aria-label="Day of month" value={sched.dom} onChange={(e) => setS({ dom: Number(e.target.value) })} className={SELECT}>{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>on day {i + 1}</option>)}</select>}
              {sched.kind !== 'hourly' && sched.kind !== 'custom' && <label className="flex items-center gap-1.5 text-[13px]">at<Input type="time" value={sched.time} onChange={(e) => setS({ time: e.target.value || '08:00' })} className="h-9 w-32" /></label>}
              {sched.kind === 'custom' && <Input aria-label="Cron" value={sched.cron} onChange={(e) => setS({ cron: e.target.value })} placeholder="0 8 * * 1-5" className="h-9 w-48 font-mono text-[12.5px]" />}
            </div>
            <span className={cn('text-[11.5px]', problem ? 'text-weak' : 'text-muted-foreground')}>
              {problem ?? (cron ? `${describeCron(cron)}${next ? `. Next: ${at(next)}` : ''}` : 'Runs within about 20 seconds of each new post in the channel named in "Only run if", or within a minute of the event when "Only run if" is when:task_blocked or when:routine_failed.')}
            </span>
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="rt-cond">Only run if (optional)</label>
            <Input id="rt-cond" value={d.condition} maxLength={1000} onChange={(e) => set({ condition: e.target.value })} placeholder="there were payments to check yesterday" />
            <span className="text-[11.5px] text-muted-foreground">The agent checks this first. If it is not true, the run is skipped and nothing is sent.</span>
          </div>
          <div className={FIELD}>
            <span className={LABEL}>Send results to</span>
            <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
              <label className="flex items-center gap-2.5 px-3 py-2.5 opacity-80"><input type="checkbox" checked disabled className="accent-primary" /><span className="text-[13px]">A conversation in AI (always)</span></label>
              <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5">
                <input type="checkbox" id="rt-tg" className="accent-primary" disabled={!tg.length} checked={!!d.deliver.telegram}
                  onChange={(e) => set({ deliver: { ...d.deliver, telegram: e.target.checked ? tg[0]?.id ?? null : null } })} />
                <label htmlFor="rt-tg" className="text-[13px]">Telegram</label>
                {tg.length ? (d.deliver.telegram && (
                  <select aria-label="Telegram bot" value={d.deliver.telegram} onChange={(e) => set({ deliver: { ...d.deliver, telegram: e.target.value } })} className={cn(SELECT, 'h-8')}>
                    {tg.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                    {!tg.some((t) => t.id === d.deliver.telegram) && <option value={d.deliver.telegram}>{d.deliver.telegram} (not set up)</option>}
                  </select>
                )) : <span className="text-[11.5px] text-label">Set up a bot in Settings › Telegram first</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5">
                <input type="checkbox" id="rt-slack" className="accent-primary" disabled={!data?.slack && !d.deliver.slack} checked={d.deliver.slack != null}
                  onChange={(e) => set({ deliver: { ...d.deliver, slack: e.target.checked ? (chans[0]?.id ?? '') : null } })} />
                <label htmlFor="rt-slack" className="text-[13px]">Slack channel</label>
                {chans.length && d.deliver.slack != null ? (
                  // the agency's AI Agents Slack bot (D, 2026-10-10): the channels it is in
                  <select aria-label="Slack channel" value={d.deliver.slack} onChange={(e) => set({ deliver: { ...d.deliver, slack: e.target.value } })} className={cn(SELECT, 'h-8')}>
                    {chans.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                    {!!d.deliver.slack && !chans.some((c) => c.id === d.deliver.slack) && <option value={d.deliver.slack}>{d.deliver.slack} (bot not in it)</option>}
                  </select>
                ) : data?.slack || d.deliver.slack ? (d.deliver.slack != null && (
                  <Input aria-label="Slack channel" value={d.deliver.slack} onChange={(e) => set({ deliver: { ...d.deliver, slack: e.target.value } })} placeholder="Channel id, like C0123ABC" className="h-8 w-56 text-[12.5px]" />
                )) : <span className="text-[11.5px] text-label">Connect Slack in Settings › Agency › Agency tools first</span>}
              </div>
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
            <span><span className="block text-[13px] font-semibold">On</span><span className="block text-[11.5px] text-muted-foreground">Off = it only runs when you press Run now</span></span>
            <Switch checked={d.enabled} onCheckedChange={(v) => set({ enabled: v })} aria-label="On" />
          </label>
          {/* team or only me (D, 2026-10-12): team routines are set up by the owner and everyone with AI access sees them */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
            <span><span className="block text-[13px] font-semibold">Who it is for</span><span className="block text-[11.5px] text-muted-foreground">{data?.can_share ? 'Team: everyone with AI access sees it and its results go to the team channels. Only me: yours alone.' : 'Only the owner makes team routines; yours are for you only.'}</span></span>
            <span className="flex h-8 shrink-0 rounded-lg border border-border bg-inset p-0.5">
              {([['me', 'Only me'], ['team', 'Team']] as const).map(([k, l]) => {
                const on = (k === 'team') === d.shared;
                return <button key={k} type="button" disabled={(k === 'team' && !data?.can_share) || d.can_edit === false} onClick={() => set({ shared: k === 'team' })}
                  className={cn('rounded-md px-2.5 text-[12.5px] font-semibold disabled:opacity-50', on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}>{l}</button>;
              })}
            </span>
          </div>
          {d.id && (
            <div className={FIELD}>
              <span className={LABEL}>Runs</span>
              <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
                {runs === null && <span className="px-3 py-2.5 text-[12.5px] text-label">Loading...</span>}
                {runs?.length === 0 && <span className="px-3 py-2.5 text-[12.5px] text-label">No runs yet</span>}
                {runs?.map((r) => (
                  <div key={r.id} className="flex items-start gap-2.5 px-3 py-2">
                    <Pill tone={r.status === 'ok' ? 'healthy' : r.status === 'error' ? 'weak' : r.status === 'running' ? 'info' : 'neutral'} dot>{r.status === 'ok' ? 'Ran' : r.status[0].toUpperCase() + r.status.slice(1)}</Pill>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] text-muted-foreground">{at(r.started_at)}{r.how === 'manual' ? ' · by hand' : ''}</span>
                      {r.summary && <span className="block truncate text-[12.5px]" title={r.summary}>{r.summary}</span>}
                    </span>
                    {r.thread_id && <Link href={`/ai?thread=${r.thread_id}`} className="shrink-0 text-[12px] font-semibold text-muted-foreground hover:text-foreground hover:underline">Open</Link>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {err && <div className="rounded-lg bg-weak-bg px-3 py-2 text-[12.5px] text-weak">{err}</div>}
        </div>
        <DialogFooter className="flex-row justify-end gap-2 border-t border-border px-6 py-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || d.can_edit === false || !d.name.trim() || !d.prompt.trim() || !!problem || (d.deliver.slack != null && !d.deliver.slack.trim())} onClick={() => void save()}>{d.id ? 'Save' : 'Add routine'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
