'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { IconArrowUp, IconChevronLeft, IconHistory, IconPlus, IconPlayerStopFilled, IconTrash, IconChevronDown, IconCheck, IconX, IconCornerDownRight, IconPaperclip, IconFileText } from '@tabler/icons-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AUTO_MODEL, CONTEXT_WINDOW, findModel } from '@/lib/ai/models';
import { useAreas } from '@/hooks/use-areas';
import { useSubTabs } from '@/hooks/use-subtabs';
import { locate } from '@/lib/nav';
import { cn } from '@/lib/utils';
import { RichText, CopyButton } from './rich-text';
import { RunSteps, Working, type Step } from './run-steps';
import { plainText } from './blocks';
import { AgentMark, AgentGlyph } from './agent-mark';
import { AgentPicker } from './agent-picker';
import { notifyThreads, relTime, useAiAgents, useAiSkills, useAiThreads, type UiAgent } from './use-ai';

// One conversation view for every place the agents shows (D, 2026-10-09): the corner chat, the docked split pane and the full AI page
// (/ai) all use this, so there is one implementation of streaming, steps, rich replies, the agent picker, the "/" skills menu and the
// empty state ("What should we work on?" + the agent's starters, AgentsView). Back end: app/api/ai/chat.
type ChatFile = { id: string; name: string; type: string; size: number; kind: 'image' | 'pdf' | 'text' | 'office' };
/** What a file chip calls a file. */
const fileLabel = (kind: ChatFile['kind'] | null, name: string) => (kind === 'pdf' ? 'PDF' : kind === 'image' ? 'Picture'
  : /\.xls[xm]$/i.test(name) ? 'Excel' : /\.docx$/i.test(name) ? 'Word' : /\.pptx$/i.test(name) ? 'PowerPoint' : 'Text file');
type Msg = { role: 'user' | 'assistant'; text: string; steps: Step[]; at?: string; files?: ChatFile[] };
/** A file in the composer: uploading (no id yet), ready, or refused; `preview` = a local picture while it uploads. */
type Pending = { key: string; name: string; kind: ChatFile['kind'] | null; preview?: string; file?: ChatFile; error?: string };
const fileUrl = (id: string) => `/api/ai/attachments/${id}`;
const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,.xlsx,.xlsm,.docx,.pptx,.txt,.csv,.tsv,.md,.json,.log';
export type ConversationVariant = 'corner' | 'docked' | 'page';

/** "1:56 PM" today, "Oct 8, 1:56 PM" before (reply time). */
function clock(at?: string) {
  if (!at) return '';
  const d = new Date(at); if (Number.isNaN(d.getTime())) return '';
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${t}`;
}

/** Split view's open pages as chip labels: "Money (/b/acme/money) [in focus]" -> { label: "Money", focus: true }. */
function openPageChips(pages?: string[]) {
  return (pages ?? []).map((p) => ({ label: p.replace(/\s*\[in focus\]\s*$/, '').replace(/\s*\([^()]*\)\s*$/, '').trim(), focus: /\[in focus\]\s*$/.test(p) }));
}

const CopyIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.3" /><path d="M10.5 3.5v-.3A1.2 1.2 0 009.3 2H3.2A1.2 1.2 0 002 3.2v6.1a1.2 1.2 0 001.2 1.2h.3" stroke="currentColor" strokeWidth="1.3" /></svg>;
const CheckIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export function Conversation({ variant, thread: wanted = null, onThread, agent: wantedAgent = null, toolbar, title }: {
  variant: ConversationVariant;
  /** The conversation to show (null = a new one). The view follows it when it changes. */
  thread?: number | null;
  /** Called when the view moves to another conversation (a new one gets its id on the first reply). */
  onThread?: (id: number | null) => void;
  /** Agent to start a new conversation with (else the default agent). */
  agent?: number | null;
  /** Buttons at the right of the header. */
  toolbar?: ReactNode;
  /** Header middle (the page shows the conversation's title and its menu). */
  title?: (current: { id: number | null; title: string; renamed: (t: string) => void }) => ReactNode;
}) {
  const data = useAiAgents();
  const agents = useMemo(() => data?.agents ?? [], [data]);
  const skills = useAiSkills();
  const [thread, setThread] = useState<number | null>(null);
  const [threadTitle, setThreadTitle] = useState('');
  const [agentId, setAgentId] = useState<number | null>(wantedAgent);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  // files and pictures for the next message (D, 2026-10-23): paperclip, paste or drop anywhere on the chat
  const [pending, setPending] = useState<Pending[]>([]), [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // composer extras (D, 2026-10-09, CTRL Flow's): the model (Auto or one), messages queued while a reply runs, how full the conversation is
  const [model, setModel] = useState<string>('auto');
  const [queue, setQueue] = useState<string[]>([]);
  const [held, setHeld] = useState(false); // Stop or an error holds the queue until Send now
  const [editQ, setEditQ] = useState<number | null>(null);
  const [ctx, setCtx] = useState<{ used: number; window: number } | null>(null);
  // proposals the agent filed in this conversation, shown as Approve cards (lib/ai/approvals.ts)
  const [approvals, setApprovals] = useState<{ id: number; summary: string; status: string; result: string }[]>([]);
  const loadApprovals = useCallback(async (id: number | null) => {
    if (!id) { setApprovals([]); return; }
    const r = await fetch(`/api/ai/approvals?thread=${id}`).catch(() => null);
    if (r?.ok) setApprovals((await r.json()).approvals ?? []);
  }, []);
  const decideApproval = async (id: number, approve: boolean) => {
    const r = await fetch('/api/ai/approvals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, approve }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setError(j.error ?? 'Could not decide.'); return; }
    setApprovals((x) => x.map((a) => (a.id === id ? j.approval : a)));
    const a = j.approval as { status: string; result: string; summary: string };
    setMsgs((m) => [...m, { role: 'assistant', text: a.status === 'approved' ? `Done: ${a.result}` : a.status === 'failed' ? `Could not make the change: ${a.result}` : `Not changed: ${a.summary}`, steps: [], at: new Date().toISOString() }]);
  };
  const [error, setError] = useState('');
  const [list, setList] = useState(false);
  const [slashAt, setSlashAt] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true), lastTop = useRef(0);
  const current = useRef<number | null>(null);
  const [pages, setPages] = useState<{ label: string; focus: boolean }[]>([]);
  const stop = useRef<AbortController | null>(null);
  const pathname = usePathname();
  const areas = useAreas();
  const { area, tab } = locate(areas, pathname);
  const { report } = useSubTabs();
  const sub = report && report.items.length > 1 ? report.items.find((i) => i.on)?.label : undefined;
  const where = variant === 'page' ? [] : [area.business ? area.name : area.short, tab && tab.label !== area.short ? tab.label : '', sub ?? ''].filter(Boolean);
  const page = variant === 'page';
  const empty = !list && msgs.length === 0;
  // phones: a new conversation on the AI page lists your conversations under the composer (D, 2026-10-12)
  const threads = useAiThreads('', list || (page && empty));
  const agent: UiAgent | undefined = agents.find((a) => a.id === agentId) ?? agents.find((a) => a.is_default) ?? agents[0];

  const moveTo = useCallback((id: number | null) => { current.current = id; setThread(id); onThread?.(id); }, [onThread]);

  // smooth follow while a reply streams; scrolling up stops it, scrolling back to the end starts it again (stick-to-end)
  useEffect(() => { const el = body.current; if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [msgs]);
  const onScroll = () => {
    const el = body.current; if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) stick.current = true;
    else if (el.scrollTop < lastTop.current - 4) stick.current = false;
    lastTop.current = el.scrollTop;
  };
  // in a split, the chips name the open pages (split-view.tsx keeps window.__fleetOpenPages current), not the outer "AI" page
  useEffect(() => {
    if (variant === 'page') return;
    let seen = '';
    const read = () => { const k = (window.__fleetOpenPages ?? []).join('\n'); if (k !== seen) { seen = k; setPages(openPageChips(window.__fleetOpenPages)); } };
    read(); const t = window.setInterval(read, 800);
    return () => window.clearInterval(t);
  }, [variant]);

  // a run still answering when the conversation opens (after a reload, or started on another device): poll it until it ends (D, 2026-10-23)
  const watch = useRef(0);
  const follow = useCallback((id: number) => {
    const my = ++watch.current; setBusy(true);
    const tick = async () => {
      if (watch.current !== my || current.current !== id) return;
      const j = await fetch(`/api/ai/chat?thread=${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { messages: (Msg & { created_at?: string })[]; live: { reply: string; steps: Msg['steps'] } | null } | null;
      if (watch.current !== my || current.current !== id) return;
      if (j?.live) { setMsgs((m) => [...m.slice(0, -1), { role: 'assistant', text: j.live!.reply, steps: j.live!.steps }]); window.setTimeout(tick, 1500); return; }
      if (j) setMsgs(j.messages.map((m) => ({ role: m.role, text: m.text, steps: m.steps, at: m.created_at, files: m.files })));
      setBusy(false); notifyThreads(); void loadApprovals(id);
    };
    window.setTimeout(tick, 1500);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback(async (id: number | null) => {
    stop.current?.abort(); // only this page's connection: the run itself keeps going on the server
    if (watch.current) { watch.current++; setBusy(false); }
    setList(false); setError(''); stick.current = true;
    if (!id) { current.current = null; setThread(null); setMsgs([]); setThreadTitle(''); setAgentId(wantedAgent); setCtx(null); setQueue([]); return; }
    const r = await fetch(`/api/ai/chat?thread=${id}`); if (!r.ok) { setError('That conversation is gone.'); return; }
    const j = await r.json() as { thread: { title: string; agent_id: number | null; context_tokens?: number }; messages: (Msg & { created_at?: string })[]; live?: { reply: string; steps: Msg['steps'] } | null };
    setCtx(j.thread.context_tokens ? { used: j.thread.context_tokens, window: CONTEXT_WINDOW } : null);
    current.current = id; setThread(id); setThreadTitle(j.thread.title); if (j.thread.agent_id) setAgentId(j.thread.agent_id);
    const shown = j.messages.map((m): Msg => ({ role: m.role, text: m.text, steps: m.steps, at: m.created_at, files: m.files }));
    setMsgs(j.live ? [...shown, { role: 'assistant', text: j.live.reply, steps: j.live.steps }] : shown);
    if (j.live) follow(id);
    void loadApprovals(id);
  }, [wantedAgent, follow]);
  // follow the conversation the host asks for (the page's ?thread=), unless it is the one already showing
  useEffect(() => { if (wanted !== current.current) void open(wanted); }, [wanted, open]);
  useEffect(() => { if (!current.current && wantedAgent) setAgentId(wantedAgent); }, [wantedAgent]);

  // upload each file as soon as it is added; the chip shows it until the message goes
  const addFiles = (list: FileList | File[] | null) => {
    const files = [...(list ?? [])].slice(0, 5 - pending.length);
    for (const f of files) {
      const key = `${Date.now()}-${Math.random()}`, kind: Pending['kind'] = /^image\//.test(f.type) ? 'image' : /pdf$/.test(f.type) || /\.pdf$/i.test(f.name) ? 'pdf' : /\.(xls[xm]|docx|pptx)$/i.test(f.name) ? 'office' : 'text';
      setPending((p) => [...p, { key, name: f.name || 'pasted picture', kind, preview: kind === 'image' ? URL.createObjectURL(f) : undefined }]);
      const fd = new FormData(); fd.append('file', f, f.name || 'pasted-picture.png');
      void fetch('/api/ai/attachments', { method: 'POST', body: fd }).then(async (r) => {
        const j = await r.json().catch(() => ({})) as { files?: ChatFile[]; errors?: string[]; error?: string };
        setPending((p) => p.map((x) => (x.key !== key ? x : j.files?.[0] ? { ...x, file: j.files[0], kind: j.files[0].kind } : { ...x, error: j.errors?.[0] ?? j.error ?? 'Could not add this file.' })));
      }).catch(() => setPending((p) => p.map((x) => (x.key === key ? { ...x, error: 'Could not upload this file.' } : x))));
    }
  };
  const dropPending = (key: string) => setPending((p) => { const x = p.find((y) => y.key === key); if (x?.preview) URL.revokeObjectURL(x.preview); return p.filter((y) => y.key !== key); });
  const uploading = pending.some((p) => !p.file && !p.error);
  const ready = pending.filter((p) => p.file).map((p) => p.file!);

  const send = async (t: string) => {
    const files = ready;
    if (!t.trim() && !files.length) return;
    if (uploading) { setError('Wait a second: a file is still uploading.'); return; }
    if (busy) {
      if (files.length) { setError('Files go with the next message once this answer ends.'); return; }
      setQueue((q) => [...q, t.trim()]); setText(''); return; // queued: sent when this reply ends
    }
    pending.forEach((p) => p.preview && URL.revokeObjectURL(p.preview)); setPending([]);
    setHeld(false);
    setText(''); setError(''); setBusy(true); stick.current = true; setList(false);
    setMsgs((m) => [...m, { role: 'user', text: t, steps: [], at: new Date().toISOString(), files }, { role: 'assistant', text: '', steps: [] }]);
    const upd = (f: (a: Msg) => Msg) => setMsgs((m) => [...m.slice(0, -1), f(m[m.length - 1])]);
    const ac = new AbortController(); stop.current = ac;
    const fresh = !current.current;
    try {
      const whereText = window.__fleetOpenPages?.length ? `a split screen with ${window.__fleetOpenPages.length} pages open: ${window.__fleetOpenPages.join('; ')}`
        : variant === 'page' ? 'the AI page (no dashboard page open)' : `${where.join(' › ')} (${window.location.pathname}${window.location.search})`;
      const r = await fetch('/api/ai/chat', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread: current.current, text: t, where: whereText, agent: agent?.id, model, files: files.map((f) => f.id) }) });
      if (!r.ok || !r.body) { setError((await r.json().catch(() => ({}))).error ?? 'Something went wrong.'); setMsgs((m) => m.slice(0, -1)); return; }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
          if (ev.t === 'thread') { if (ev.thread !== current.current) { moveTo(ev.thread); setThreadTitle((t || 'Attached files').slice(0, 80)); } if (fresh) notifyThreads(); }
          else if (ev.t === 'text') upd((a) => ({ ...a, text: a.text + ev.d }));
          else if (ev.t === 'step') {
            upd((a) => { const s = [...a.steps]; s[ev.i] = { name: ev.name, title: ev.title, status: ev.status }; return { ...a, steps: s }; });
            // a change was filed: show its Approve card right away
            if (ev.status === 'done' && /^(propose_|app_run)/.test(ev.name)) void loadApprovals(current.current);
          }
          else if (ev.t === 'done') void loadApprovals(ev.thread ?? current.current);
          else if (ev.t === 'error') { setError(ev.m); setHeld(true); }
          else if (ev.t === 'context') setCtx({ used: ev.used, window: ev.window });
        }
      }
    } catch (e) {
      // the connection dropped (phone slept, network blip): the run goes on on the server, so follow it there
      const id = current.current;
      if ((e as Error).name !== 'AbortError') { if (id) window.setTimeout(() => follow(id), 0); else { setError('Lost the connection.'); setHeld(true); } }
    }
    finally {
      setBusy(false); stop.current = null; notifyThreads(); void loadApprovals(current.current);
      setMsgs((m) => (m.length && m[m.length - 1].role === 'assistant' && !m[m.length - 1].at ? [...m.slice(0, -1), { ...m[m.length - 1], at: new Date().toISOString() }] : m));
    }
  };

  // the queue drains one by one as each reply ends
  useEffect(() => {
    if (busy || held || editQ !== null || !queue.length) return;
    const [next, ...rest] = queue; setQueue(rest); void send(next);
  }, [busy, held, editQ, queue]); // eslint-disable-line react-hooks/exhaustive-deps
  // Steer: stop the reply that is running and send this one next. Send now: the queue is held (after Stop or an error).
  // Stop is a request to the server (closing the connection no longer stops a run); the local stream is dropped too
  const stopServer = () => { const id = current.current; if (id) void fetch(`/api/ai/chat?stop=${id}`, { method: 'POST' }).catch(() => {}); stop.current?.abort(); };
  const steer = (k: number) => { setQueue((q) => [q[k], ...q.filter((_, j) => j !== k)]); setHeld(false); stopServer(); };
  const sendNowQ = (k: number) => { const t = queue[k]; setQueue((q) => q.filter((_, j) => j !== k)); setHeld(false); void send(t); };
  const stopRun = () => { setHeld(true); stopServer(); };
  const pct = ctx ? Math.min(100, Math.round((ctx.used / ctx.window) * 100)) : 0;

  // "/" opens the skills menu while the first word is being typed (slash skills)
  const slash = /^\/([a-z0-9-]*)$/i.exec(text);
  const slashList = slash && skills ? skills.filter((s) => s.name.startsWith(slash[1].toLowerCase())).slice(0, 8) : [];
  const pickSkill = (name: string) => { setText(`/${name} `); setSlashAt(0); input.current?.focus(); };
  // @mention (D, 2026-10-09, CTRL Flow's): "@Ana" at the end of the text lists agents; picking one hands this message to it
  const at = slashList.length ? null : /(^|\s)@([\w-]*)$/.exec(text);
  const atList = at ? agents.filter((a) => a.name.toLowerCase().replace(/\s+/g, '-').startsWith(at[2].toLowerCase())).slice(0, 6) : [];
  const pickAgent = (id: number) => { setAgentId(id); setText(text.replace(/(^|\s)@[\w-]*$/, '$1')); setSlashAt(0); input.current?.focus(); };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (atList.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashAt((slashAt + 1) % atList.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashAt((slashAt - 1 + atList.length) % atList.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickAgent(atList[Math.min(slashAt, atList.length - 1)].id); return; }
    }
    if (slashList.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashAt((slashAt + 1) % slashList.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashAt((slashAt - 1 + slashList.length) % slashList.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); pickSkill(slashList[Math.min(slashAt, slashList.length - 1)].name); return; }
      if (e.key === 'Escape') { e.preventDefault(); setText(''); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); }
  };

  const composer = (
    <div className={cn('relative', page ? 'w-full' : 'mx-3 mb-3')}>
      {atList.length > 0 && (
        <div role="listbox" aria-label="Agents" className="absolute bottom-full left-0 right-0 z-10 mb-1.5 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-[0_12px_30px_-12px_rgba(14,20,34,0.35)]">
          {atList.map((a, k) => (
            <button key={a.id} type="button" role="option" aria-selected={k === slashAt} onMouseEnter={() => setSlashAt(k)} onClick={() => pickAgent(a.id)}
              className={cn('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left', k === slashAt && 'bg-inset')}>
              <AgentMark icon={a.icon} color={a.color} avatar={a.avatar} size={20} />
              <span className="text-[15px] font-semibold md:text-[13px]">{a.name}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground md:text-[12px]">{a.description}</span>
            </button>
          ))}
        </div>
      )}
      {slashList.length > 0 && (
        <div role="listbox" aria-label="Skills" className="absolute bottom-full left-0 right-0 z-10 mb-1.5 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-[0_12px_30px_-12px_rgba(14,20,34,0.35)]">
          {slashList.map((s, k) => (
            <button key={s.id} type="button" role="option" aria-selected={k === slashAt} onMouseEnter={() => setSlashAt(k)} onClick={() => pickSkill(s.name)}
              className={cn('flex w-full items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left', k === slashAt && 'bg-inset')}>
              <span className="font-mono text-[15px] font-semibold md:text-[12.5px]">/{s.name}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground md:text-[12px]">{s.description}</span>
            </button>
          ))}
        </div>
      )}
      {queue.length > 0 && (
        <div className="lg-glass mb-1.5 flex flex-col gap-1 rounded-2xl p-1.5">
          {queue.map((q, k) => (
            <div key={k} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[15px] hover:bg-inset md:text-[12.5px]">
              <IconCornerDownRight size={13} className="shrink-0 text-label" />
              {editQ === k
                ? <input autoFocus defaultValue={q} aria-label="Edit queued message" className="min-w-0 flex-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[17px] outline-none md:text-[12.5px]"
                    onKeyDown={(e) => { if (e.key === 'Enter') { const v = e.currentTarget.value.trim(); setQueue((x) => (v ? x.map((y, j) => (j === k ? v : y)) : x.filter((_, j) => j !== k))); setEditQ(null); } if (e.key === 'Escape') setEditQ(null); }}
                    onBlur={(e) => { const v = e.currentTarget.value.trim(); setQueue((x) => (v ? x.map((y, j) => (j === k ? v : y)) : x.filter((_, j) => j !== k))); setEditQ(null); }} />
                : <button type="button" onClick={() => setEditQ(k)} title="Edit" className="min-w-0 flex-1 truncate text-left">{q}</button>}
              <span className="shrink-0 font-mono text-[13px] text-label md:text-[10.5px]">{held ? 'held' : 'queued'}</span>
              {busy
                ? <button type="button" onClick={() => steer(k)} className="shrink-0 rounded-md px-2 py-1.5 text-[15px] font-semibold text-muted-foreground hover:text-foreground md:px-1.5 md:py-0 md:text-[11.5px]" title="Stop the current reply and send this next">Steer</button>
                : held && <button type="button" onClick={() => sendNowQ(k)} className="shrink-0 rounded-md px-2 py-1.5 text-[15px] font-semibold text-muted-foreground hover:text-foreground md:px-1.5 md:py-0 md:text-[11.5px]">Send now</button>}
              <button type="button" aria-label="Remove from queue" onClick={() => setQueue((x) => x.filter((_, j) => j !== k))} className="grid size-9 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground md:size-5"><IconX size={16} className="md:size-3" /></button>
            </div>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {pending.map((p) => (
            <div key={p.key} title={p.error ?? p.name} className={cn('relative flex h-14 max-w-[220px] items-center gap-2 overflow-hidden rounded-xl border bg-card pr-8', p.error ? 'border-weak' : 'border-border', p.kind === 'image' && !p.error ? 'w-14 p-0' : 'pl-2.5')}>
              {p.kind === 'image' && !p.error && (p.preview || p.file)
                ? <img src={p.preview ?? fileUrl(p.file!.id)} alt={p.name} className="size-14 object-cover" />
                : <><IconFileText size={20} className={cn('shrink-0', p.error ? 'text-weak' : 'text-label')} />
                  <span className="min-w-0"><span className="block truncate text-[13px] font-semibold">{p.name}</span>
                    <span className={cn('block truncate text-[11.5px]', p.error ? 'text-weak' : 'text-muted-foreground')}>{p.error ?? (p.file ? fileLabel(p.kind, p.name) : 'Uploading…')}</span></span></>}
              {!p.file && !p.error && <span className="absolute inset-0 grid place-items-center bg-card/60"><span className="size-4 animate-spin rounded-full border-2 border-label border-t-transparent" /></span>}
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => dropPending(p.key)} className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-card/90 text-muted-foreground hover:text-foreground"><IconX size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className={cn('lg-glass flex items-end gap-1.5 rounded-[26px] py-1.5 pl-3 pr-1.5 shadow-[0_2px_8px_-4px_rgba(14,20,34,0.12)] transition-colors focus-within:border-foreground/25', page && 'py-2 pl-4 pr-2')}>
        <input ref={picker} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <button type="button" aria-label="Add files or pictures" title="Add files or pictures (or paste, or drop them here)" onClick={() => picker.current?.click()} disabled={pending.length >= 5}
          className="-ml-1.5 mb-0.5 grid size-[30px] shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-foreground disabled:opacity-40"><IconPaperclip size={17} stroke={1.8} /></button>
        <textarea ref={input} value={text} rows={1} onChange={(e) => { setText(e.target.value); setSlashAt(0); }} onKeyDown={onKey}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
          placeholder={page ? 'Ask anything...' : 'Ask about this page...'}
          style={{ boxShadow: 'none' }} className="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1 text-[17px] outline-none [field-sizing:content] md:text-[15.5px]" />
        {ctx && pct >= 1 && (
          <button type="button" onClick={() => void send('/compact')} disabled={busy || pct < 50} title={`Conversation ${pct}% full (${Math.round(ctx.used / 1000)}k of ${Math.round(ctx.window / 1000)}k tokens). It compacts by itself at 80%.${pct >= 50 ? ' Click to compact now.' : ''}`}
            className={cn('mb-1 shrink-0 rounded-md px-2 py-1.5 font-mono text-[13px] md:px-1.5 md:py-0 md:text-[10.5px]', pct >= 70 ? 'text-watch' : 'text-label', pct >= 50 && !busy && 'hover:bg-inset hover:text-foreground')}>{pct}%</button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Model" className="mb-0.5 flex h-[30px] shrink-0 items-center gap-1 rounded-lg px-2 text-[15px] text-muted-foreground hover:bg-inset hover:text-foreground md:text-[12.5px]">
            {model === 'auto' ? AUTO_MODEL.label : findModel(model)?.label ?? 'Auto'}<IconChevronDown size={12} stroke={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-[260px]">
            {[{ id: 'auto', label: AUTO_MODEL.label, sub: AUTO_MODEL.sub }, ...(data?.models ?? [])].map((m) => (
              <DropdownMenuItem key={m.id} onClick={() => setModel(m.id)} className="items-start gap-2">
                <span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold">{m.label}</span><span className="block text-[11.5px] text-muted-foreground">{m.sub}</span></span>
                {model === m.id && <IconCheck size={14} className="mt-0.5 shrink-0 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {busy && !text.trim()
          ? <button type="button" onClick={stopRun} aria-label="Stop" className="grid size-[30px] place-items-center rounded-full bg-foreground text-background"><IconPlayerStopFilled size={12} /></button>
          : <button type="submit" aria-label="Send" className={cn('grid size-[30px] place-items-center rounded-full', text.trim() || ready.length ? 'bg-foreground text-background' : 'bg-inset text-muted-foreground')}><IconArrowUp size={15} stroke={2.2} /></button>}
      </form>
    </div>
  );
  const starters = (agent?.starters ?? []).length > 0 && (
    <div className="flex flex-wrap justify-center gap-1.5">
      {agent!.starters.map((s) => <button key={s} type="button" onClick={() => void send(s)} className="glass-pill h-10 rounded-full px-4 text-[15px] hover:bg-foreground/5 md:h-[30px] md:px-3 md:text-[12.5px]">{s}</button>)}
    </div>
  );
  const iconBtn = (Ico: typeof IconHistory, label: string, f: () => void, on = false) => (
    <button key={label} type="button" onClick={f} aria-label={label} title={label} aria-pressed={on || undefined}
      className={cn('grid size-[30px] place-items-center rounded-lg hover:bg-inset hover:text-foreground', on ? 'bg-inset text-foreground' : 'text-muted-foreground')}><Ico size={16} stroke={1.8} /></button>
  );

  return (
    <section aria-label="AI chat" className="relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}>
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-card/85 text-center">
          <span><IconPaperclip size={26} className="mx-auto mb-1.5 text-primary" /><span className="block text-[15px] font-semibold">Drop to add to your message</span>
            <span className="block text-[12.5px] text-muted-foreground">Pictures, PDFs, Excel, Word, PowerPoint and text files, up to 10 MB each</span></span>
        </div>
      )}
      <div className={cn('flex shrink-0 items-center gap-1.5 border-b border-border', page ? 'h-12 px-4' : 'px-3 py-2.5')}>
        {page && thread !== null && <button type="button" aria-label="Conversations" onClick={() => { void open(null); onThread?.(null); }} className="-ml-2 grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground md:hidden"><IconChevronLeft size={22} stroke={1.8} /></button>}
        <AgentPicker agents={agents} value={agent} onChange={(id) => setAgentId(id)} className="max-w-[55%] shrink-0" />
        {title?.({ id: thread, title: threadTitle, renamed: setThreadTitle })}
        <span className="flex-1" />
        {!page && iconBtn(IconHistory, 'Conversations', () => setList(!list), list)}
        {!page && iconBtn(IconPlus, 'New conversation', () => { void open(null); onThread?.(null); })}
        {toolbar}
      </div>
      <div ref={body} onScroll={onScroll} className={cn('fai min-h-0 flex-1 overflow-y-auto', page ? 'px-4 pb-4 pt-6 md:px-8' : 'px-4 pb-2 pt-4', page && (list || empty) && 'max-md:pb-[calc(104px+env(safe-area-inset-bottom))]')}>
        <div className={cn(page && 'mx-auto w-full max-w-[760px]', empty && 'h-full max-md:h-auto')}>
          {list ? (
            <div>
              <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-label">Conversations</div>
              {threads === null && <div className="text-[13px] text-muted-foreground">Loading...</div>}
              {threads?.length === 0 && <div className="text-[13px] text-muted-foreground">None yet.</div>}
              {threads?.map((t) => { const a = agents.find((x) => x.id === t.agent_id); return (
                <div key={t.id} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-inset">
                  <AgentGlyph icon={a?.icon} color={a?.color} />
                  <button type="button" onClick={() => { void open(t.id); onThread?.(t.id); }} className="min-w-0 flex-1 truncate text-left text-[13px]">{t.title || 'Untitled'}</button>
                  <span className="shrink-0 font-mono text-[11px] text-label">{relTime(t.updated_at)}</span>
                  <button type="button" aria-label="Delete" onClick={async () => { await fetch(`/api/ai/chat?thread=${t.id}`, { method: 'DELETE' }); notifyThreads(); if (thread === t.id) { void open(null); onThread?.(null); setList(true); } }}
                    className="hidden text-muted-foreground hover:text-foreground group-hover:block"><IconTrash size={14} stroke={1.8} /></button>
                </div>
              ); })}
            </div>
          ) : empty ? (
            <div className={cn('flex h-full flex-col items-center justify-center text-center', page ? 'gap-4 pb-[12vh] max-md:h-auto max-md:pb-2 max-md:pt-6' : 'gap-2.5')}>
              <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><AgentMark icon={agent?.icon} color={agent?.color} avatar={agent?.avatar} size={24} />{agent?.name ?? 'Agent'}</div>
              <h3 className={cn('font-semibold tracking-[-0.01em]', page ? 'text-[28px]' : 'mb-1.5 mt-1 text-[21px]')}>What should we work on?</h3>
              {page ? <>{composer}{starters}</> : starters}
              {page && (threads?.length ?? 0) > 0 && (
                <div className="mt-4 w-full text-left md:hidden">
                  <div className="mb-1 px-1 text-[13px] font-semibold text-muted-foreground">Your conversations</div>
                  {threads!.slice(0, 30).map((t) => { const a = agents.find((x) => x.id === t.agent_id) ?? agents.find((x) => x.is_default); return (
                    <button key={t.id} type="button" onClick={() => { void open(t.id); onThread?.(t.id); }}
                      className="flex h-12 w-full items-center gap-3 rounded-xl px-2 text-left active:bg-inset">
                      <AgentGlyph icon={a?.icon} color={a?.color} size={18} />
                      <span className="min-w-0 flex-1 truncate text-[16px]">{t.title || 'Untitled'}</span>
                      <span className="shrink-0 text-[13px] text-label">{relTime(t.updated_at)}</span>
                    </button>
                  ); })}
                </div>
              )}
              {!page && agent?.description && <div className="text-[12px] text-label">{agent.description}</div>}
            </div>
          ) : msgs.map((m, i) => {
            if (m.role === 'user') return (
              <div key={i} className="ml-auto flex max-w-[85%] flex-col items-end gap-1.5">
                {!!m.files?.length && <SentFiles files={m.files} />}
                {m.text && <div className="fai-user">{m.text}</div>}
              </div>
            );
            const live = busy && i === msgs.length - 1;
            const copy = plainText(m.text);
            return (
              <div key={i} className={cn('fai-asst', i === msgs.length - 1 && 'is-last')}>
                <RunSteps steps={m.steps} live={live} />
                {m.text ? <RichText text={m.text} onPrompt={(p) => void send(p)} /> : live && !m.steps.some((s) => s?.status === 'running') && <Working />}
                {!live && (copy || m.at) && (
                  <div className="fai-tacts">
                    {copy && <CopyButton text={copy} label="Copy reply" className="fai-ib">{(done) => (done ? <CheckIcon /> : <CopyIcon />)}</CopyButton>}
                    {m.at && <span className="fai-time">{clock(m.at)}</span>}
                  </div>
                )}
              </div>
            );
          })}
          {approvals.filter((a) => a.status === 'pending').map((a) => (
            <div key={a.id} className="lg-glass mb-3 rounded-2xl p-3">
              <div className="text-[15px] font-semibold md:text-[13px]">{a.summary}</div>
              <div className="mb-2.5 mt-0.5 text-[13px] text-muted-foreground md:text-[12px]">The agent asked to make this change. Nothing happens until you approve.</div>
              <div className="flex gap-2">
                <button type="button" onClick={() => void decideApproval(a.id, true)} className="h-10 rounded-lg bg-foreground px-4 text-[15px] font-semibold text-background md:h-8 md:px-3 md:text-[12.5px]">Approve</button>
                <button type="button" onClick={() => void decideApproval(a.id, false)} className="h-10 rounded-lg border border-border bg-card px-4 text-[15px] font-semibold md:h-8 md:px-3 md:text-[12.5px]">Not now</button>
              </div>
            </div>
          ))}
          {error && <div className="mb-3 rounded-lg bg-weak-bg px-3 py-2 text-[15px] text-weak md:text-[12.5px]">{error}</div>}
        </div>
      </div>
      {!list && !(page && empty) && (page ? (
        <div className="shrink-0 px-4 pb-4 max-md:pb-[calc(92px+env(safe-area-inset-bottom))] md:px-8"><div className="mx-auto w-full max-w-[760px]">{composer}</div></div>
      ) : <>
        <div className="flex flex-wrap gap-1.5 px-3.5 pb-1.5">
          {pages.length
            ? pages.map((p, k) => <span key={`${p.label}-${k}`} title={p.focus ? 'In focus' : undefined} className={cn('inline-flex h-6 items-center gap-1.5 rounded-[7px] bg-inset px-2 text-[13px] md:text-[11.5px]', p.focus ? 'text-foreground ring-1 ring-inset ring-foreground/15' : 'text-muted-foreground')}>{p.focus && <span className="size-1.5 rounded-full bg-primary" />}{p.label}</span>)
            : where.map((w) => <span key={w} className="inline-flex h-6 items-center rounded-[7px] bg-inset px-2 text-[13px] md:text-[11.5px] text-muted-foreground">{w}</span>)}
        </div>
        {composer}
      </>)}
    </section>
  );
}

/** The files sent with a message: pictures as thumbnails, other files as chips; each opens in a new tab. */
function SentFiles({ files }: { files: ChatFile[] }) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {files.map((f) => (f.kind === 'image'
        ? <a key={f.id} href={fileUrl(f.id)} target="_blank" rel="noreferrer" title={f.name} className="block overflow-hidden rounded-2xl border border-border">
            <img src={fileUrl(f.id)} alt={f.name} loading="lazy" className="max-h-56 max-w-[240px] object-cover" /></a>
        : <a key={f.id} href={fileUrl(f.id)} target="_blank" rel="noreferrer" className="flex h-12 max-w-[240px] items-center gap-2 rounded-xl border border-border bg-card px-2.5 hover:bg-inset">
            <IconFileText size={18} className="shrink-0 text-label" />
            <span className="min-w-0"><span className="block truncate text-[13px] font-semibold">{f.name}</span>
              <span className="block text-[11.5px] text-muted-foreground">{fileLabel(f.kind, f.name)} · {Math.max(1, Math.round(f.size / 1024))} KB</span></span></a>))}
    </div>
  );
}
