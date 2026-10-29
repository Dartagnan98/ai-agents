'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconFileText, IconNotes, IconPlus, IconSearch, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, PageHeader, Pill, Section } from '@/components/shared/page-kit';
import { WikiRenderer } from '@/components/wiki/wiki-renderer';

// Intelligence documents for one agency (D, 2026-10-10): the Knowledge page (reference documents: offers, scripts, SOPs, FAQs) and the
// Wiki page (the team's notes, with [[Title]] links between them). Paste or upload markdown or text, list by folder, open, edit,
// delete, search. the agents reads the same documents with its search_knowledge tool.
type Space = 'knowledge' | 'wiki';
interface Row { id: number; folder: string; title: string; source: string; file_name: string; size: number; preview: string; updated_at: string }
interface Doc extends Omit<Row, 'size' | 'preview'> { body: string }
interface Hit { id: number; folder: string; title: string; snippet: string; updated_at: string }
type Draft = { id?: number; title: string; folder: string; body: string; source?: 'paste' | 'upload'; file_name?: string };

const FIELD = 'flex flex-col gap-1.5';
const LABEL = 'text-[12.5px] font-semibold text-muted-foreground';
const MAX_FILE = 500_000;
const WORDS: Record<Space, { one: string; many: string; empty: string; example: string }> = {
  knowledge: { one: 'document', many: 'documents', empty: 'No documents yet',
    example: 'Add what your team and the AI should know by heart: offers and prices, call scripts, objection answers, onboarding steps. Paste text or upload .md and .txt files.' },
  wiki: { one: 'note', many: 'notes', empty: 'No notes yet',
    example: 'Write the team\'s notes here: decisions, how-tos, meeting notes. Link one note to another with [[Note title]].' },
};

const ago = (iso: string) => {
  const d = (Date.now() - Date.parse(iso)) / 86_400_000;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.floor(d)} days ago` : new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
const kb = (n: number) => (n < 1000 ? `${n} chars` : `${Math.round(n / 1000)}k chars`);
const titleOf = (name: string) => name.replace(/\.(md|markdown|txt)$/i, '').replace(/[-_]+/g, ' ').trim() || 'Untitled';
const firstLine = (s: string) => s.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';

/** A search snippet with [[ ]] around the matches. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[[^\]]*\]\])/g);
  return <>{parts.map((p, i) => (p.startsWith('[[') && p.endsWith(']]') ? <mark key={i} className="rounded bg-watch-bg px-0.5 text-foreground">{p.slice(2, -2)}</mark> : <span key={i}>{p}</span>))}</>;
}

export function DocsLibrary({ space, title, purpose, switcher }: { space: Space; title: string; purpose: ReactNode; switcher?: ReactNode }) {
  const w = WORDS[space];
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [open, setOpen] = useState<Doc | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/knowledge/documents?space=${space}`).catch(() => null);
    const j = r?.ok ? await r.json() : null;
    setRows(j?.docs ?? []);
  }, [space]);
  useEffect(() => { void load(); }, [load]);
  // ?doc=<id> opens that document (the top bar search links here)
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get('doc')); if (id > 0) void show(id); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const needle = q.trim();
    if (!needle) { setHits(null); return; }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/knowledge/documents?space=${space}&q=${encodeURIComponent(needle)}`).catch(() => null);
      setHits(r?.ok ? (await r.json()).hits ?? [] : []);
    }, 200);
    return () => clearTimeout(t);
  }, [q, space]);

  const folders = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of rows ?? []) m.set(r.folder, [...(m.get(r.folder) ?? []), r]);
    return [...m.entries()];
  }, [rows]);
  const knownFolders = useMemo(() => [...new Set((rows ?? []).map((r) => r.folder).filter(Boolean))], [rows]);

  const show = async (id: number) => {
    const r = await fetch(`/api/knowledge/documents?id=${id}`).catch(() => null);
    if (r?.ok) setOpen((await r.json()).doc);
  };
  const wikilink = (slug: string) => {
    const want = slug.split('|')[0].trim().toLowerCase();
    const row = rows?.find((r) => r.title.toLowerCase() === want);
    if (row) void show(row.id);
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true); setErr('');
    const r = await fetch(draft.id ? `/api/knowledge/documents?id=${draft.id}` : '/api/knowledge/documents', { method: draft.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...draft, space }) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setErr((await r?.json().catch(() => ({})))?.error ?? 'Could not save.'); return; }
    const saved = (await r.json()).doc as Doc;
    setDraft(null);
    if (open?.id === saved.id) setOpen(saved);
    void load();
  };
  const remove = async (d: { id: number; title: string }) => {
    if (!confirm(`Delete "${d.title}"? This cannot be undone.`)) return;
    const r = await fetch(`/api/knowledge/documents?id=${d.id}`, { method: 'DELETE' }).catch(() => null);
    if (r?.ok) { if (open?.id === d.id) setOpen(null); void load(); }
  };
  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setNote('');
    let added = 0;
    const skipped: string[] = [];
    for (const f of [...list]) {
      if (!/\.(md|markdown|txt)$/i.test(f.name) || f.size > MAX_FILE * 2) { skipped.push(f.name); continue; }
      const body = await f.text();
      if (!body.trim() || body.length > MAX_FILE) { skipped.push(f.name); continue; }
      const r = await fetch('/api/knowledge/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ space, title: titleOf(f.name), body, source: 'upload', file_name: f.name }) }).catch(() => null);
      if (r?.ok) added++; else skipped.push(f.name);
    }
    if (file.current) file.current.value = '';
    setNote(`${added} ${added === 1 ? w.one : w.many} added.${skipped.length ? ` Skipped (only .md or .txt under 500k characters): ${skipped.join(', ')}.` : ''}`);
    void load();
  };

  const actions = (
    <>
      <input ref={file} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple hidden onChange={(e) => void upload(e.target.files)} />
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => file.current?.click()}><IconUpload size={15} />Upload</Button>
      <Button size="sm" className="gap-1.5" onClick={() => { setErr(''); setDraft({ title: '', folder: '', body: '' }); }}><IconPlus size={15} />New {w.one}</Button>
    </>
  );
  const Icon = space === 'wiki' ? IconNotes : IconFileText;
  const rowLine = (r: { id: number; title: string; folder?: string }, sub: ReactNode, meta?: ReactNode) => (
    <div key={r.id} className="group flex items-center gap-3 px-6 py-3 md:px-7">
      <button type="button" onClick={() => void show(r.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-inset text-muted-foreground"><Icon size={16} stroke={1.8} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold group-hover:underline">{r.title}</span>
          <span className="block truncate text-[12px] text-muted-foreground">{sub}</span>
        </span>
      </button>
      {meta && <span className="hidden shrink-0 text-[11.5px] text-label sm:block">{meta}</span>}
      <button type="button" aria-label={`Delete ${r.title}`} onClick={() => void remove(r)} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-weak"><IconTrash size={15} stroke={1.8} /></button>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} purpose={purpose} actions={actions}
        answer={rows && rows.length > 0 ? `${rows.length} ${rows.length === 1 ? w.one : w.many}${knownFolders.length ? ` in ${knownFolders.length} folder${knownFolders.length === 1 ? '' : 's'}` : ''}.` : undefined}
        filters={switcher} />
      {note && <div className="flex items-center justify-between gap-3 rounded-xl bg-inset px-4 py-2 text-[12.5px]"><span>{note}</span><button type="button" aria-label="Close" onClick={() => setNote('')}><IconX size={14} /></button></div>}
      {rows && rows.length === 0 ? (
        <EmptyState title={w.empty} action={<Button variant="outline" size="sm" onClick={() => setDraft({ title: '', folder: '', body: '' })}>Add the first one</Button>}>{w.example}</EmptyState>
      ) : (
        <Section flush>
          <div className="px-6 pb-3 md:px-7">
            <label className="relative block max-w-md">
              <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-label" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${w.many}`} className="pl-9" aria-label={`Search ${w.many}`} />
            </label>
          </div>
          <div className="divide-y divide-border border-y border-border">
            {!rows && <div className="px-6 py-4 text-[13px] text-muted-foreground md:px-7">Loading...</div>}
            {hits && (hits.length === 0
              ? <div className="px-6 py-4 text-[13px] text-muted-foreground md:px-7">Nothing matches &ldquo;{q.trim()}&rdquo;.</div>
              : hits.map((h) => rowLine(h, <Snippet text={h.snippet} />, h.folder || undefined)))}
            {!hits && folders.map(([folder, list]) => (
              <div key={folder || '-'} className="divide-y divide-border">
                {folders.length > 1 && <div className="bg-inset/60 px-6 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-label md:px-7">{folder || 'No folder'}</div>}
                {list.map((r) => rowLine(r, firstLine(r.preview) || 'Empty', `${kb(r.size)} · ${ago(r.updated_at)}`))}
              </div>
            ))}
          </div>
        </Section>
      )}

      <Dialog open={!!open && !draft} onOpenChange={(o) => { if (!o) setOpen(null); }}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]">
          <DialogHeader className="border-b border-border px-6 py-4">
            <DialogTitle>{open?.title}</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2">
              {open?.folder && <Pill>{open.folder}</Pill>}
              {open?.source === 'upload' && open.file_name && <span>From {open.file_name}</span>}
              {open && <span>Updated {ago(open.updated_at)}</span>}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{open && <WikiRenderer text={open.body} onWikilink={wikilink} />}</div>
          <DialogFooter className="flex-row justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={() => open && void remove(open)} className="mr-auto text-weak">Delete</Button>
            <Button variant="outline" onClick={() => setOpen(null)}>Close</Button>
            <Button onClick={() => { if (open) { setErr(''); setDraft({ id: open.id, title: open.title, folder: open.folder, body: open.body }); } }}>Edit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!draft} onOpenChange={(o) => { if (!o) setDraft(null); }}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]">
          <DialogHeader className="border-b border-border px-6 py-4">
            <DialogTitle>{draft?.id ? `Edit ${w.one}` : `New ${w.one}`}</DialogTitle>
            <DialogDescription>Markdown or plain text. {space === 'wiki' ? 'Link another note with [[Its title]].' : 'The agents can search it.'}</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
              <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
                <div className={FIELD}><label className={LABEL} htmlFor="kd-title">Title</label><Input id="kd-title" value={draft.title} maxLength={160} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={space === 'wiki' ? 'How we onboard a new contract' : 'Offer and pricing'} /></div>
                <div className={FIELD}>
                  <label className={LABEL} htmlFor="kd-folder">Folder</label>
                  <Input id="kd-folder" list="kd-folders" value={draft.folder} maxLength={60} onChange={(e) => setDraft({ ...draft, folder: e.target.value })} placeholder="Optional" />
                  <datalist id="kd-folders">{knownFolders.map((f) => <option key={f} value={f} />)}</datalist>
                </div>
              </div>
              <div className={FIELD}>
                <label className={LABEL} htmlFor="kd-body">Text</label>
                <Textarea id="kd-body" value={draft.body} rows={16} onChange={(e) => setDraft({ ...draft, body: e.target.value })} className="min-h-72 font-mono text-[12.5px]" placeholder="Paste or write here." />
                <span className="text-[11.5px] text-label">{draft.body.length.toLocaleString()} / {MAX_FILE.toLocaleString()} characters</span>
              </div>
              {err && <div className="rounded-lg bg-weak-bg px-3 py-2 text-[12.5px] text-weak">{err}</div>}
            </div>
          )}
          <DialogFooter className="flex-row justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={busy || !draft?.title.trim() || !draft?.body.trim() || (draft?.body.length ?? 0) > MAX_FILE} onClick={() => void save()}>{draft?.id ? 'Save' : `Add ${w.one}`}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The legacy agency's view switch (its own documents, or the cortextOS-era files read only). Plain links: the page reads ?view=. */
export function ViewSwitch({ base, view, options }: { base: string; view: string; options: { value: string; label: string }[] }) {
  return (
    <span className="flex h-9 w-fit rounded-lg border border-border bg-inset p-0.5">
      {options.map((o) => (
        <Link key={o.value} href={o.value ? `${base}?view=${o.value}` : base}
          className={`grid place-items-center rounded-md px-3 text-[12.5px] font-semibold ${view === o.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
          {o.label}
        </Link>
      ))}
    </span>
  );
}
