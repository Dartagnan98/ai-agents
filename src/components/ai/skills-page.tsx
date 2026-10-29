'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { IconArrowLeft, IconCopy, IconFileText, IconPlus, IconSearch, IconSlash, IconTrash, IconX } from '@tabler/icons-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, PageHeader, Pill, Section } from '@/components/shared/page-kit';
import { AI_PAGE } from './agents-page';
import { FolderGlyph, FolderTree, type TreeNode } from '@/components/wiki/folder-tree';
import { WikiRenderer } from '@/components/wiki/wiki-renderer';
import { cn } from '@/lib/utils';
import { skillSlug } from '@/lib/ai/catalog';
import { refreshSkills, useAiSkills, type UiSkill } from './use-ai';

// AI › Skills (D, 2026-10-09, SkillsPage): saved instructions you run by typing /<name> in any chat. Yours, or shared with
// the team (every owner and admin can run it). D, 2026-10-27: a folder sidebar (the wiki's tree; 'a/b' nests)
// and a page per skill at /ai/skills/<name> with the full description and instructions. Later that day: a skill is a folder like a
// Claude skill (SKILL.md plus files such as references/pricing.md, each its own page at ?file=), and owners and admins edit any team skill.
type FileDraft = { skillId: number; path: string; oldPath?: string; body: string };
type Draft = { id?: number; name: string; title: string; folder: string; description: string; body: string; share: 'me' | 'team' };
const FIELD = 'flex flex-col gap-1.5';
const LABEL = 'text-[12.5px] font-semibold text-muted-foreground';
const BUILT_IN = 'Built in';
// D, 2026-10-27: "team level skills and personal skills": the tree's top level. The owner also sees each person's personal skills.
const TEAM = 'Team skills', PERSONAL = 'Personal skills';
const sectionOf = (s: UiSkill) => (s.builtin || s.share === 'team' ? TEAM : s.mine ? PERSONAL : `Personal · ${s.maker || 'someone'}`);
/** Where a skill sits in the tree: its section, then its folder (no folder = straight under the section). */
const homeOf = (s: UiSkill) => [sectionOf(s), s.folder].filter(Boolean).join('/');
const href = (s: UiSkill, file?: string) => `/ai/skills/${s.name}${file ? `?file=${encodeURIComponent(file)}` : ''}`;
const SKILL_MD = 'SKILL.md';
/** A skill's own folder in the tree ('@' keeps it apart from a sidebar folder of the same name). */
const skillDir = (s: UiSkill) => `${homeOf(s)}/@${s.name}`;

/** Skills as a folder tree: your folders A to Z, then Unfiled, then Built in; each skill a folder with SKILL.md first, then its files.
 *  Also returns where each file row leads. */
function buildTree(skills: UiSkill[]): { nodes: TreeNode[]; links: Map<string, string> } {
  const links = new Map<string, string>();
  const root: TreeNode[] = [];
  const dirOf = (path: string) => {
    let level = root, acc = '';
    let dir: Extract<TreeNode, { kind: 'dir' }> | null = null;
    for (const part of path.split('/')) {
      acc = acc ? `${acc}/${part}` : part;
      dir = level.find((n): n is Extract<TreeNode, { kind: 'dir' }> => n.kind === 'dir' && n.relPath === acc) ?? null;
      if (!dir) level.push((dir = { kind: 'dir', name: part, relPath: acc, children: [] }));
      level = dir.children;
    }
    return dir!;
  };
  for (const s of skills) {
    const home = dirOf(homeOf(s)), dir = skillDir(s);
    const me: Extract<TreeNode, { kind: 'dir' }> = { kind: 'dir', name: s.title || `/${s.name}`, relPath: dir, children: [] };
    home.children.push(me);
    me.children.push({ kind: 'file', name: SKILL_MD, relPath: `${dir}/${SKILL_MD}`, mtimeMs: 0 });
    links.set(`${dir}/${SKILL_MD}`, href(s));
    for (const f of s.files ?? []) {
      const parts = f.path.split('/');
      let level = me.children, acc = dir;
      for (const part of parts.slice(0, -1)) {
        acc = `${acc}/${part}`;
        let d = level.find((n): n is Extract<TreeNode, { kind: 'dir' }> => n.kind === 'dir' && n.relPath === acc);
        if (!d) level.push((d = { kind: 'dir', name: part, relPath: acc, children: [] }));
        level = d.children;
      }
      level.push({ kind: 'file', name: parts[parts.length - 1], relPath: `${dir}/${f.path}`, mtimeMs: 0 });
      links.set(`${dir}/${f.path}`, href(s, f.path));
    }
  }
  const skillRow = (n: TreeNode) => n.relPath.split('/').pop()!.startsWith('@');
  // Team, then Personal, then other people's; inside: folders, skills, then Built in last; SKILL.md on top inside a skill
  const rank = (n: TreeNode) => (n.name === TEAM ? -3 : n.name === PERSONAL ? -2 : n.name === SKILL_MD ? -1 : n.name === BUILT_IN ? 3 : skillRow(n) ? 1 : 0);
  const sort = (ns: TreeNode[]) => {
    // folders first, then skills, then files; SKILL.md always on top inside a skill
    ns.sort((a, b) => rank(a) - rank(b) || Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name));
    for (const n of ns) if (n.kind === 'dir') sort(n.children);
    return ns;
  };
  return { nodes: sort(root), links };
}

export function SkillsPage({ selected, file }: { selected?: string; file?: string }) {
  const router = useRouter();
  const skills = useAiSkills();
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fileDraft, setFileDraft] = useState<FileDraft | null>(null);
  const skill = selected ? skills?.find((s) => s.name === selected) : undefined;
  const openFile = skill && file ? skill.files?.find((f) => f.path === file) : undefined;
  const folders = useMemo(() => [...new Set((skills ?? []).filter((s) => !s.builtin && s.folder).map((s) => s.folder!))].sort(), [skills]);
  const tree = useMemo(() => {
    const t = q.trim().toLowerCase();
    return buildTree((skills ?? []).filter((s) => !t || [s.name, s.title, s.description, s.folder, ...(s.files ?? []).map((f) => f.path)].some((v) => v?.toLowerCase().includes(t))));
  }, [skills, q]);

  const edit = (s?: UiSkill) => {
    setErr('');
    // a built-in is edited by saving the team's own version over it (same command; it then shows in its folder, not Built in)
    setDraft(s ? { id: s.builtin ? undefined : s.id, name: s.name, title: s.title ?? '', folder: s.builtin ? '' : s.folder ?? '', description: s.description, body: s.body, share: s.builtin ? 'team' : s.share }
      : { name: '', title: '', folder: '', description: '', body: '', share: 'me' });
  };
  const save = async () => {
    if (!draft) return;
    setBusy(true); setErr('');
    const r = await fetch(draft.id ? `/api/ai/skills?id=${draft.id}` : '/api/ai/skills', { method: draft.id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) }).catch(() => null);
    setBusy(false);
    if (!r?.ok) { setErr((await r?.json().catch(() => ({})))?.error ?? 'Could not save.'); return; }
    const saved = (await r.json().catch(() => ({})))?.skill as UiSkill | undefined;
    refreshSkills(); setDraft(null);
    if (saved && saved.name !== selected) router.push(href(saved));
  };
  const remove = async (s: UiSkill) => {
    if (!confirm(`Delete /${s.name}?`)) return;
    const r = await fetch(`/api/ai/skills?id=${s.id}`, { method: 'DELETE' });
    if (r.ok) { refreshSkills(); router.push('/ai/skills'); }
  };
  const fileCall = (payload: Record<string, unknown>) => fetch('/api/ai/skills', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: payload }) }).catch(() => null);
  const saveFile = async () => {
    if (!fileDraft || !skill) return;
    setBusy(true); setErr('');
    const r = await fileCall({ skill_id: fileDraft.skillId, path: fileDraft.path, body: fileDraft.body, old_path: fileDraft.oldPath });
    setBusy(false);
    if (!r?.ok) { setErr((await r?.json().catch(() => ({})))?.error ?? 'Could not save.'); return; }
    const path = (await r.json().catch(() => ({})))?.path as string | undefined;
    refreshSkills(); setFileDraft(null);
    if (path && path !== file) router.push(href(skill, path));
  };
  const removeFile = async (path: string) => {
    if (!skill || !confirm(`Delete ${path} from /${skill.name}?`)) return;
    const r = await fileCall({ skill_id: skill.id, path, delete: true });
    if (r?.ok) { refreshSkills(); router.push(href(skill)); }
  };
  const copy = (s: UiSkill) => { void navigator.clipboard?.writeText(`/${s.name}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };

  return (
    <div className="h-full overflow-y-auto">
      <div className={cn('@container', AI_PAGE)}>
        <PageHeader title="Skills" purpose="Instructions you use often. Type / in any chat to run one, with anything after it as extra detail."
          actions={<Button size="sm" onClick={() => edit()} className="gap-1.5"><IconPlus size={15} />New skill</Button>} />
        {skills?.length === 0 ? (
          <EmptyState title="No skills yet" action={<Button variant="outline" size="sm" onClick={() => edit()}>Make the first one</Button>}>
            For example /weekly-recap: &ldquo;Pull last week for every contract: cash collected, deals, close rate on calls taken. One table, then the three biggest changes.&rdquo;
          </EmptyState>
        ) : (
          <div className="grid gap-6 @3xl:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] @3xl:items-start">
            {/* the folder sidebar (the wiki's card); on a phone it gives way to the open skill */}
            <section className={cn('lg-card min-w-0 flex-col gap-3 rounded-[22px] bg-card px-4 pb-4 pt-5 shadow-[var(--card-shadow)] @3xl:sticky @3xl:top-4 @3xl:flex @3xl:max-h-[calc(100dvh-10rem)]', selected ? 'hidden' : 'flex')}>
              <div className="flex h-10 items-center gap-2.5 rounded-xl border border-border bg-card px-3 transition-shadow focus-within:border-primary focus-within:shadow-[0_0_0_3px_var(--cobalt-tint)]">
                <IconSearch size={16} stroke={1.8} className="shrink-0 text-muted-foreground" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills" aria-label="Search skills"
                  className="h-9 min-w-0 flex-1 border-0 bg-transparent text-[13.5px] outline-none placeholder:text-muted-foreground" />
                {q && <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="text-muted-foreground hover:text-foreground"><IconX size={14} /></button>}
              </div>
              <div className="flex items-center justify-between border-t border-hairline px-1 pt-2">
                <span className="micro-label">Folders</span>
                <span className="text-[12px] text-label">{skills ? `${skills.length} skills` : ''}</span>
              </div>
              <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
                {!skills ? (
                  <div className="flex flex-col gap-1.5">{[0, 1, 2, 3].map((i) => <div key={i} className="h-7 animate-pulse rounded-[10px] bg-inset" />)}</div>
                ) : tree.nodes.length ? (
                  <FolderTree nodes={tree.nodes} selected={skill ? `${skillDir(skill)}/${openFile ? openFile.path : SKILL_MD}` : null} storageKey="skills:open" fullNames defaultOpen={[TEAM, PERSONAL]}
                    onSelectFile={(rel) => { const to = tree.links.get(rel); if (to) router.push(to); }} />
                ) : <p className="p-4 text-center text-[13px] text-muted-foreground">No skill matches &ldquo;{q}&rdquo;.</p>}
              </div>
            </section>

            <Section hero className={cn('min-h-[420px]', !selected && 'hidden @3xl:block')}>
              <div className="md:px-3">
                {!selected ? (
                  <div className="flex flex-col items-start gap-3 py-10">
                    <span className="grid size-10 place-items-center rounded-[11px] bg-inset text-muted-foreground"><IconSlash size={18} stroke={1.8} /></span>
                    <h2 className="font-heading text-[20px] font-semibold tracking-[-0.01em]">Pick a skill</h2>
                    <p className="max-w-[460px] text-[13.5px] text-muted-foreground">Team skills are for everyone and every agent; personal skills are only yours. Open a skill to read it in full. Give a skill a folder when you edit it; Reports/Weekly makes a folder inside a folder.</p>
                  </div>
                ) : !skills ? (
                  <p className="py-10 text-[13.5px] text-muted-foreground">Loading skill...</p>
                ) : !skill ? (
                  <div className="flex flex-col items-start gap-3 py-10">
                    <p className="text-[13.5px] text-muted-foreground">There is no skill /{selected}, or it is not shared with you.</p>
                    <Button variant="outline" size="sm" onClick={() => router.push('/ai/skills')}>All skills</Button>
                  </div>
                ) : file && !openFile ? (
                  <div className="flex flex-col items-start gap-3 py-10">
                    <p className="text-[13.5px] text-muted-foreground">/{skill.name} has no file {file}.</p>
                    <Button variant="outline" size="sm" onClick={() => router.push(href(skill))}>Open /{skill.name}</Button>
                  </div>
                ) : openFile ? (
                  <FileView s={skill} f={openFile} onEdit={() => { setErr(''); setFileDraft({ skillId: skill.id, path: openFile.path, oldPath: openFile.path, body: openFile.body }); }}
                    onDelete={() => void removeFile(openFile.path)} />
                ) : (
                  <SkillView s={skill} copied={copied} onCopy={() => copy(skill)} onEdit={() => edit(skill)} onDelete={() => void remove(skill)}
                    onAddFile={() => { setErr(''); setFileDraft({ skillId: skill.id, path: 'references/', body: '' }); }} />
                )}
              </div>
            </Section>
          </div>
        )}
      </div>

      <Dialog open={!!draft} onOpenChange={(o) => { if (!o) setDraft(null); }}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[640px]">
          <DialogHeader className="border-b border-border px-6 py-4">
            <DialogTitle>{draft?.id ? `Edit /${draft.name}` : 'New skill'}</DialogTitle>
            <DialogDescription>Runs when a message starts with its name.</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
              <div className={FIELD}><label className={LABEL} htmlFor="sk-title">Name</label><Input id="sk-title" value={draft.title} maxLength={60} onChange={(e) => setDraft({ ...draft, title: e.target.value, ...(draft.id ? {} : { name: skillSlug(e.target.value) }) })} placeholder="Weekly recap" /></div>
              <div className={FIELD}>
                <label className={LABEL} htmlFor="sk-name">Command</label>
                <div className="flex items-center gap-1.5"><span className="font-mono text-[14px] text-label">/</span>
                  <Input id="sk-name" value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} onBlur={() => setDraft({ ...draft, name: skillSlug(draft.name) })} placeholder="weekly-recap" className="font-mono" />
                </div>
              </div>
              <div className={FIELD}>
                <label className={LABEL} htmlFor="sk-folder">Folder</label>
                <Input id="sk-folder" list="sk-folders" value={draft.folder} maxLength={120} onChange={(e) => setDraft({ ...draft, folder: e.target.value })} placeholder="Reports, or Reports/Weekly (empty = Unfiled)" />
                <datalist id="sk-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
              </div>
              <div className={FIELD}><label className={LABEL} htmlFor="sk-desc">Description</label><Textarea id="sk-desc" value={draft.description} rows={3} maxLength={4000} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="text-[13px]" placeholder="What it does and when to use it. The first line shows in the / menu." /></div>
              <div className={FIELD}>
                <label className={LABEL} htmlFor="sk-body">Instructions</label>
                <Textarea id="sk-body" value={draft.body} rows={10} onChange={(e) => setDraft({ ...draft, body: e.target.value })} className="min-h-48 text-[13px]" placeholder="What to pull, how to lay it out, what to point out." />
              </div>
              <div className={FIELD}>
                <span className={LABEL}>Team or personal</span>
                <span className="flex h-9 w-fit rounded-lg border border-border bg-inset p-0.5">
                  {(['team', 'me'] as const).map((v) => (
                    <button key={v} type="button" onClick={() => setDraft({ ...draft, share: v })} className={cn('rounded-md px-3 text-[12.5px] font-semibold', draft.share === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
                      {v === 'me' ? 'Personal' : 'Team'}
                    </button>
                  ))}
                </span>
                <span className="text-[12px] text-label">{draft.share === 'team' ? 'Every owner, admin and agent can run it; it shows under Team skills.' : 'Only you (and agents in your chats) can run it; it shows under Personal skills.'}</span>
              </div>
              {err && <div className="rounded-lg bg-weak-bg px-3 py-2 text-[12.5px] text-weak">{err}</div>}
            </div>
          )}
          <DialogFooter className="flex-row justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={busy || !draft?.name.trim() || !draft?.body.trim()} onClick={() => void save()}>{draft?.id ? 'Save' : 'Add skill'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!fileDraft} onOpenChange={(o) => { if (!o) setFileDraft(null); }}>
        <DialogContent className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[720px]">
          <DialogHeader className="border-b border-border px-6 py-4">
            <DialogTitle>{fileDraft?.oldPath ? `Edit ${fileDraft.oldPath}` : `New file in /${skill?.name ?? ''}`}</DialogTitle>
            <DialogDescription>Agents see the skill&apos;s files and read them when SKILL.md points to them.</DialogDescription>
          </DialogHeader>
          {fileDraft && (
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
              <div className={FIELD}>
                <label className={LABEL} htmlFor="sk-path">Path</label>
                <Input id="sk-path" value={fileDraft.path} maxLength={200} onChange={(e) => setFileDraft({ ...fileDraft, path: e.target.value })} placeholder="references/pricing.md" className="font-mono" />
              </div>
              <div className={FIELD}>
                <label className={LABEL} htmlFor="sk-file-body">Content</label>
                <Textarea id="sk-file-body" value={fileDraft.body} rows={16} onChange={(e) => setFileDraft({ ...fileDraft, body: e.target.value })} className="min-h-72 font-mono text-[12.5px]" placeholder="Markdown, a template, examples..." />
              </div>
              {err && <div className="rounded-lg bg-weak-bg px-3 py-2 text-[12.5px] text-weak">{err}</div>}
            </div>
          )}
          <DialogFooter className="flex-row justify-end gap-2 border-t border-border px-6 py-3">
            <Button variant="outline" onClick={() => setFileDraft(null)}>Cancel</Button>
            <Button disabled={busy || !fileDraft?.path.trim() || fileDraft.path.trim().endsWith('/')} onClick={() => void saveFile()}>{fileDraft?.oldPath ? 'Save' : 'Add file'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One skill in full: folder path, name, command, who can run it, the whole description and the instructions. */
function SkillView({ s, copied, onCopy, onEdit, onDelete, onAddFile }: { s: UiSkill; copied: boolean; onCopy: () => void; onEdit: () => void; onDelete: () => void; onAddFile: () => void }) {
  const parts = homeOf(s).split('/');
  const updated = s.updated_at ? new Date(s.updated_at.replace(' ', 'T')) : null;
  return (
    <article className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href="/ai/skills" className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-foreground @3xl:hidden" aria-label="All skills"><IconArrowLeft size={16} /></Link>
        <p className="flex min-w-[180px] flex-1 items-center gap-2 font-mono text-[12px] text-label">
          <FolderGlyph open={false} size={14} />
          <span className="truncate">
            {parts.map((p, i) => <span key={i}>{i > 0 && <span className="text-[#C9D1E6] dark:text-border">/</span>}{p}</span>)}
            <span className="text-[#C9D1E6] dark:text-border">/</span><span className="text-foreground">{s.name}</span>
          </span>
        </p>
        <span className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCopy} className="gap-1.5"><IconCopy size={14} />{copied ? 'Copied' : 'Copy command'}</Button>
          {s.builtin && <Button variant="outline" size="sm" onClick={onEdit} title="Saves the team's own version over the built-in">Edit</Button>}
          {s.canEdit && <>
            <Button variant="outline" size="sm" onClick={onEdit}>Edit</Button>
            <button type="button" aria-label={`Delete /${s.name}`} onClick={onDelete} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-weak"><IconTrash size={15} stroke={1.8} /></button>
          </>}
        </span>
      </div>

      <h2 className="mt-4 break-words font-heading text-[24px] font-semibold leading-tight tracking-[-0.02em] md:text-[30px]">{s.title || `/${s.name}`}</h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-inset px-2 py-0.5 font-mono text-[12.5px]">/{s.name}</span>
        {s.builtin ? <Pill>Built in</Pill> : <Pill>{s.share === 'team' ? 'Team' : 'Only me'}</Pill>}
        {!s.mine && !s.builtin && <span className="text-[12px] text-label">by a teammate</span>}
        {updated && !Number.isNaN(updated.getTime()) && <span className="text-[12px] text-label">Updated {updated.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>}
      </div>

      <section className="mt-7 flex max-w-[720px] flex-col gap-2">
        <span className="micro-label text-[10.5px]!">Description</span>
        {s.description ? <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{s.description}</p> : <p className="text-[13.5px] text-muted-foreground">No description yet.{s.mine ? ' Add one with Edit.' : ''}</p>}
      </section>
      <section className="mt-7 flex max-w-[720px] flex-col gap-2 border-t border-hairline pt-6">
        <span className="micro-label text-[10.5px]!">Instructions · {SKILL_MD}</span>
        <WikiRenderer text={s.body} onWikilink={() => {}} />
      </section>
      <section className="mt-7 flex max-w-[720px] flex-col gap-2 border-t border-hairline pt-6">
        <div className="flex items-center justify-between gap-3">
          <span className="micro-label text-[10.5px]!">Files</span>
          {s.canEdit && <Button variant="outline" size="sm" onClick={onAddFile} className="gap-1.5"><IconPlus size={14} />Add file</Button>}
        </div>
        {(s.files ?? []).length ? (
          <div className="flex flex-col divide-y divide-hairline rounded-xl border border-border">
            {s.files!.map((f) => (
              <Link key={f.path} href={href(s, f.path)} className="flex items-center gap-2.5 px-3 py-2.5 text-[13px] hover:bg-inset">
                <IconFileText size={15} stroke={1.7} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{f.path}</span>
                <span className="shrink-0 font-mono text-[11px] text-label">{f.body.length.toLocaleString('en-US')} chars</span>
              </Link>
            ))}
          </div>
        ) : <p className="text-[13px] text-muted-foreground">{s.builtin ? 'Edit this built-in once to save the team\'s own version, then add files to it.' : s.canEdit ? 'No files yet. Add references, examples or templates the instructions point to, like references/pricing.md.' : 'No files.'}</p>}
      </section>
    </article>
  );
}

/** One file of a skill: its path under the skill's folder, the content (markdown drawn, anything else as text), edit and delete. */
function FileView({ s, f, onEdit, onDelete }: { s: UiSkill; f: { path: string; body: string; updated_at?: string }; onEdit: () => void; onDelete: () => void }) {
  const md = /\.(md|markdown|txt)$/i.test(f.path) || !/\.[a-z0-9]+$/i.test(f.path);
  return (
    <article className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link href={href(s)} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-foreground" aria-label={`Back to /${s.name}`}><IconArrowLeft size={16} /></Link>
        <p className="flex min-w-[180px] flex-1 items-center gap-2 truncate font-mono text-[12px] text-label">
          <FolderGlyph open size={14} />
          <Link href={href(s)} className="hover:text-foreground">{s.name}</Link>
          {f.path.split('/').map((p, i, all) => <span key={i}><span className="text-[#C9D1E6] dark:text-border">/</span><span className={cn(i === all.length - 1 && 'text-foreground')}>{p}</span></span>)}
        </p>
        {s.canEdit && <span className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>Edit</Button>
          <button type="button" aria-label={`Delete ${f.path}`} onClick={onDelete} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-weak"><IconTrash size={15} stroke={1.8} /></button>
        </span>}
      </div>
      <h2 className="mt-4 break-words font-mono text-[20px] font-semibold leading-tight md:text-[22px]">{f.path.split('/').pop()}</h2>
      <p className="mt-2 text-[12px] text-label">In /{s.name} · {f.body.length.toLocaleString('en-US')} characters</p>
      <div className="mt-7 max-w-[760px]">
        {md ? <WikiRenderer text={f.body} onWikilink={() => {}} /> : <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl bg-inset px-4 py-3.5 font-mono text-[12.5px] leading-relaxed">{f.body}</pre>}
      </div>
    </article>
  );
}
