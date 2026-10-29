'use client';

import { WaSection } from '@/components/settings/wa-section';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconAlertTriangle, IconCircleCheck, IconDots, IconExternalLink } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/shared/page-kit';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

// Settings › AI connections (D, 2026-10-09: "Claude can be a connector, or the GPT / Grok subscriptions, or their own API key").
// One row per way to run the AI; every agent's model picker lists what is connected here. The owner connects; admins see status.
type Kind = 'claude-token' | 'anthropic-key' | 'openai-key' | 'xai-key' | 'chatgpt-plan' | 'grok-plan' | 'openrouter-key' | 'voyage-key';
type Conn = { kind: Kind; connected: boolean; status: string; detail: string; last4: string; account: string; plan: string; models: string[] };
type Data = { connections: Conn[]; available: string[]; owner: boolean; telegram?: { connected: boolean; username: string; webhook: string; linked: number } };

const ROWS: { kind: Kind; name: string; sub: string; how: 'key' | 'plan' | 'token'; placeholder?: string; link?: string; group: string }[] = [
  { kind: 'claude-token', name: 'Claude subscription', sub: 'Runs the AI on a Claude Pro or Max plan, headless. On this server a login may already be set up; a token here wins.', how: 'token', placeholder: 'sk-ant-oat...', group: 'Subscriptions' },
  { kind: 'chatgpt-plan', name: 'ChatGPT plan', sub: 'Experimental: signs in like the official Codex CLI. OpenAI may limit this.', how: 'plan', group: 'Subscriptions' },
  { kind: 'grok-plan', name: 'SuperGrok plan', sub: 'Experimental: signs in like the official Grok CLI. xAI may limit this.', how: 'plan', group: 'Subscriptions' },
  { kind: 'anthropic-key', name: 'Anthropic API key', sub: 'Claude, pay per use.', how: 'key', placeholder: 'sk-ant-api...', link: 'https://console.anthropic.com/settings/keys', group: 'API keys' },
  { kind: 'openai-key', name: 'OpenAI API key', sub: 'GPT models, pay per use.', how: 'key', placeholder: 'sk-...', link: 'https://platform.openai.com/api-keys', group: 'API keys' },
  { kind: 'xai-key', name: 'xAI API key', sub: 'Grok models, pay per use.', how: 'key', placeholder: 'xai-...', link: 'https://console.x.ai', group: 'API keys' },
  // memory only (D, 2026-10-28): sharper memory search for every agent; without them memory runs on the server's own small models
  { kind: 'openrouter-key', name: 'OpenRouter API key', sub: 'Memory search: OpenAI embeddings for memory and the graph, pay per use (a few dollars a month).', how: 'key', placeholder: 'sk-or-...', link: 'https://openrouter.ai/settings/keys', group: 'Memory' },
  { kind: 'voyage-key', name: 'Voyage API key', sub: 'Memory search: Voyage reranks what memory finds, pay per use.', how: 'key', placeholder: 'pa-...', link: 'https://dashboard.voyageai.com/api-keys', group: 'Memory' },
];
const PROVIDER_OF: Record<Kind, string> = { 'claude-token': 'claude-cli', 'anthropic-key': 'anthropic-api', 'openai-key': 'openai-api', 'xai-key': 'xai-api', 'chatgpt-plan': 'chatgpt-plan', 'grok-plan': 'grok-plan', 'openrouter-key': 'memory', 'voyage-key': 'memory' };

async function post(body: Record<string, unknown>) {
  const r = await fetch('/api/ai/connections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? 'Something went wrong.');
  return j;
}

export function AiConnectionsTab() {
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState<Kind | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [code, setCode] = useState<{ kind: Kind; user_code: string; url: string } | null>(null);
  const poll = useRef<number | null>(null);
  const [tgToken, setTgToken] = useState('');
  const [tgCode, setTgCode] = useState<{ code: string; bot: string } | null>(null);
  const [slackCode, setSlackCode] = useState('');
  const [claude, setClaude] = useState<{ url: string } | null>(null); // Sign in with Claude: the link, waiting for Claude's code
  const [claudeCode, setClaudeCode] = useState('');
  const [claudeAccount, setClaudeAccount] = useState('');
  const load = useCallback(() => fetch('/api/ai/connections').then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {}), []);
  useEffect(() => { void load(); return () => { if (poll.current) window.clearTimeout(poll.current); }; }, [load]);

  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await f(); setMsg({ ok: true, text: ok }); setOpen(null); setValue(''); await load(); }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const signIn = async (kind: Kind) => {
    setBusy(true); setMsg(null);
    try {
      const s = await post({ kind, action: 'start' });
      setCode({ kind, user_code: s.user_code, url: s.verification_url_complete || s.verification_url });
      const tick = async () => {
        const p = await post({ kind, action: 'poll' }).catch((e) => ({ state: 'denied', error: e.message }));
        if (p.state === 'pending') { poll.current = window.setTimeout(tick, (p.interval ?? 5) * 1000); return; }
        setCode(null); setBusy(false);
        if (p.state === 'done') { setMsg({ ok: true, text: 'Signed in.' }); await load(); } else setMsg({ ok: false, text: p.error ?? 'The sign-in stopped.' });
      };
      poll.current = window.setTimeout(tick, (s.interval ?? 5) * 1000);
    } catch (e) { setBusy(false); setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
  };

  if (!data) return <div className="h-48 animate-pulse rounded-[22px] bg-card shadow-[var(--card-shadow)]" />;
  const byKind = Object.fromEntries(data.connections.map((c) => [c.kind, c])) as Record<Kind, Conn>;
  return (
    <div className="flex flex-col gap-6">
      {msg && <div className={cn('flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-[13px]', msg.ok ? 'bg-healthy-bg text-healthy' : 'bg-weak-bg text-weak')}>{msg.ok ? <IconCircleCheck size={16} /> : <IconAlertTriangle size={16} />}{msg.text}</div>}
      {code && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-[13px]">
          <span>Enter this code at</span>
          <a href={code.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">{code.url.replace(/^https:\/\//, '')}<IconExternalLink size={13} /></a>
          <span className="rounded-md bg-inset px-2 py-1 font-mono text-[15px] font-semibold tracking-[0.2em]">{code.user_code}</span>
          <span className="text-muted-foreground">Waiting for you to approve...</span>
        </div>
      )}
      {['Subscriptions', 'API keys', 'Memory'].map((g) => (
        <Section key={g} description={g === 'Subscriptions' ? 'Run the AI on a plan you already pay for.' : g === 'Memory' ? 'Sharper memory search for every agent. Without these keys memory uses this server\'s own small models.' : 'Pay the provider per use instead.'} title={g} flush>
          <div className="divide-y divide-border border-y border-border">
            {ROWS.filter((r) => r.group === g).map((r) => {
              const c = byKind[r.kind]; const live = PROVIDER_OF[r.kind] === 'memory' ? !!c?.connected && c.status === 'ok' : data.available.includes(PROVIDER_OF[r.kind]);
              return (
                <div key={r.kind} className="flex flex-col">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 md:px-7">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-[13.5px] font-semibold">{r.name}
                        {live ? <span className="rounded-full bg-healthy-bg px-2 py-0.5 text-[11px] font-semibold text-healthy">Connected</span>
                          : c?.status === 'error' ? <span className="rounded-full bg-weak-bg px-2 py-0.5 text-[11px] font-semibold text-weak" title={c.detail}>Needs attention</span>
                          : c?.status === 'limited' ? <span className="rounded-full bg-watch-bg px-2 py-0.5 text-[11px] font-semibold text-watch" title={c.detail}>At its limit</span> : null}
                      </span>
                      <span className="block text-[11.5px] text-label">{c?.connected ? [c.account, c.last4 && `ending ${c.last4}`, c.models.length ? `${c.models.length} models` : ''].filter(Boolean).join(' · ') || r.sub : r.kind === 'claude-token' && live ? "Using this server's Claude login." : r.sub}</span>
                    </span>
                    {data.owner && (r.how === 'plan'
                      ? !c?.connected && <Button variant="outline" size="sm" disabled={busy} onClick={() => void signIn(r.kind)}>Sign in</Button>
                      : <>
                        {r.kind === 'claude-token' && <Button size="sm" disabled={busy} onClick={() => { setOpen(null); setClaudeCode(''); void run(async () => setClaude(await post({ kind: r.kind, action: 'start' })), 'Sign-in link ready: open it, sign in, paste the code below.'); }}>{busy && !claude ? 'Starting...' : c?.connected || live ? 'Reconnect with Claude' : 'Sign in with Claude'}</Button>}
                        <Button variant="outline" size="sm" onClick={() => { setOpen(open === r.kind ? null : r.kind); setValue(''); }}>{r.kind === 'claude-token' ? 'Paste token' : c?.connected ? 'Replace' : 'Connect'}</Button>
                      </>)}
                    {data.owner && c?.connected && (
                      <DropdownMenu>
                        <DropdownMenuTrigger aria-label={`More for ${r.name}`} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-inset hover:text-foreground"><IconDots size={16} /></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {r.how === 'plan' && <DropdownMenuItem onClick={() => void run(() => post({ kind: r.kind, action: 'refresh' }), 'Model list refreshed.')}>Refresh models</DropdownMenuItem>}
                          <DropdownMenuItem className="text-weak" onClick={() => void run(() => post({ kind: r.kind, action: 'remove' }), 'Disconnected.')}>Disconnect</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {r.kind === 'claude-token' && claude && (
                    <form className="flex flex-wrap items-center gap-2 bg-inset px-6 py-3 md:px-7" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post({ kind: r.kind, action: 'finish', key: claudeCode, account: claudeAccount }); setClaude(null); setClaudeCode(''); setClaudeAccount(''); }, 'Claude subscription connected. the AI runs on it now.'); }}>
                      <a href={claude.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-primary hover:underline">1. Open Claude sign-in<IconExternalLink size={13} /></a>
                      <Input autoFocus value={claudeCode} onChange={(e) => setClaudeCode(e.target.value)} placeholder="2. Paste the code Claude shows" aria-label="Code from Claude" className="h-8 min-w-64 flex-1 text-[12.5px]" />
                      <Input type="email" value={claudeAccount} onChange={(e) => setClaudeAccount(e.target.value)} placeholder="3. The Claude account's full email" required aria-label="Claude account email" className="h-8 min-w-56 flex-1 text-[12.5px]" />
                      <Button type="submit" size="sm" disabled={busy || claudeCode.trim().length < 6 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(claudeAccount.trim())}>{busy ? 'Connecting...' : 'Finish'}</Button>
                      <span className="w-full text-[11.5px] text-label">Sign in with the Claude account whose plan the AI should use, and type its email so everyone can see which plan the AI runs on. The link works for 10 minutes.</span>
                    </form>
                  )}
                  {open === r.kind && (
                    <form className="flex flex-wrap items-center gap-2 bg-inset px-6 py-3 md:px-7" onSubmit={(e) => { e.preventDefault(); void run(() => post({ kind: r.kind, action: 'save', key: value }), `${r.name} connected.`); }}>
                      <Input type="password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={r.placeholder} aria-label={r.name} className="h-8 min-w-64 flex-1 text-[12.5px]" />
                      <Button type="submit" size="sm" disabled={busy || value.trim().length < 20}>{busy ? 'Checking...' : 'Save'}</Button>
                      <span className="w-full text-[11.5px] text-label">
                        {r.how === 'token' ? <>On a computer signed in to Claude, run <code className="font-mono">claude setup-token</code> and paste what it prints.</> : <>Get one at <a href={r.link} target="_blank" rel="noreferrer" className="text-primary hover:underline">{r.link?.replace(/^https:\/\//, '')}</a>. It is checked once, then stored encrypted.</>}
                      </span>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      ))}

      {/* the agents on Telegram (D, 2026-10-09): the agency's bot; each person links their own chat with a code */}
      <Section title="Telegram" description="Talk to your agents from Telegram. Each person links their own chat; it answers as their login, with their access." flush>
        <div className="divide-y divide-border border-y border-border">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 md:px-7">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[13.5px] font-semibold">Agency bot{data.telegram?.connected && <span className="rounded-full bg-healthy-bg px-2 py-0.5 text-[11px] font-semibold text-healthy">@{data.telegram.username}</span>}</span>
              <span className="block text-[11.5px] text-label">{data.telegram?.connected ? (data.telegram.webhook ? 'Receiving messages.' : 'Saved, but Telegram cannot reach this app yet: set APP_URL to the public https address and connect again.') : 'Make a bot with @BotFather in Telegram and paste its token.'}</span>
            </span>
            {data.owner && (data.telegram?.connected
              ? <Button variant="ghost" size="sm" onClick={() => void run(() => post({ kind: 'telegram', action: 'disconnect' }), 'Bot disconnected.')}>Disconnect</Button>
              : <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await post({ kind: 'telegram', action: 'connect', key: tgToken }); setTgToken(''); if (r.note) throw new Error(r.note); }, 'Bot connected.'); }}>
                  <Input type="password" value={tgToken} onChange={(e) => setTgToken(e.target.value)} placeholder="123456:ABC..." aria-label="Bot token" className="h-8 w-64 text-[12.5px]" />
                  <Button type="submit" size="sm" variant="outline" disabled={busy || tgToken.length < 20}>Connect</Button>
                </form>)}
          </div>
          {data.telegram?.connected && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 md:px-7">
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-semibold">Your Telegram</span>
                <span className="block text-[11.5px] text-label">{tgCode ? <>Send <code className="rounded bg-inset px-1 font-mono">/link {tgCode.code}</code> to @{tgCode.bot} within 10 minutes.</> : data.telegram.linked ? `Linked (${data.telegram.linked} chat${data.telegram.linked === 1 ? '' : 's'}).` : 'Not linked yet.'}</span>
              </span>
              <Button variant="outline" size="sm" onClick={() => void post({ kind: 'telegram', action: 'link-code' }).then(setTgCode).catch((e) => setMsg({ ok: false, text: e.message }))}>{data.telegram.linked ? 'Link another chat' : 'Link my Telegram'}</Button>
              {data.telegram.linked > 0 && <Button variant="ghost" size="sm" onClick={() => void run(() => post({ kind: 'telegram', action: 'unlink' }), 'Unlinked.')}>Unlink</Button>}
            </div>
          )}
        </div>
      </Section>

      {/* the agents in Slack: DM the bot or mention it in a channel; each person links once */}
      <Section title="Slack" description="DM the agency's Slack bot, or mention it in a channel and it answers in the thread. It answers as your login, with your access. Connect the bot in Settings › Agency › Agency tools › Slack." flush>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border px-6 py-3 md:px-7">
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold">Your Slack</span>
            <span className="block text-[11.5px] text-label">{slackCode ? <>DM <code className="rounded bg-inset px-1 font-mono">link {slackCode}</code> to the agency's Slack bot in a DM within 10 minutes.</> : 'If your Slack email is not your login here, link once with a code.'}</span>
          </span>
          <Button variant="outline" size="sm" onClick={() => void post({ kind: 'slack', action: 'link-code' }).then((r) => setSlackCode(r.code)).catch((e) => setMsg({ ok: false, text: e.message }))}>Link my Slack</Button>
        </div>
      </Section>

      {/* WhatsApp numbers for agents (D, 2026-10-28), owners and admins only: components/settings/wa-section.tsx */}
      <WaSection />
    </div>
  );
}
