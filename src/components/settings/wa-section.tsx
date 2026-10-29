'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Pill, Section } from '@/components/shared/page-kit';
import { addWa, editWa, loadWa, removeWa, type WaView } from '@/lib/actions/wa';

// Settings › AI connections › WhatsApp (D, 2026-10-28: "the WhatsApp connectors the way I have them for another install, like Slack and
// Telegram, all in one place"): a WhatsApp number per agent, linked to this server as a device (like WhatsApp
// Web) by scanning a QR. Only the admin numbers can talk to the agent: direct messages, and in the listed groups when the number is
// @-mentioned (or every message in an "ambient" group). It answers as the login that added the number, with that login's access.
const LABEL = 'text-[12px] font-semibold text-muted-foreground';
type Num = WaView['numbers'][number];
const adminsText = (a: Record<string, string>) => Object.entries(a).map(([n, w]) => `${n} ${w}`).join('\n');

export function WaSection() {
  const [view, setView] = useState<WaView | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const reload = async () => { const r = await loadWa().catch((e: unknown) => ({ success: false as const, error: String(e) })); if (r.success) setView(r.view); else setError(r.error); };
  useEffect(() => { void reload(); const t = window.setInterval(() => void reload(), 4000); return () => window.clearInterval(t); }, []);
  if (!view && error.startsWith('Only an owner or admin')) return null; // everyone else never sees the section
  if (!view) return error ? <p className="rounded-xl bg-weak-bg px-4 py-3 text-[13px] text-weak">{error}</p> : <div className="h-40 animate-pulse rounded-[22px] bg-card shadow-[var(--card-shadow)]" />;
  return (
    <div className="flex flex-col gap-6">
      <Section title="WhatsApp" flush description="Talk to your agents on WhatsApp. Each number answers as one agent, linked like WhatsApp Web (the phone keeps working as normal). Only its admin numbers can talk to it."
        actions={!adding && <Button size="sm" onClick={() => setAdding(true)}>Add a number</Button>}>
        <div className="flex flex-col divide-y divide-border border-t border-border">
          {view.numbers.length === 0 && !adding && <p className="px-6 py-3 text-[13px] text-label md:px-7">No numbers yet.</p>}
          {view.numbers.map((n) => <NumberRow key={n.key} n={n} agents={view.agents} reload={reload} />)}
        </div>
      </Section>
      {adding && <NumberForm agents={view.agents} onDone={() => { setAdding(false); void reload(); }} />}
    </div>
  );
}

function NumberRow({ n, agents, reload }: { n: Num; agents: WaView['agents']; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const toggle = async () => { await editWa(n.key, { mode: n.mode === 'live' ? 'off' : 'live' }); await reload(); };
  const remove = async () => { if (window.confirm(`Remove ${n.label}? It is unlinked from this server and its messages here are deleted (the phone keeps everything).`)) { await removeWa(n.key); await reload(); } };
  return (
    <div className="flex flex-col gap-3 px-6 py-4 md:px-7">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-[13.5px] font-medium">{n.label}</span>
          <span className="truncate text-[11.5px] text-label">Answers as {n.agent} · {Object.keys(n.admins).length} admin{Object.keys(n.admins).length === 1 ? '' : 's'} · {n.groups.length} group{n.groups.length === 1 ? '' : 's'}</span></span>
        {n.connected ? <Pill tone="healthy" dot>Linked</Pill> : n.qrSvg ? <Pill tone="info" dot>Scan the QR</Pill> : n.running ? <Pill tone="neutral" dot>Starting</Pill> : <Pill tone="weak" dot>Not running</Pill>}
        {n.mode === 'off' && <Pill tone="neutral">Paused</Pill>}
        <Button size="sm" variant="ghost" onClick={() => void toggle()}>{n.mode === 'live' ? 'Pause' : 'Resume'}</Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>{editing ? 'Close' : 'Edit'}</Button>
        <Button size="sm" variant="ghost" className="text-weak" onClick={() => void remove()}>Remove</Button>
      </div>
      {!n.connected && n.qrSvg && (
        <div className="flex flex-wrap items-center gap-5 rounded-xl border border-border p-4">
          <div className="rounded-lg bg-white p-2" dangerouslySetInnerHTML={{ __html: n.qrSvg }} />
          <ol className="flex max-w-[360px] list-decimal flex-col gap-1 pl-4 text-[13px]">
            <li>On the phone with this number, open WhatsApp.</li>
            <li>Settings › Linked devices › Link a device.</li>
            <li>Scan this code. It refreshes every few seconds; keep this page open.</li>
          </ol>
        </div>
      )}
      {!n.connected && !n.qrSvg && n.log && <pre className="max-h-32 overflow-auto rounded-lg bg-inset p-2 text-[11px] text-label">{n.log}</pre>}
      {editing && <NumberForm agents={agents} existing={n} onDone={() => { setEditing(false); void reload(); }} />}
    </div>
  );
}

function NumberForm({ agents, existing, onDone }: { agents: WaView['agents']; existing?: Num; onDone: () => void }) {
  const [label, setLabel] = useState(existing?.label ?? '');
  const [agentId, setAgentId] = useState<number>(existing?.agent_id ?? agents[0]?.id ?? 0);
  const [admins, setAdmins] = useState(existing ? adminsText(existing.admins) : '');
  const [groups, setGroups] = useState(existing?.groups.join('\n') ?? '');
  const [ambient, setAmbient] = useState(existing?.ambient.join('\n') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    const f = { label, agentId, admins, groups, ambient };
    const r = existing ? await editWa(existing.key, f) : await addWa(f);
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    onDone();
  }
  const body = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1"><span className={LABEL}>Name</span><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="the AI line" className="w-[260px]" /></label>
        <label className="flex flex-col gap-1"><span className={LABEL}>Answers as</span>
          <select value={agentId} onChange={(e) => setAgentId(Number(e.target.value))} className="h-9 rounded-lg border border-border bg-card px-2.5 text-[13px]">
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label>
      </div>
      <label className="flex flex-col gap-1"><span className={LABEL}>Admins: one per line, number with country code then who it is. Only these numbers can talk to the agent.</span>
        <Textarea value={admins} onChange={(e) => setAdmins(e.target.value)} rows={3} placeholder={'17785551234 Sam, the owner\n16045550000 Alex Kim, sales manager'} className="font-mono text-[12px]" /></label>
      <label className="flex flex-col gap-1"><span className={LABEL}>Groups it can answer in (group JIDs ending in @g.us, one per line; it answers when @-mentioned)</span>
        <Textarea value={groups} onChange={(e) => setGroups(e.target.value)} rows={2} placeholder="120363000000000000@g.us" className="font-mono text-[12px]" /></label>
      <label className="flex flex-col gap-1"><span className={LABEL}>Of those, groups it reads in full (answers without being mentioned)</span>
        <Textarea value={ambient} onChange={(e) => setAmbient(e.target.value)} rows={2} className="font-mono text-[12px]" /></label>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy || label.trim().length < 2 || !admins.trim() || !agentId} onClick={() => void save()}>{busy ? 'Saving' : existing ? 'Save' : 'Add and show the QR'}</Button>
        {!existing && <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>}
        {error && <span role="status" className="text-[12.5px] font-semibold text-weak">{error}</span>}
      </div>
      <p className="text-[12px] text-label">Group JIDs end in @g.us: add the number to the group, then copy the id from the group's invite settings or ask the agent once it is linked. The agent answers as you, with your access.</p>
    </div>
  );
  return existing ? body : <Section title="Add a WhatsApp number" flush><div className="border-t border-border px-6 py-4 md:px-7">{body}</div></Section>;
}
