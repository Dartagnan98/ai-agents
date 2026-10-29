'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { IconDots, IconKey, IconPlus, IconRefresh, IconSearch, IconTrash } from '@tabler/icons-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Pill, Section } from '@/components/shared/page-kit';
import { connectComposio, fetchComposio, linkApp, removeAppAccount, saveComposioKey, searchApps, type AppAccount, type AppCard, type ComposioState } from '@/lib/actions/composio';

// Settings > Connectors > Apps: the Composio gallery (D 2026-09-29: "once connected, show the options to
// connect, bring up the screen, show the icons of apps"). One sign-in per server; every card links an app
// the fleet agents can then act in.
const STATUS: Record<AppCard['status'], { label: string; tone: 'healthy' | 'watch' | 'weak' | 'neutral'; button: string }> = {
  ACTIVE: { label: 'Linked', tone: 'healthy', button: 'Relink' },
  INITIALIZING: { label: 'Waiting for sign-in', tone: 'watch', button: 'Connect' },
  EXPIRED: { label: 'Expired', tone: 'weak', button: 'Reconnect' },
  FAILED: { label: 'Failed', tone: 'weak', button: 'Connect' },
  NONE: { label: 'Not linked', tone: 'neutral', button: 'Connect' },
};
const fmt = new Intl.NumberFormat('en-US');

function Logo({ app, size = 44 }: { app: AppCard; size?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={app.logo} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" className="shrink-0 rounded-xl bg-white object-contain p-1.5 ring-1 ring-foreground/10" style={{ width: size, height: size }} />;
}

/** Open the hosted sign-in in a tab opened on the click itself, so the browser allows it. */
async function openLink(slug: string, alias?: string): Promise<string | null> {
  const tab = window.open('', '_blank');
  const r = await linkApp(slug, alias);
  if (r.success) { if (tab) tab.location.href = r.url; else window.open(r.url, '_blank', 'noopener'); return null; }
  tab?.close();
  return r.error;
}

const DOT: Record<AppCard['status'], string> = { ACTIVE: 'bg-[#0B8F6A]', INITIALIZING: 'bg-[#D97706]', EXPIRED: 'bg-[#C8102E]', FAILED: 'bg-[#C8102E]', NONE: 'bg-border' };

function AppTile({ app, canLink, onLinked }: { app: AppCard; canLink: boolean; onLinked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState('');
  const [drop, setDrop] = useState<string | null>(null);
  const s = STATUS[app.status];
  const linked = app.accounts.length > 0;
  const go = async (name?: string) => {
    setBusy(true); setMsg(null);
    const err = await openLink(app.slug, name);
    setBusy(false);
    if (err) setMsg(err); else { setMsg('Finish the sign-in in the new tab.'); setAdding(false); setAlias(''); onLinked(); }
  };
  const remove = async (account: AppAccount) => {
    setBusy(true); setMsg(null);
    const r = await removeAppAccount(account.id);
    setBusy(false);
    if (r.success) { setDrop(null); setMsg('Removed.'); onLinked(); }
    else setMsg(r.error);
  };
  return (
    <div className="flex flex-col gap-3 rounded-[18px] border border-hairline bg-card p-4 shadow-[var(--card-shadow)]">
      {/* phones: logo above the name, so a two-column tile has room for "Google Calendar" */}
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:gap-3">
        <Logo app={app} />
        <div className="min-w-0 max-w-full sm:flex-1">
          <div className="break-words text-[14px] font-semibold sm:truncate">{app.name}</div>
          {(app.accounts.length > 0 || app.tools > 0) && (
            <div className="mt-0.5 font-mono text-[10.5px] uppercase tracking-[0.08em] text-label">
              {[app.accounts.length ? `${app.accounts.length} account${app.accounts.length === 1 ? '' : 's'}` : null, app.tools ? `${fmt.format(app.tools)} tools` : null].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      </div>
      {app.accounts.length > 0 && (
        <ul className="flex flex-col gap-1.5 font-mono text-[11px]">
          {app.accounts.map((a, i) => (
            <li key={a.id || i} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`size-1.5 shrink-0 rounded-full ${DOT[a.status]}`} />
              <span>{a.alias ?? 'main'}</span>
              <span className="text-label">{STATUS[a.status].label.toLowerCase()}</span>
              {canLink && a.id && drop !== a.id && <button type="button" className="font-semibold text-destructive hover:underline" onClick={() => setDrop(a.id)} disabled={busy}>Remove</button>}
              {drop === a.id && (
                <span className="flex flex-wrap items-center gap-1.5 font-sans">
                  <span className="text-foreground">Remove this account?</span>
                  <Button size="sm" variant="destructive" type="button" onClick={() => remove(a)} disabled={busy}>{busy ? 'Removing…' : 'Remove it'}</Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setDrop(null)} disabled={busy}>Cancel</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Pill tone={s.tone} dot>{s.label}{app.accounts.length === 1 && app.alias ? ` · ${app.alias}` : ''}</Pill>
        {canLink && (
          <span className="flex flex-wrap items-center gap-1.5">
            {(!linked || app.status !== 'ACTIVE') && <Button size="sm" onClick={() => go()} disabled={busy}>{busy ? 'Opening…' : s.button}</Button>}
            {linked && !adding && <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={busy}>Add another</Button>}
          </span>
        )}
      </div>
      {adding && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (alias.trim()) go(alias); }}>
          <Input autoFocus value={alias} onChange={(e) => setAlias(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="Name it, e.g. second-shop" className="h-8 font-mono text-[12px] shadow-none!" />
          <Button size="sm" type="submit" disabled={busy || alias.trim().length < 2}>Link</Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => { setAdding(false); setAlias(''); }}>Cancel</Button>
        </form>
      )}
      {msg && <p className="text-[11.5px] text-weak">{msg}</p>}
    </div>
  );
}

/** A linked or known app as one compact row (D, 2026-10-09: Connectors as calm rows like Businesses): logo, name, accounts, status,
 *  one main action; adding another account, relinking and removing an account sit in the ⋯ menu. Same actions as the tile. */
function AppRow({ app, onLinked }: { app: AppCard; onLinked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [alias, setAlias] = useState('');
  const [drop, setDrop] = useState<AppAccount | null>(null);
  const s = STATUS[app.status];
  const linked = app.accounts.length > 0;
  const go = async (name?: string) => {
    setBusy(true); setMsg(null);
    const err = await openLink(app.slug, name);
    setBusy(false);
    if (err) setMsg(err); else { setMsg('Finish the sign-in in the new tab.'); setAdding(false); setAlias(''); onLinked(); }
  };
  const remove = async (account: AppAccount) => {
    setBusy(true); setMsg(null);
    const r = await removeAppAccount(account.id);
    setBusy(false);
    if (r.success) { setDrop(null); setMsg('Removed.'); onLinked(); }
    else setMsg(r.error);
  };
  const sub = [app.accounts.length ? app.accounts.map((a) => `${a.alias ?? 'main'}${a.status !== 'ACTIVE' ? ` (${STATUS[a.status].label.toLowerCase()})` : ''}`).join(', ') : null, app.tools ? `${fmt.format(app.tools)} tools` : null].filter(Boolean).join(' · ');
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 md:px-7">
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <Logo app={app} size={32} />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-semibold">{app.name}</span>
            {sub && <span className="block truncate text-[11.5px] text-label">{sub}</span>}
          </span>
        </span>
        <Pill tone={s.tone} dot>{s.label}</Pill>
        <span className="flex items-center gap-1">
          {(!linked || app.status !== 'ACTIVE') && <Button size="sm" variant={linked ? 'default' : 'outline'} onClick={() => go()} disabled={busy}>{busy ? 'Opening…' : s.button}</Button>}
          {linked && (
            <DropdownMenu>
              <DropdownMenuTrigger aria-label={`More for ${app.name}`} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-foreground"><IconDots size={16} /></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setAdding(true)}><IconPlus size={14} />Add another account</DropdownMenuItem>
                {app.status === 'ACTIVE' && <DropdownMenuItem onClick={() => go()}><IconRefresh size={14} />{s.button}</DropdownMenuItem>}
                {app.accounts.filter((a) => a.id).map((a) => <DropdownMenuItem key={a.id} onClick={() => setDrop(a)} className="text-weak"><IconTrash size={14} />Remove {a.alias ?? 'main'}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>
      {(adding || drop || msg) && (
        <div className="flex flex-wrap items-center gap-2 bg-inset px-6 py-2.5 md:px-7">
          {adding && (
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (alias.trim()) go(alias); }}>
              <Input autoFocus value={alias} onChange={(e) => setAlias(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="Name it, e.g. second-shop" className="h-8 w-56 font-mono text-[12px] shadow-none!" />
              <Button size="sm" type="submit" disabled={busy || alias.trim().length < 2}>Link</Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => { setAdding(false); setAlias(''); }}>Cancel</Button>
            </form>
          )}
          {drop && (
            <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
              Remove the {drop.alias ?? 'main'} account?
              <Button size="sm" variant="destructive" type="button" onClick={() => remove(drop)} disabled={busy}>{busy ? 'Removing…' : 'Remove it'}</Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setDrop(null)} disabled={busy}>Cancel</Button>
            </span>
          )}
          {msg && <span className="text-[11.5px] text-weak">{msg}</span>}
        </div>
      )}
    </div>
  );
}

/** The "Connect an app" screen: search the 1,500-app catalog, click Connect. */
function AppPicker({ open, onOpenChange, onLinked }: { open: boolean; onOpenChange: (o: boolean) => void; onLinked: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<AppCard[] | null>(null); // null = a search is running
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const id = ++seq.current;
    const t = setTimeout(() => { searchApps(q).then((r) => { if (seq.current === id) setResults(r); }); }, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connect an app</DialogTitle>
          <DialogDescription>Every app Composio can connect. Search to narrow the list, then sign in in the new tab.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <IconSearch size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-label" />
          <Input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setResults(null); }} placeholder="Search apps: quickbooks, slack, shopify…" className="h-10 pl-9 shadow-none!" />
        </div>
        <div className="-mx-1 max-h-[55dvh] overflow-y-auto px-1 pb-1">
          {results === null ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-28 animate-pulse rounded-[18px] bg-muted" />)}</div>
          ) : results.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-muted-foreground">No app matches &ldquo;{q}&rdquo;.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{results.map((a) => <AppTile key={a.slug} app={a} canLink onLinked={onLinked} />)}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function KeyBox({ signedIn, projectKey, onSaved }: { signedIn: boolean; projectKey: boolean; onSaved: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<'project' | 'user' | null>(null);
  const save = async () => {
    setBusy(true); setErr(null); setOk(null);
    const r = await saveComposioKey(value);
    setBusy(false);
    if (r.success) { setValue(''); setOk(r.kind); onSaved(); }
    else setErr(r.error);
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (value.trim()) save(); }}>
      <label htmlFor="composio-key" className="text-[12.5px] font-semibold text-muted-foreground">Composio key</label>
      <div className="flex flex-wrap items-center gap-2">
        <Input id="composio-key" type="password" value={value} onChange={(e) => { setValue(e.target.value); setOk(null); }} placeholder="ak_ project key, or uak_ user key" autoComplete="off" spellCheck={false} className="h-8 max-w-md font-mono text-[12.5px]" />
        <Button type="submit" size="sm" disabled={busy || value.trim().length < 20}>{busy ? 'Saving…' : signedIn ? 'Replace key' : 'Save key'}</Button>
      </div>
      <p className="text-[12px] text-label">{signedIn ? 'This server is already signed in. A project key (ak_) is stored for the API. A user key (uak_) switches the account.' : 'A project key (ak_) is stored for the API. A user key (uak_), or Connect Composio below, signs this server in so the apps connect.'}</p>
      {projectKey && ok !== 'project' && <p className="text-[12.5px] text-healthy">Project key is on this server.</p>}
      {ok === 'project' && <p className="text-[12.5px] text-healthy">Project key saved. It is not shown again. Finish the sign-in below so the apps connect.</p>}
      {ok === 'user' && <p className="text-[12.5px] text-healthy">Saved. The server is signed in with that user key.</p>}
      {err && <p className="text-[12.5px] text-weak">{err}</p>}
    </form>
  );
}

// compact: just the button, for the signed-in header row (D, 2026-10-19: the ⋯ menu hid it).
function SignIn({ state, onChanged, compact = false }: { state: ComposioState; onChanged: () => void; compact?: boolean }) {
  const [url, setUrl] = useState<string | null>(state.pending?.url ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setErr(null);
    const tab = window.open('', '_blank');
    const r = await connectComposio(state.signedIn);
    setBusy(false);
    if (r.success) { setUrl(r.url); if (tab) tab.location.href = r.url; onChanged(); } else { tab?.close(); setErr(r.error); }
  };
  if (compact) return state.installed ? (
    <Button variant="outline" size="sm" onClick={url ? () => window.open(url, '_blank', 'noopener') : start} disabled={busy} title={err ?? undefined}>
      {busy ? 'Opening…' : url ? 'Finish sign-in' : err ? 'Switch failed, retry' : 'Switch account'}
    </Button>
  ) : null;
  return (
    <div className="flex flex-col gap-2">
      {!state.installed ? (
        <p className="text-[13px] text-muted-foreground">Install the Composio CLI on the server as the user the dashboard runs as (docs.composio.dev/cli), then reload this page.</p>
      ) : url ? (
        <p className="text-[13px] text-muted-foreground">Finish the sign-in in the Composio tab. This page updates itself once you are in. <a href={url} target="_blank" rel="noopener" className="font-semibold text-primary hover:underline">Open the sign-in again</a></p>
      ) : state.signedIn ? (
        <p className="text-[13px] text-muted-foreground">Or sign in as another Composio account. The current one keeps working until you finish.</p>
      ) : (
        <p className="text-[13px] text-muted-foreground">Sign in once with the client&apos;s Composio account. Every app you link after that is available to the agents on this server.</p>
      )}
      {state.installed && !url && <div><Button onClick={start} disabled={busy} variant={state.signedIn ? 'outline' : 'default'}>{busy ? 'Opening…' : state.signedIn ? 'Switch account' : 'Connect Composio'}</Button></div>}
      {err && <p className="text-[11.5px] text-weak">{err}</p>}
    </div>
  );
}

export function ComposioApps() {
  const [state, setState] = useState<ComposioState | null>(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false), [keyOpen, setKeyOpen] = useState(false);
  const [watchUntil, setWatchUntil] = useState(0);
  const load = useCallback(() => { setBusy(true); fetchComposio().then(setState).finally(() => setBusy(false)); }, []);
  useEffect(() => { fetchComposio().then(setState); }, []);
  // While a sign-in or an app link is open in another tab, poll so the card flips to Linked on its own.
  const watch = useCallback(() => setWatchUntil(Date.now() + 5 * 60_000), []);
  useEffect(() => {
    if (!watchUntil) return;
    const t = setInterval(() => { if (Date.now() > watchUntil) { setWatchUntil(0); return; } fetchComposio().then(setState); }, 5000);
    return () => clearInterval(t);
  }, [watchUntil]);

  if (!state) return <div className="h-40 animate-pulse rounded-[22px] bg-card shadow-[var(--card-shadow)]" />;
  const linked = state.apps.filter((a) => a.status === 'ACTIVE').length, expired = state.apps.filter((a) => a.status === 'EXPIRED').length;
  const groups: [string, AppCard[]][] = [
    ['Needs attention', state.apps.filter((a) => a.status === 'EXPIRED' || a.status === 'FAILED' || a.status === 'INITIALIZING')],
    ['Linked', state.apps.filter((a) => a.status === 'ACTIVE')],
    ['Suggested', state.apps.filter((a) => a.status === 'NONE')],
  ];
  return (
    // Calm rows (D, 2026-10-09: the tile grid with many buttons looked busy): grouped by status, one action each, the key behind ⋯.
    <Section description={state.signedIn ? `Composio: ${state.note} Linked apps are open to the agents on this server.` : 'Composio: one sign-in that lets the agents work in Gmail, Calendar, Drive, Slack, Notion, GitHub and hundreds more. Sign in, then link each app with one click.'}
      actions={<>
        {state.signedIn && <Pill tone="healthy" dot>{linked} linked</Pill>}
        {expired > 0 && <Pill tone="weak" dot>{expired} expired</Pill>}
        {watchUntil > 0 && <Pill tone="info">Watching for the sign-in…</Pill>}
        <Button variant="outline" size="sm" onClick={load} disabled={busy} className="gap-1.5"><IconRefresh size={14} className={busy ? 'animate-spin' : ''} />Check again</Button>
        {state.signedIn && <Button variant="outline" size="sm" onClick={() => setPicker(true)} className="gap-1.5"><IconPlus size={15} />Connect an app</Button>}
        {state.signedIn && <SignIn compact state={state} onChanged={() => { watch(); load(); }} />}
        {state.signedIn && (
          <DropdownMenu>
            <DropdownMenuTrigger aria-label="More" className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-foreground"><IconDots size={16} /></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => setKeyOpen(true)}><IconKey size={14} />Composio key</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
        )}
      </>} flush>
      {!state.signedIn ? (
        <div className="flex flex-col gap-4 px-6 md:px-7">
          <KeyBox signedIn={state.signedIn} projectKey={state.projectKey} onSaved={() => { watch(); load(); }} />
          <SignIn state={state} onChanged={() => { watch(); load(); }} />
        </div>
      ) : (
        <div className="flex flex-col">
          {groups.filter(([, apps]) => apps.length).map(([label, apps]) => (
            <div key={label} className="flex flex-col">
              <div className="border-t border-border px-6 pb-1.5 pt-3 font-mono text-[10.5px] uppercase tracking-[0.12em] text-label md:px-7">{label} · {apps.length}</div>
              <div className="divide-y divide-border border-t border-border">
                {apps.map((a) => <AppRow key={a.slug} app={a} onLinked={() => { watch(); load(); }} />)}
              </div>
            </div>
          ))}
          {!state.apps.length && <p className="border-t border-border px-6 py-4 text-[13px] text-muted-foreground md:px-7">No app linked yet. Link one of the suggested apps, or Connect an app for the full list.</p>}
          <div className="border-t border-border" />
        </div>
      )}
      <AppPicker open={picker} onOpenChange={setPicker} onLinked={() => { watch(); }} />
      <Dialog open={keyOpen} onOpenChange={setKeyOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Composio key</DialogTitle>
            <DialogDescription>Stored on this server; it is not shown again.</DialogDescription>
          </DialogHeader>
          <KeyBox signedIn={state.signedIn} projectKey={state.projectKey} onSaved={() => { watch(); load(); }} />
        </DialogContent>
      </Dialog>
    </Section>
  );
}
