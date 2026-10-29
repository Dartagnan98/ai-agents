'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KpiGrid, KpiTile, PageHeader, Section } from '@/components/shared/page-kit';
import { AI_PAGE } from './agents-page';
import { AgentMark } from './agent-mark';
import Link from 'next/link';

// AI › Memory (D, 2026-10-09, MemoryPanel): your notes, the ones the AI saved with remember plus ones you add. Every agent
// with memory on reads them at the start of each turn. Edit in place, delete one, or delete all.
interface Note { id: number; content: string; created_at: string; stale?: number; day?: string }
interface AgentMem { id: number; name: string; icon: string; color: string; notes: Note[]; logs: Note[]; core: string }
interface Change { id: number; at: string; layer: string; action: string; before: string; after: string; by: string; agent: string | null; thread_id: number | null; undone_at: string | null }
interface TeamItem { id: number; kind: string; content: string; who: string; day: string; status: string; valid_to?: string; evidence?: string; confidence?: number | null }
interface TeamStats { kinds: { kind: string; pieces: number; embedded: number }[]; lastIngest: number }
interface Hit { id: number; kind: string; title: string; body: string; at: string }
interface Commitment { id: number; who: string; what: string; due: string; day: string; status: string }
interface EdgeRow { id: number; from: string; rel: string; to: string; day: string; seen: number }
interface EntityRow { id: number; kind: string; name: string; pieces: number; profile: string | null; profiled: string | null; edges: EdgeRow[] }
const KIND: Record<string, string> = { team: 'Team', chat: 'AI chat', slack: 'Slack', call: 'Call review', kb: 'Knowledge', commitment: 'Commitment', summary: 'Chat summary' };
const CHANGE: Record<string, string> = { agent_note: 'Notebook', note: 'Your note', core: 'Always remember', insight: 'Insight' };
const KIND_PLURAL: Record<string, string> = { summary: 'chat summaries', team: 'team items', chat: 'AI chat pieces', slack: 'Slack pieces', call: 'call review pieces', kb: 'Knowledge pieces', commitment: 'open commitments' };
const Tag = ({ children }: { children: React.ReactNode }) => <span className="mr-2 rounded-full bg-muted px-1.5 py-px text-[11px] font-semibold text-muted-foreground">{children}</span>;
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const StaleTag = () => <span className="ml-2 rounded-full bg-watch-bg px-1.5 py-px text-[11px] font-semibold text-watch" title="The nightly memory pass thinks this is no longer true. Agents stop reading it until you keep it.">Stale?</span>;

const TABS = [['team', 'Team memory'], ['people', 'People and contracts'], ['notes', 'Your notes'], ['logs', 'Agent notebooks'], ['changes', 'Recent changes']] as const;
type Tab = (typeof TABS)[number][0];

export function MemoryPage() {
  const [tab, setTab] = useState<Tab>('team');
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [err, setErr] = useState('');
  const [agents, setAgents] = useState<AgentMem[]>([]);
  const [lastRun, setLastRun] = useState<{ day: string; summary: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [team, setTeam] = useState<TeamItem[]>([]);
  const [stats, setStats] = useState<TeamStats | null>(null);
  const [teamDraft, setTeamDraft] = useState('');
  const [teamEdit, setTeamEdit] = useState<{ id: number; text: string } | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [entities, setEntities] = useState<EntityRow[]>([]);
  const [log, setLog] = useState<Change[]>([]);
  const [coreEdit, setCoreEdit] = useState<{ id: number; text: string } | null>(null);
  const load = useCallback(() => { fetch('/api/ai/memory').then((r) => r.json()).then((j) => { setNotes(j.notes ?? []); setAgents(j.agents ?? []); setLastRun(j.lastRun ?? null); setTeam(j.team ?? []); setStats(j.teamStats ?? null); setCommitments(j.commitments ?? []); setEntities(j.entities ?? []); setLog(j.log ?? []); }).catch(() => setNotes([])); }, []);
  const runNow = async () => { setRunning(true); await call('/api/ai/memory?nightly=1', 'POST'); setRunning(false); };
  useEffect(() => { load(); }, [load]);
  const call = async (url: string, method: string, body?: unknown) => {
    setErr('');
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).catch(() => null);
    if (!r?.ok) { setErr((await r?.json().catch(() => ({})))?.error ?? 'Could not save.'); return false; }
    load(); return true;
  };
  const add = async () => { if (draft.trim() && await call('/api/ai/memory', 'POST', { content: draft })) setDraft(''); };
  const saveEdit = async () => { if (editing && await call(`/api/ai/memory?id=${editing.id}`, 'PATCH', { content: editing.text })) setEditing(null); };
  const addTeam = async (kind: 'decision' | 'fact') => { if (teamDraft.trim() && await call('/api/ai/memory', 'POST', { content: teamDraft, team: kind })) setTeamDraft(''); };
  const saveTeam = async () => { if (teamEdit && await call(`/api/ai/memory?teamItem=${teamEdit.id}`, 'PATCH', { content: teamEdit.text })) setTeamEdit(null); };
  const search = async () => { if (q.trim().length < 2) { setHits(null); return; } setHits([]); const j = await fetch(`/api/ai/memory?q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => ({ hits: [] })); setHits(j.hits ?? []); };
  const clear = async () => { if (confirm('Delete every memory note? The AI forgets all of them.')) await call('/api/ai/memory?all=1', 'DELETE'); };
  return (
    <div className="h-full overflow-y-auto">
      <div className={AI_PAGE}>
        <PageHeader title="Memory" purpose="What the AI remembers: the team's shared memory, your own notes, and each agent's notebook." />
        {/* the canvas (D, 2026-10-28): four numbers, then one part at a time (it was one 60,000 px page) */}
        <KpiGrid cols={4}>
          <KpiTile label="Pieces remembered" value={(stats?.kinds ?? []).reduce((x, k) => x + k.pieces, 0).toLocaleString('en-US')} sub="Slack, chats, calls, docs" />
          <KpiTile label="Team decisions" value={team.filter((t) => t.kind === 'decision' && t.status !== 'retired').length.toLocaleString('en-US')} sub="rules the agents follow" />
          <KpiTile label="Open commitments" value={commitments.filter((c) => c.status !== 'done').length.toLocaleString('en-US')} sub="from owner and admin chats" />
          <KpiTile label="People and contracts" value={entities.length.toLocaleString('en-US')} sub={`${entities.filter((e) => e.profile).length} with a profile`} />
        </KpiGrid>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Memory parts">
          {TABS.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={tab === k ? 'rounded-full bg-primary px-4 py-1.5 text-[13px] font-semibold text-primary-foreground' : 'glass-pill rounded-full px-4 py-1.5 text-[13px] font-semibold text-muted-foreground hover:text-foreground'}>{label}</button>
          ))}
        </div>
        {tab === 'team' && <>
        {/* team memory (D, 2026-10-23): decisions and facts shared by the owner and admins, plus everything ingested; recalled in every conversation */}
        <Section flush>
          <div className="px-6 md:px-7">
            <span className="block text-[15px] font-semibold">Team memory</span>
            <span className="block text-[12px] text-muted-foreground">Decisions and lasting facts, shared by the owner and admins, with who and when. Every agent reads the ones that matter in each conversation, along with past AI chats, Slack, call reviews and Knowledge. The nightly pass adds new decisions from your conversations.</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 px-6 md:px-7">
            <Input value={teamDraft} maxLength={600} placeholder="Refunds count in the month they happen" aria-label="New team decision or fact" onChange={(e) => setTeamDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addTeam('decision'); }} className="h-9 min-w-0 flex-1 text-[13px]" />
            <Button size="sm" disabled={!teamDraft.trim()} onClick={() => void addTeam('decision')}>Add decision</Button>
            <Button size="sm" variant="outline" disabled={!teamDraft.trim()} onClick={() => void addTeam('fact')}>Add fact</Button>
          </div>
          <div className="divide-y divide-border border-y border-border">
            {team.length === 0 && <div className="px-6 py-4 text-[13px] text-muted-foreground md:px-7">No decisions yet. They are added every night from your conversations, or add one above.</div>}
            {team.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-6 py-2.5 md:px-7">
                {teamEdit?.id === t.id ? <>
                  <Input autoFocus value={teamEdit.text} maxLength={600} onChange={(e) => setTeamEdit({ id: t.id, text: e.target.value })} aria-label="Edit team item"
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveTeam(); if (e.key === 'Escape') setTeamEdit(null); }} className="h-8 min-w-0 flex-1 text-[13px]" />
                  <Button size="sm" onClick={() => void saveTeam()}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setTeamEdit(null)}>Cancel</Button>
                </> : <>
                  <span className={`min-w-0 flex-1 ${t.status === 'stale' ? 'opacity-60' : ''}`}>
                    <span className="block text-[13px]"><Tag>{t.kind === 'fact' ? 'Fact' : t.kind === 'insight' ? 'Insight' : 'Decision'}</Tag>{t.content}</span>
                    <span className="block text-[11.5px] text-label">{[t.who, t.day, t.kind === 'insight' && t.confidence != null ? `${Math.round(t.confidence * 100)}% sure` : '', t.status === 'stale' && t.valid_to ? `true until ${t.valid_to}` : ''].filter(Boolean).join(', ')}{t.status === 'stale' && <StaleTag />}</span>
                    {t.kind === 'insight' && (JSON.parse(t.evidence || '[]') as string[]).length > 0 && <span className="block text-[11.5px] text-label">From: {(JSON.parse(t.evidence || '[]') as string[]).join('; ')}</span>}
                  </span>
                  {t.status === 'stale'
                    ? <Button size="sm" variant="ghost" onClick={() => void call(`/api/ai/memory?teamItem=${t.id}`, 'PATCH', { keep: true })}>Keep</Button>
                    : <Button size="sm" variant="ghost" onClick={() => void call(`/api/ai/memory?teamItem=${t.id}`, 'PATCH', { retire: true })} title="No longer true: agents stop reading it">Retire</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setTeamEdit({ id: t.id, text: t.content })}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-weak" onClick={() => void call(`/api/ai/memory?teamItem=${t.id}`, 'DELETE')} aria-label={`Delete team item: ${t.content}`}>Delete</Button>
                </>}
              </div>
            ))}
          </div>
          {commitments.length > 0 && <>
            <div className="px-6 text-[12px] font-semibold text-muted-foreground md:px-7">Commitments</div>
            <div className="divide-y divide-border border-y border-border">
              {commitments.map((c) => (
                <div key={c.id} className={`flex items-center gap-3 px-6 py-2.5 md:px-7 ${c.status === 'done' ? 'opacity-60' : ''}`}>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] ${c.status === 'done' ? 'line-through' : ''}`}>{c.what}</span>
                    <span className="block text-[11.5px] text-label">{[c.who, c.due ? `due ${c.due}` : '', c.day ? `said ${c.day}` : ''].filter(Boolean).join(', ')}</span>
                  </span>
                  {c.status === 'done'
                    ? <Button size="sm" variant="ghost" onClick={() => void call(`/api/ai/memory?commitment=${c.id}`, 'PATCH', { done: false })}>Reopen</Button>
                    : <Button size="sm" variant="ghost" onClick={() => void call(`/api/ai/memory?commitment=${c.id}`, 'PATCH', { done: true })}>Done</Button>}
                  <Button size="sm" variant="ghost" className="text-weak" onClick={() => void call(`/api/ai/memory?commitment=${c.id}`, 'DELETE')} aria-label={`Delete commitment: ${c.what}`}>Delete</Button>
                </div>
              ))}
            </div>
          </>}
          <div className="flex flex-wrap items-center gap-2 px-6 md:px-7">
            <Input value={q} maxLength={500} placeholder="Search team memory: what did we decide about refunds?" aria-label="Search team memory" onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} className="h-9 min-w-0 flex-1 text-[13px]" />
            <Button size="sm" variant="outline" disabled={q.trim().length < 2} onClick={() => void search()}>Search</Button>
          </div>
          {hits !== null && (
            <div className="divide-y divide-border border-y border-border">
              {hits.length === 0 && <div className="px-6 py-3 text-[13px] text-muted-foreground md:px-7">{q.trim() ? 'Nothing found yet.' : ''}</div>}
              {hits.map((h) => (
                <details key={h.id} className="group px-6 py-2.5 md:px-7">
                  <summary className="flex cursor-pointer list-none items-start gap-2 text-[13px]"><Tag>{KIND[h.kind] ?? h.kind}</Tag><span className="min-w-0 flex-1"><span className="block font-semibold">{h.title}</span>
                    <span className="block truncate text-muted-foreground">{h.body.replace(/\s+/g, ' ').slice(0, 160)}</span></span></summary>
                  <div className="mt-2 whitespace-pre-wrap text-[13px] leading-[20px] text-foreground/90">{h.body}</div>
                </details>
              ))}
            </div>
          )}
          {stats && (
            <div className="px-6 text-[12px] text-muted-foreground md:px-7">
              In memory: {stats.kinds.map((k) => `${k.pieces.toLocaleString()} ${KIND_PLURAL[k.kind] ?? k.kind}`).join(', ') || 'nothing yet'}.
              {' '}Ingested every 30 minutes{stats.lastIngest ? `, last at ${new Date(stats.lastIngest).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}.
            </div>
          )}
        </Section>
        </>}
        {tab === 'people' && <>
        {/* people and contracts (team memory's graph): what memory links to each, and each rep's profile, rebuilt nightly */}
        {entities.length > 0 && (
          <Section flush>
            <div className="px-6 md:px-7">
              <span className="block text-[15px] font-semibold">People and contracts</span>
              <span className="block text-[12px] text-muted-foreground">Who and what team memory knows about, by name, and how they relate (drawn every night from the pieces). When a question names one, the AI also reads what is linked to it, its relationships, and a rep&rsquo;s profile.</span>
            </div>
            <div className="px-6 md:px-7"><Link href="/ai/graph" className="text-[13px] font-semibold underline-offset-2 hover:underline">Open the graph: zoom, search and every connection</Link></div>
            <div className="divide-y divide-border border-y border-border">
              {entities.map((e) => (
                <details key={e.id} className="group px-6 py-2.5 md:px-7">
                  <summary className={`flex list-none items-center gap-2 text-[13px] ${e.profile || e.edges.length ? 'cursor-pointer' : ''}`}>
                    <Tag>{e.kind === 'person' ? 'Person' : 'Agent'}</Tag><span className="min-w-0 flex-1 font-semibold">{e.name}</span>
                    <span className="text-[12px] text-muted-foreground">{e.pieces.toLocaleString()} {e.pieces === 1 ? 'piece' : 'pieces'}{e.edges.length ? ` · ${e.edges.length} ${e.edges.length === 1 ? 'relationship' : 'relationships'}` : ''}{e.profile ? ' · profile' : ''}</span>
                  </summary>
                  {e.profile && <div className="mt-2 text-[13px] leading-[20px] text-foreground/90">{e.profile}<span className="mt-1 block text-[11.5px] text-label">Profile from {e.profiled ? day(e.profiled) : ''}</span></div>}
                  {e.edges.length > 0 && (
                    <div className="mt-2 divide-y divide-border border-t border-border">
                      {e.edges.map((x) => (
                        <div key={x.id} className="flex items-center gap-3 py-1.5 text-[13px]">
                          <span className="min-w-0 flex-1">{x.from} <span className="text-muted-foreground">{x.rel}</span> {x.to}
                            <span className="ml-2 text-[11.5px] text-label">{[x.day, x.seen > 1 ? `seen ${x.seen} times` : ''].filter(Boolean).join(', ')}</span></span>
                          <Button size="sm" variant="ghost" className="text-weak" onClick={() => void call(`/api/ai/memory?edge=${x.id}`, 'DELETE')} aria-label={`Delete relationship: ${x.from} ${x.rel} ${x.to}`}>Delete</Button>
                        </div>
                      ))}
                    </div>
                  )}
                </details>
              ))}
            </div>
          </Section>
        )}
        </>}
        {tab === 'notes' && <>
        <Section flush>
          <div className="px-6 md:px-7">
            <span className="block text-[15px] font-semibold">Your notes</span>
            <span className="block text-[12px] text-muted-foreground">Lasting facts and preferences the AI keeps for you. Only you see your notes.</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 px-6 md:px-7">
            <Input value={draft} maxLength={1000} placeholder="I want commission numbers in USD with cents" aria-label="New memory note" onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} className="h-9 min-w-0 flex-1 text-[13px]" />
            <Button size="sm" disabled={!draft.trim()} onClick={() => void add()}>Add</Button>
          </div>
          <div className="divide-y divide-border border-y border-border">
            {notes === null && <div className="px-6 py-4 text-[13px] text-muted-foreground md:px-7">Loading...</div>}
            {notes?.length === 0 && <div className="px-6 py-4 text-[13px] text-muted-foreground md:px-7">Nothing saved yet. Tell the AI something like &ldquo;remember that I prefer short replies&rdquo;.</div>}
            {notes?.map((n) => (
              <div key={n.id} className="flex items-center gap-3 px-6 py-2.5 md:px-7">
                {editing?.id === n.id ? <>
                  <Input autoFocus value={editing.text} maxLength={1000} onChange={(e) => setEditing({ id: n.id, text: e.target.value })} aria-label="Edit note"
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(); if (e.key === 'Escape') setEditing(null); }} className="h-8 min-w-0 flex-1 text-[13px]" />
                  <Button size="sm" onClick={() => void saveEdit()}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                </> : <>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px]">{n.content}</span>
                    <span className="block text-[11.5px] text-label">Saved {day(n.created_at)}{!!n.stale && <StaleTag />}</span>
                  </span>
                  {!!n.stale && <Button size="sm" variant="ghost" onClick={() => void call(`/api/ai/memory?id=${n.id}`, 'PATCH', { keep: true })}>Keep</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ id: n.id, text: n.content })}>Edit</Button>
                  <Button size="sm" variant="ghost" className="text-weak" onClick={() => void call(`/api/ai/memory?id=${n.id}`, 'DELETE')} aria-label={`Delete note: ${n.content}`}>Delete</Button>
                </>}
              </div>
            ))}
          </div>
          {err && <div className="mx-6 rounded-lg bg-weak-bg px-3 py-2 text-[12.5px] text-weak md:mx-7">{err}</div>}
          {!!notes?.length && <div className="px-6 md:px-7"><Button size="sm" variant="outline" className="text-weak" onClick={() => void clear()}>Delete all memory</Button></div>}
        </Section>
        </>}
        {tab === 'logs' && <>
        {/* agent notebooks and daily logs (D, 2026-10-12): what each agent learned, shared by everyone who uses it */}
        {agents.map((a) => (
          <Section key={a.id} flush>
            <div className="flex items-center gap-2.5 px-6 md:px-7">
              <AgentMark icon={a.icon} color={a.color} size={22} />
              <span className="min-w-0 flex-1"><span className="block text-[15px] font-semibold">{a.name}&rsquo;s notebook</span>
                <span className="block text-[12px] text-muted-foreground">What {a.name} learned about the agency. Everyone who uses {a.name} shares it; it writes here itself and every night.</span></span>
            </div>
            {/* "Always remember" (D, 2026-10-23): the agent's short core profile, read in every conversation; it edits it itself too */}
            <div className="px-6 md:px-7">
              <div className="mb-1 text-[12px] font-semibold text-muted-foreground">Always remember</div>
              {coreEdit?.id === a.id ? (
                <div className="flex flex-col gap-2">
                  <textarea autoFocus value={coreEdit.text} maxLength={1500} rows={5} onChange={(e) => setCoreEdit({ id: a.id, text: e.target.value })} aria-label={`What ${a.name} always remembers`}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-[13px] leading-[20px] outline-none focus:border-foreground/40" />
                  <div className="flex gap-2"><Button size="sm" onClick={() => void call(`/api/ai/memory?core=${a.id}`, 'POST', { body: coreEdit.text }).then((ok) => { if (ok) setCoreEdit(null); })}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setCoreEdit(null)}>Cancel</Button><span className="ml-auto self-center text-[11.5px] text-label">{coreEdit.text.length}/1500</span></div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <span className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-[20px]">{a.core || <span className="text-muted-foreground">Nothing yet. The few things {a.name} should know in every conversation.</span>}</span>
                  <Button size="sm" variant="ghost" onClick={() => setCoreEdit({ id: a.id, text: a.core })}>Edit</Button>
                </div>
              )}
            </div>
            <div className="divide-y divide-border border-y border-border">
              {a.notes.length === 0 && <div className="px-6 py-3 text-[13px] text-muted-foreground md:px-7">Nothing yet.</div>}
              {a.notes.map((n) => (
                <div key={n.id} className="flex items-center gap-3 px-6 py-2.5 md:px-7">
                  <span className="min-w-0 flex-1"><span className="block text-[13px]">{n.content}</span>
                    <span className="block text-[11.5px] text-label">Saved {day(n.created_at)}{!!n.stale && <StaleTag />}</span></span>
                  {!!n.stale && <Button size="sm" variant="ghost" onClick={() => void call(`/api/ai/memory?agentNote=${n.id}`, 'PATCH', { keep: true, agent: a.id })}>Keep</Button>}
                  <Button size="sm" variant="ghost" className="text-weak" onClick={() => void call(`/api/ai/memory?agentNote=${n.id}`, 'DELETE')} aria-label={`Delete note: ${n.content}`}>Delete</Button>
                </div>
              ))}
            </div>
            {a.logs.length > 0 && (
              <div className="px-6 md:px-7">
                <div className="mb-1.5 text-[12px] font-semibold text-muted-foreground">Daily logs</div>
                {a.logs.map((l) => (
                  <details key={l.id} className="group border-b border-border py-2 last:border-0">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-semibold">{l.day}<span className="truncate font-normal text-muted-foreground">{l.content.split('\n')[0].slice(0, 90)}</span></summary>
                    <div className="mt-2 whitespace-pre-wrap text-[13px] leading-[20px] text-foreground/90">{l.content}</div>
                  </details>
                ))}
              </div>
            )}
          </Section>
        ))}
        </>}
        {tab === 'changes' && <>
        {/* what the AI changed in memory on its own (D, 2026-10-23): after each answer, nightly insights, its core profile; each can be undone */}
        {log.length > 0 && (
          <Section flush>
            <div className="px-6 md:px-7">
              <span className="block text-[15px] font-semibold">Recent changes</span>
              <span className="block text-[12px] text-muted-foreground">What the AI changed in memory by itself: notes it added, fixed or retired after an answer, insights from the nightly pass, and edits to what an agent always remembers. Undo puts back what was there.</span>
            </div>
            <div className="divide-y divide-border border-y border-border">
              {log.slice(0, 40).map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-6 py-2.5 md:px-7">
                  <span className={`min-w-0 flex-1 ${c.undone_at ? 'opacity-50' : ''}`}>
                    <span className="block text-[13px]"><Tag>{CHANGE[c.layer] ?? c.layer}</Tag>{c.action === 'add' ? 'Added' : c.action === 'retire' ? 'Retired' : 'Changed'}: {(c.after || c.before).split('\n').slice(-1)[0].slice(0, 220)}</span>
                    <span className="block text-[11.5px] text-label">{[c.agent, c.by === 'learn' ? 'after an answer' : c.by === 'nightly' ? 'nightly pass' : c.by === 'agent' ? 'by the agent' : 'by a person', day(c.at), c.undone_at ? 'undone' : ''].filter(Boolean).join(', ')}{c.thread_id ? <> · <Link href={`/ai?thread=${c.thread_id}`} className="hover:underline">conversation</Link></> : null}</span>
                  </span>
                  {!c.undone_at && <Button size="sm" variant="ghost" onClick={() => void call(`/api/ai/memory?undo=${c.id}`, 'POST')}>Undo</Button>}
                </div>
              ))}
            </div>
          </Section>
        )}
        </>}
        <div className="flex flex-wrap items-center gap-3 px-6 pb-8 text-[12.5px] text-muted-foreground md:px-7">
          <span className="min-w-0 flex-1">Every night after 3 AM each agent reads the day&rsquo;s conversations and routine runs, writes its daily log, adds what it learned and flags notes that went stale.{lastRun ? ` Last run: ${lastRun.day}, ${lastRun.summary}.` : ' Not run yet.'}</span>
          <Button size="sm" variant="outline" disabled={running} onClick={() => void runNow()}>{running ? 'Running...' : 'Run for yesterday now'}</Button>
        </div>
      </div>
    </div>
  );
}
