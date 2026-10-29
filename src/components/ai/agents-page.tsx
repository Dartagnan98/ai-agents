'use client';

import { useState } from 'react';
import Link from 'next/link';
import { IconDots, IconMessagePlus, IconPlus, IconTrash } from '@tabler/icons-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { PageHeader, Pill, Section } from '@/components/shared/page-kit';
import { cn } from '@/lib/utils';
import { AGENT_COLORS, AGENT_ICONS, MEMORY_TOOLS, TOOL_INFO, TOOL_NAMES } from '@/lib/ai/catalog';
import { DEFAULT_MODEL, findModel } from '@/lib/ai/models';
import { AgentMark } from './agent-mark';
import { refreshAgents, useAiAgents, type UiAgent } from './use-ai';

// AI › Agents (D, 2026-10-09, Agents list + AgentEditor): the install's agents, one row each, and an editor sheet (name,
// line, mark, instructions, model, tools, memory, starters). Agents are shared by the owner and every admin; the default one stays.
type Draft = Omit<UiAgent, 'id' | 'is_default'> & { id?: number; is_default?: boolean };
const BLANK: Draft = { name: '', description: '', instructions: '', model: DEFAULT_MODEL, tools: [], use_memory: true, starters: [], icon: 'sparkles', color: 'ink', shared: false };
const FIELD = 'flex flex-col gap-1.5';
const ROLE0 = { title: '', summary: '', owns: [] as string[], not_owns: [] as string[] };
const LABEL = 'text-[12.5px] font-semibold text-muted-foreground';
// every AI page: full width with the business pages' padding (D, 2026-10-28: "theres a bunch of inconsistency ... it's all in AI")
// D, 2026-10-28 ("not so wide"): capped and centred, the same as the Operations and Intelligence pages (app/liquid-glass.css)
export const AI_PAGE = 'mx-auto flex w-full max-w-[1304px] flex-col gap-6 px-4 py-6 md:px-8 md:pb-8 md:pt-6';

export function AgentsPage() {
  const data = useAiAgents();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selId, setSelId] = useState<number | null>(null);
  const remove = async (a: UiAgent) => {
    if (!confirm(`Remove ${a.name}? Its conversations stay and move to the default agent.`)) return;
    const r = await fetch(`/api/ai/agents?id=${a.id}`, { method: 'DELETE' });
    if (r.ok) { refreshAgents(); setSelId(null); } else alert((await r.json().catch(() => ({}))).error ?? 'Could not remove it.');
  };
  const agents = data?.agents ?? [];
  const sel = agents.find((a) => a.id === selId) ?? agents.find((a) => a.is_default) ?? agents[0];
  const toolsOf = (a: UiAgent) => (a.tools.length ? a.tools : TOOL_NAMES);
  // the canvas (D, 2026-10-28: "did you match canvas?"): one glass card per agent on the left, the picked agent in full on the right
  return (
    <div className="h-full overflow-y-auto">
      <div className={AI_PAGE}>
        <PageHeader title="Agents" purpose="Each agent has its own instructions, model and tools. Pick one in any chat header. Shared by the owner and every admin."
          actions={<Button size="sm" onClick={() => setDraft({ ...BLANK })} className="gap-1.5"><IconPlus size={15} />New agent</Button>} />
        {!data && <p className="text-[13px] text-muted-foreground">Loading...</p>}
        {sel && (
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              {agents.map((a) => (
                <div key={a.id} role="button" tabIndex={0} aria-pressed={a.id === sel.id} onClick={() => setSelId(a.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelId(a.id); } }}
                  className={cn('lg-card flex cursor-pointer flex-col gap-2.5 rounded-[20px] bg-card px-5 py-[18px] shadow-[var(--card-shadow)] outline-none focus-visible:ring-2 focus-visible:ring-primary',
                    a.id === sel.id && 'ring-2 ring-primary')}>
                  <div className="flex items-center gap-3">
                    <AgentMark icon={a.icon} color={a.color} avatar={a.avatar} size={38} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[15px] font-semibold">{a.name}</span>
                      <span className="text-[12.5px] leading-snug text-muted-foreground">{findModel(a.model)?.label ?? 'Sonnet 5.5'} · {toolsOf(a).length} tools{a.use_memory ? ' · memory' : ''}</span>
                    </span>
                    {a.is_default && <Pill>Default</Pill>}
                  </div>
                  <p className="line-clamp-2 text-[13.5px] leading-snug">{a.description || 'No description'}</p>
                  <span className="text-[12.5px] text-muted-foreground">Who can use it: {a.shared === false ? 'Only you' : 'Owner and admins'}</span>
                  <div className="mt-auto flex items-center gap-3 pt-1">
                    <Link href={`/ai?agent=${a.id}`} onClick={(e) => e.stopPropagation()} className="text-[13.5px] font-semibold text-primary hover:underline">New conversation</Link>
                  </div>
                </div>
              ))}
            </div>
            <div className="lg:sticky lg:top-0 lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:rounded-[22px]">
            <Section title={<span className="flex items-center gap-2.5"><AgentMark icon={sel.icon} color={sel.color} avatar={sel.avatar} size={28} />{sel.name}{sel.is_default && <Pill>Default</Pill>}</span>}
              actions={<div className="flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setDraft({ ...sel })}>{sel.can_edit === false ? 'View' : 'Edit'}</Button>
                <DropdownMenu>
                  <DropdownMenuTrigger aria-label={`More for ${sel.name}`} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-foreground"><IconDots size={16} /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-[220px]">
                    <DropdownMenuItem render={<Link href={`/ai?agent=${sel.id}`} />}><IconMessagePlus size={15} stroke={1.8} />New conversation</DropdownMenuItem>
                    {!sel.is_default && <DropdownMenuItem onClick={() => void remove(sel)} className="text-weak"><IconTrash size={15} stroke={1.8} />Remove</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>}>
              <dl className="flex flex-col gap-4">
                <Fact label="Model">{findModel(sel.model)?.label ?? sel.model}</Fact>
                <Fact label="Description">{sel.description || 'No description'}</Fact>
                <Fact label="Who can use it">{sel.shared === false ? 'Only you' : 'The owner and every admin'}</Fact>
                {(sel.role?.title || sel.role?.summary || !!sel.role?.owns.length || !!sel.role?.not_owns.length) && <Fact label="Role card">
                  <div className="flex flex-col gap-1.5 text-[13px]">
                    {sel.role?.title && <span className="font-semibold">{sel.role.title}</span>}
                    {sel.role?.summary && <span>{sel.role.summary}</span>}
                    {!!sel.role?.owns.length && <span><span className="text-muted-foreground">Owns: </span>{sel.role.owns.join(' · ')}</span>}
                    {!!sel.role?.not_owns.length && <span><span className="text-muted-foreground">Hands off: </span>{sel.role.not_owns.join(' · ')}</span>}
                  </div>
                </Fact>}
                <Fact label="Instructions"><pre className="whitespace-pre-wrap rounded-xl bg-foreground/[0.04] px-3.5 py-3 font-mono text-[12.5px] leading-relaxed">{sel.instructions || 'No instructions: it follows the defaults.'}</pre></Fact>
                <Fact label={`Tools (${toolsOf(sel).length})`}>
                  <span className="flex flex-wrap gap-1.5">{toolsOf(sel).map((t) => <span key={t} className="rounded-full bg-foreground/[0.06] px-2.5 py-1 font-mono text-[11.5px]">{t}</span>)}</span>
                </Fact>
                {sel.night_shift ? <Fact label="Night shift">On: a Night shift card on the task board each night (00:00 to 08:00)</Fact> : null}
                {sel.daily_budget_usd ? <Fact label="Daily cap">${sel.daily_budget_usd} a day at API prices: routines, tasks and agent asks stop for the day past it</Fact> : null}
                <Fact label="Memory">{sel.use_memory ? 'On: reads and writes team memory' : 'Off'}</Fact>
                {sel.starters.length > 0 && <Fact label="Starters"><ul className="flex flex-col gap-1">{sel.starters.map((x) => <li key={x}>{x}</li>)}</ul></Fact>}
              </dl>
            </Section>
            </div>
          </div>
        )}
      </div>
      <AgentEditor draft={draft} models={data?.models ?? []} apps={data?.apps ?? []} canShare={!!data?.can_share} onClose={() => setDraft(null)} />
    </div>
  );
}

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1"><dt className="text-[12.5px] font-semibold text-muted-foreground">{label}</dt><dd className="text-[13.5px] leading-snug">{children}</dd></div>
);

function AgentEditor({ draft, models, apps, canShare, onClose }: { draft: Draft | null; models: { id: string; label: string; sub: string }[]; apps: string[]; canShare: boolean; onClose: () => void }) {
  const [d, setD] = useState<Draft>(BLANK);
  const [starters, setStarters] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<Draft | null>(null);
  // an agent saved with no list has every tool; the checkboxes show that as all ticked
  const [picked, setPicked] = useState<string[]>(TOOL_NAMES);
  if (draft !== shown) { setShown(draft); if (draft) { setD(draft); setPicked(draft.tools.length ? draft.tools : TOOL_NAMES); setStarters(draft.starters.join('\n')); setErr(''); } }
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const toggle = (n: string) => setPicked((p) => TOOL_NAMES.filter((x) => (x === n ? !p.includes(n) : p.includes(x))));
  const save = async () => {
    // an empty list means every tool, so an agent keeps at least one
    if (!picked.length) { setErr('Pick at least one tool.'); return; }
    setBusy(true); setErr('');
    const tools = picked.length === TOOL_NAMES.length ? [] : picked;
    const body = { ...d, tools, starters: starters.split('\n').map((s) => s.trim()).filter(Boolean) };
    const r = await fetch(d.id ? `/api/ai/agents?id=${d.id}` : '/api/ai/agents', { method: d.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(false);
    if (r?.ok) { refreshAgents(); onClose(); } else setErr((await r?.json().catch(() => ({})))?.error ?? 'Could not save.');
  };
  const modelList = models.length ? models : [];
  const current = findModel(d.model);
  return (
    <Dialog open={!!draft} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>{d.id ? `Edit ${d.name || 'agent'}` : 'New agent'}</DialogTitle>
          <DialogDescription>{d.can_edit === false ? 'A team agent: only the owner changes it.' : d.shared === false ? 'Private: only you see and use it.' : 'Team: everyone with AI access uses it; only the owner changes it.'}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          <div className="flex items-end gap-3">
            <AgentMark icon={d.icon} color={d.color} avatar={d.avatar} size={40} />
            <div className={cn(FIELD, 'flex-1')}><label className={LABEL} htmlFor="ag-name">Name</label><Input id="ag-name" value={d.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} placeholder="Analyst" /></div>
          </div>
          <div className={FIELD}><label className={LABEL} htmlFor="ag-desc">Description</label><Input id="ag-desc" value={d.description} maxLength={160} onChange={(e) => set({ description: e.target.value })} placeholder="One line on what it is for" /></div>
          <div className={FIELD}>
            <span className={LABEL}>Look</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {AGENT_ICONS.map((i) => <button key={i} type="button" aria-label={i} aria-pressed={d.icon === i} onClick={() => set({ icon: i })} className={cn('rounded-[9px] p-0.5 ring-2', d.icon === i ? 'ring-foreground/40' : 'ring-transparent')}><AgentMark icon={i} color={d.color} size={26} /></button>)}
              <span className="mx-1 h-6 w-px bg-border" />
              {AGENT_COLORS.map((c) => <button key={c} type="button" aria-label={c} aria-pressed={d.color === c} onClick={() => set({ color: c })} className={cn('rounded-full p-0.5 ring-2', d.color === c ? 'ring-foreground/40' : 'ring-transparent')}><AgentMark icon={d.icon} color={c} size={20} className="!rounded-full" /></button>)}
              <span className="mx-1 h-6 w-px bg-border" />
              {/* upload an avatar (D, 2026-10-09, CTRL Flow's): it replaces the icon tile everywhere */}
              <label className="cursor-pointer rounded-lg border border-border px-2 py-1 text-[12px] font-semibold text-muted-foreground hover:text-foreground">
                {d.avatar ? 'Change avatar' : 'Upload avatar'}
                <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => {
                  const f = e.target.files?.[0]; if (!f) return; const r = new FileReader();
                  r.onload = () => { const url = String(r.result); if (url.length > 200_000) setErr('Keep the avatar under 150 KB.'); else set({ avatar: url }); };
                  r.readAsDataURL(f); e.target.value = '';
                }} />
              </label>
              {d.avatar && <button type="button" onClick={() => set({ avatar: '' })} className="text-[12px] text-muted-foreground hover:text-foreground">Remove</button>}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={!!d.night_shift} onChange={(e) => set({ night_shift: e.target.checked })} />
            Night shift: a card on the task board each night to work the board and find work (no messages to people)
          </label>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="ag-cap">Daily cap (API-price dollars, empty = none)</label>
            <Input id="ag-cap" type="number" min={0} step={1} value={d.daily_budget_usd ?? ''} onChange={(e) => set({ daily_budget_usd: e.target.value === '' ? null : Number(e.target.value) })} className="h-9 w-40 text-[13px]" placeholder="No cap" />
          </div>
          <div className={FIELD}>
            <span className={LABEL}>Role card</span>
            <Input aria-label="Role title" value={d.role?.title ?? ''} onChange={(e) => set({ role: { ...ROLE0, ...d.role, title: e.target.value } })} placeholder="Title, e.g. Payments lead" className="h-9 text-[13px]" />
            <Textarea aria-label="Role summary" value={d.role?.summary ?? ''} onChange={(e) => set({ role: { ...ROLE0, ...d.role, summary: e.target.value } })} rows={2} className="text-[13px]" placeholder="The job in a line or two" />
            <Textarea aria-label="Owns" value={(d.role?.owns ?? []).join('\n')} onChange={(e) => set({ role: { ...ROLE0, ...d.role, owns: e.target.value.split('\n') } })} rows={3} className="text-[13px]" placeholder="What it owns, one per line" />
            <Textarea aria-label="Not its work" value={(d.role?.not_owns ?? []).join('\n')} onChange={(e) => set({ role: { ...ROLE0, ...d.role, not_owns: e.target.value.split('\n') } })} rows={2} className="text-[13px]" placeholder="What it hands off, one per line" />
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="ag-ins">Instructions</label>
            <Textarea id="ag-ins" value={d.instructions} onChange={(e) => set({ instructions: e.target.value })} rows={8} className="min-h-40 text-[13px]"
              placeholder="What this agent does, what it looks at first, how it answers. Added to the app's own rules." />
          </div>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="ag-model">Model</label>
            <select id="ag-model" value={current?.id ?? DEFAULT_MODEL} onChange={(e) => set({ model: e.target.value })} className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px]">
              {modelList.map((m) => <option key={m.id} value={m.id}>{m.label}: {m.sub}</option>)}
              {!modelList.some((m) => m.id === (current?.id ?? DEFAULT_MODEL)) && <option value={current?.id ?? DEFAULT_MODEL}>{current?.label ?? 'Sonnet 5.5'} (not connected)</option>}
            </select>
            {!models.length && <span className="text-[11.5px] text-weak">No AI is connected on this server. Connect a Claude login in Settings.</span>}
          </div>
          <div className={FIELD}>
            <span className={LABEL}>Tools</span>
            <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
              {TOOL_INFO.map((t) => {
                const off = t.memory && !d.use_memory;
                return (
                  <label key={t.name} className={cn('flex cursor-pointer items-start gap-2.5 px-3 py-2.5', off && 'cursor-not-allowed opacity-50')}>
                    <input type="checkbox" className="mt-0.5 accent-primary" disabled={off} checked={!off && picked.includes(t.name)} onChange={() => toggle(t.name)} />
                    <span className="min-w-0"><span className="block text-[13px] font-semibold">{t.label}</span><span className="block text-[11.5px] text-muted-foreground">{t.sub}</span></span>
                  </label>
                );
              })}
            </div>
          </div>
          {/* connected apps (D, 2026-10-09, "Use my connected apps"): from Settings › Connectors */}
          <div className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2.5">
            <span><span className="block text-[13px] font-semibold">Connected apps</span><span className="block text-[11.5px] text-muted-foreground">{apps.length ? 'Apps this agent may use. Reading runs at once; sending or changing anything asks you first.' : 'No apps connected yet. Connect Slack, Gmail and more in Settings › Connectors.'}</span></span>
            {apps.length > 0 && <div className="flex flex-wrap gap-1.5">
              {apps.map((a) => { const on = (d.apps ?? []).includes(a); return (
                <button key={a} type="button" disabled={d.can_edit === false} onClick={() => set({ apps: on ? (d.apps ?? []).filter((x) => x !== a) : [...(d.apps ?? []), a] })}
                  className={cn('rounded-full border px-2.5 py-1 text-[12.5px]', on ? 'border-primary bg-primary/10 font-semibold' : 'border-border text-muted-foreground')}>{a}</button>
              ); })}
            </div>}
          </div>
          {/* who can use it (D, 2026-10-09): team agents are set up by the owner; anyone with AI access can keep private ones */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
            <span><span className="block text-[13px] font-semibold">Who can use it</span><span className="block text-[11.5px] text-muted-foreground">{canShare ? 'Team: everyone with AI access, same settings for all. Private: only you.' : 'Only the owner makes team agents; yours are private.'}</span></span>
            <span className="flex h-8 rounded-lg border border-border bg-inset p-0.5">
              {([['private', 'Private'], ['team', 'Team']] as const).map(([k, l]) => {
                const on = (k === 'team') === (d.shared !== false);
                return <button key={k} type="button" disabled={(k === 'team' && !canShare) || d.is_default || d.can_edit === false} onClick={() => set({ shared: k === 'team' })}
                  className={cn('rounded-md px-2.5 text-[12.5px] font-semibold disabled:opacity-50', on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}>{l}</button>;
              })}
            </span>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2.5">
            <span><span className="block text-[13px] font-semibold">Memory</span><span className="block text-[11.5px] text-muted-foreground">Reads your memory notes and can save new ones ({MEMORY_TOOLS.length} tools)</span></span>
            <Switch checked={d.use_memory} onCheckedChange={(v) => set({ use_memory: v })} aria-label="Memory" />
          </label>
          <div className={FIELD}>
            <label className={LABEL} htmlFor="ag-start">Starters (one per line, shown on a new conversation)</label>
            <Textarea id="ag-start" value={starters} onChange={(e) => setStarters(e.target.value)} rows={4} className="text-[13px]" placeholder="Which payments need a check this month?" />
          </div>
          {err && <div className="rounded-lg bg-weak-bg px-3 py-2 text-[12.5px] text-weak">{err}</div>}
        </div>
        <DialogFooter className="flex-row justify-end gap-2 border-t border-border px-6 py-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !d.name.trim()} onClick={() => void save()}>{d.id ? 'Save' : 'Add agent'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
