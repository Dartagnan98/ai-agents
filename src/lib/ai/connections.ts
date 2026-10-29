import 'server-only';
import { db } from '@/lib/db';
import { seal, unseal } from '@/lib/secret-crypto';
import { schemaOnce } from '@/lib/schema-once';
import fs from 'fs';
import { encPath, sealEnvText, unsealEnvText } from '@/lib/env-store';
import { claudeLoginFiles } from '@/lib/paths';
import { isMultiTenant } from '@/lib/platform/mode';
import { currentAgencySync } from '@/lib/platform/tenant-db';

// AI connections (D, 2026-10-09: "Claude can be a connector, or the GPT / Grok subscriptions, or their own API key"). The agency
// connects its AI once in Settings › AI connections; every agent and the chat use whatever is connected. Agency-wide (the owner
// manages them), sealed at rest (lib/secret-crypto). Kinds:
//   claude-token   a Claude subscription token for headless runs (`claude setup-token`), used before the box's own login
//   anthropic-key / openai-key / xai-key   API keys (pay per use)
//   chatgpt-plan / grok-plan   EXPERIMENTAL plan sign-in with a device code, the same OAuth clients the official Codex and Grok CLIs
//              use (lib/agents/plan-auth.ts, after Hermes Agent, MIT, Nous Research). OpenAI or xAI may restrict this.
//   openrouter-key / voyage-key   memory only (D, 2026-10-28, the agency's own keys): OpenAI 3-large embeddings through OpenRouter and Voyage
//              rerank for team memory and the graph (lib/ai/embed-local.ts). Without them memory runs on the local models.
export type ConnKind = 'claude-token' | 'anthropic-key' | 'openai-key' | 'xai-key' | 'chatgpt-plan' | 'grok-plan' | 'openrouter-key' | 'voyage-key';
export const CONN_KINDS: ConnKind[] = ['claude-token', 'anthropic-key', 'openai-key', 'xai-key', 'chatgpt-plan', 'grok-plan', 'openrouter-key', 'voyage-key'];
export const isConnKind = (v: unknown): v is ConnKind => CONN_KINDS.includes(v as ConnKind);

const ready = schemaOnce(); // per agency database (D, 2026-10-09)
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_connections (
    kind TEXT PRIMARY KEY, secret TEXT, status TEXT NOT NULL DEFAULT 'ok', detail TEXT NOT NULL DEFAULT '', last4 TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '', models TEXT NOT NULL DEFAULT '[]', pending TEXT, pending_until INTEGER,
    updated_by INTEGER, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
  ready.mark();
}
interface Row { kind: ConnKind; secret: string | null; status: string; detail: string; last4: string; account: string; plan: string; models: string; pending: string | null; pending_until: number | null }
const row = (k: ConnKind) => { ensure(); return db.prepare('SELECT * FROM ai_connections WHERE kind = ?').get(k) as Row | undefined; };
const now = () => Math.floor(Date.now() / 1000);

/** What Settings shows: never a secret. */
export interface ConnStatus { kind: ConnKind; connected: boolean; status: string; detail: string; last4: string; account: string; plan: string; models: string[] }
export function listConnections(): ConnStatus[] {
  return CONN_KINDS.map((kind) => {
    const r = row(kind);
    let models: string[] = []; try { models = JSON.parse(r?.models || '[]'); } catch { /* none */ }
    return { kind, connected: !!r?.secret, status: r?.secret ? r.status : '', detail: r?.detail ?? '', last4: r?.last4 ?? '', account: r?.account ?? '', plan: r?.plan ?? '', models };
  });
}
export function connSecret(kind: ConnKind): string | null {
  const r = row(kind);
  if (!r?.secret) return null;
  try { return unseal(r.secret); } catch { return null; }
}
function put(kind: ConnKind, fields: Partial<Omit<Row, 'kind'>>, by: number | null) {
  ensure();
  db.prepare(`INSERT INTO ai_connections (kind, updated_by) VALUES (?, ?) ON CONFLICT(kind) DO NOTHING`).run(kind, by);
  const keys = Object.keys(fields);
  if (keys.length) db.prepare(`UPDATE ai_connections SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE kind = ?`)
    .run(...keys.map((k) => (fields as Record<string, unknown>)[k] ?? null), by, kind);
}
export function removeConnection(kind: ConnKind) { ensure(); db.prepare('DELETE FROM ai_connections WHERE kind = ?').run(kind); }
export function markConnection(kind: ConnKind, status: 'ok' | 'error' | 'limited', detail = '') { if (row(kind)) put(kind, { status, detail: detail.slice(0, 300) }, null); }

// ─── API keys + Claude token ───
const KEY_CHECK: Record<'anthropic-key' | 'openai-key' | 'xai-key' | 'openrouter-key' | 'voyage-key', (k: string) => Promise<Response>> = {
  'openrouter-key': (k) => fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(12_000) }),
  // Voyage has no read-only key check: the smallest real call (a 1-document rerank, a fraction of a cent)
  'voyage-key': (k) => fetch('https://api.voyageai.com/v1/rerank', { method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'rerank-2.5', query: 'check', documents: ['check'] }), signal: AbortSignal.timeout(12_000) }),
  'anthropic-key': (k) => fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(12_000) }),
  'openai-key': (k) => fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(12_000) }),
  'xai-key': (k) => fetch('https://api.x.ai/v1/models', { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(12_000) }),
};
/** Saves a key after one read-only check with the provider (lists its models). */
export async function saveKey(kind: 'anthropic-key' | 'openai-key' | 'xai-key' | 'openrouter-key' | 'voyage-key' | 'claude-token', raw: string, by: number, account = ''): Promise<{ ok: boolean; error?: string }> {
  const k = raw.trim();
  if (k.length < 20 || /\s/.test(k)) return { ok: false, error: 'That does not look like a key.' };
  if (kind === 'claude-token') {
    if (!/^sk-ant-oat/.test(k)) return { ok: false, error: 'Paste the token `claude setup-token` prints (it starts with sk-ant-oat).' };
    // the token only runs the AI (its profile read is refused, 403), so which Claude account it is comes from the person signing in
    put(kind, { secret: seal(k), last4: k.slice(-4), status: 'ok', detail: '', account: account.trim().slice(0, 200) }, by);
    replaceBoxLogin(k);
    return { ok: true };
  }
  const res = await KEY_CHECK[kind](k).catch(() => null);
  if (!res) return { ok: false, error: 'Could not reach the provider to check the key. Try again.' };
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'The provider did not accept that key.' };
  let models: string[] = [];
  try { const j = await res.json() as { data?: { id: string }[] }; models = (j.data ?? []).map((m) => m.id).slice(0, 80); } catch { /* fine */ }
  put(kind, { secret: seal(k), last4: k.slice(-4), status: res.ok ? 'ok' : 'error', detail: res.ok ? '' : `Check returned ${res.status}`, models: JSON.stringify(models) }, by);
  return { ok: true };
}

/** A new Claude sign-in replaces the box's own login too (D, 2026-10-15: "it should replace it"): the token goes into the first login
 *  file (CLAUDE_LOGIN_ENV_FILES, the agency's scorer.env), which call scoring (fleet-sync sync.py agent_env) and the app's fallback read, so
 *  one sign-in moves everything onto the new plan. Only the install's own agency (the agency): another agency never writes the box's files.
 *  The rest of the file is kept; a failed write leaves the app on its Settings token and never fails the sign-in. */
export function replaceBoxLogin(token: string) {
  try {
    if (isMultiTenant() && !currentAgencySync().legacy) return;
    const file = claudeLoginFiles()[0];
    if (!file) return;
    // sealed when the box keeps it sealed (<file>.enc, as the agency's scorer.env since 2026-10-12), whatever the app's own env-store switch
    const enc = encPath(file), sealed = fs.existsSync(enc);
    let text = '';
    try { text = sealed ? unsealEnvText(fs.readFileSync(enc, 'utf-8')) : fs.readFileSync(file, 'utf-8'); } catch (e) { if (sealed) throw e; /* no file yet */ }
    const lines = text.split('\n').filter((l) => !/^\s*(export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=/.test(l));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const out = `${[...lines, `CLAUDE_CODE_OAUTH_TOKEN=${token}`].join('\n')}\n`;
    const target = sealed ? enc : file, tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, sealed ? sealEnvText(out) : out, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (e) { console.error('[ai] could not update the box Claude login:', (e as Error)?.message); }
}

// ─── Plan sign-in (EXPERIMENTAL) ───
export type PlanKind = 'chatgpt-plan' | 'grok-plan';
const UA = 'CTRL-OS/1.0';
const CODEX_ISSUER = 'https://auth.openai.com', CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`, CODEX_VERIFY_URL = `${CODEX_ISSUER}/codex/device`;
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const XAI_ISSUER = 'https://auth.x.ai', XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const XAI_BASE_URL = 'https://api.x.ai/v1';
const FALLBACK: Record<PlanKind, string[]> = { 'chatgpt-plan': ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'], 'grok-plan': ['grok-4.7', 'grok-4.3', 'grok-build-0.1'] };
interface Tokens { access_token: string; refresh_token: string; id_token?: string }
interface Pending { user_code: string; interval: number; last_poll: number; device_code?: string; device_auth_id?: string }
const postJson = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
const postForm = (url: string, form: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': UA }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(20_000) });
const claims = (t?: string): Record<string, unknown> => { try { return t && t.split('.').length === 3 ? JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8')) : {}; } catch { return {}; } };
const expOf = (t: string) => { const e = claims(t).exp; return typeof e === 'number' ? e : null; };
export const chatgptAccountId = (t: string) => { const a = claims(t)['https://api.openai.com/auth'] as Record<string, unknown> | undefined; return typeof a?.chatgpt_account_id === 'string' ? a.chatgpt_account_id : null; };

export async function startPlanSignIn(kind: PlanKind, by: number): Promise<{ user_code: string; verification_url: string; verification_url_complete: string | null; interval: number; expires_in: number }> {
  let pending: Pending, out;
  if (kind === 'chatgpt-plan') {
    const res = await postJson(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, { client_id: CODEX_CLIENT_ID }).catch(() => null);
    if (!res?.ok) throw new Error(`OpenAI did not start the sign-in${res ? ` (${res.status})` : ''}. Try again.`);
    const d = await res.json().catch(() => ({})) as { user_code?: string; usercode?: string; device_auth_id?: string; interval?: string | number };
    const code = d.user_code || d.usercode;
    if (!code || !d.device_auth_id) throw new Error('OpenAI answered without a sign-in code. Try again.');
    const interval = Math.max(3, Number(d.interval) || 5);
    pending = { user_code: code, device_auth_id: d.device_auth_id, interval, last_poll: 0 };
    out = { user_code: code, verification_url: CODEX_VERIFY_URL, verification_url_complete: null, interval, expires_in: 15 * 60 };
  } else {
    const res = await postForm(`${XAI_ISSUER}/oauth2/device/code`, { client_id: XAI_CLIENT_ID, scope: XAI_SCOPE }).catch(() => null);
    if (!res?.ok) throw new Error(`xAI did not start the sign-in${res ? ` (${res.status})` : ''}. Try again.`);
    const d = await res.json().catch(() => ({})) as { device_code?: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string; expires_in?: number; interval?: number };
    if (!d.device_code || !d.user_code || !d.verification_uri) throw new Error('xAI answered without a sign-in code. Try again.');
    const interval = Math.max(1, Number(d.interval) || 5);
    pending = { user_code: d.user_code, device_code: d.device_code, interval, last_poll: 0 };
    out = { user_code: d.user_code, verification_url: d.verification_uri, verification_url_complete: d.verification_uri_complete || null, interval, expires_in: Number(d.expires_in) || 600 };
  }
  put(kind, { pending: seal(JSON.stringify(pending)), pending_until: now() + out.expires_in }, by);
  return out;
}

export type PollResult = { state: 'pending'; interval: number } | { state: 'done' } | { state: 'expired' | 'denied' | 'none'; error: string };
export async function pollPlanSignIn(kind: PlanKind, by: number): Promise<PollResult> {
  const r = row(kind);
  if (!r?.pending) return { state: 'none', error: 'No sign-in is open. Start again.' };
  const clear = () => { if (!r.secret) removeConnection(kind); else put(kind, { pending: null, pending_until: null }, by); };
  if (r.pending_until && r.pending_until < now()) { clear(); return { state: 'expired', error: 'The code expired before it was approved. Start again.' }; }
  let p: Pending; try { p = JSON.parse(unseal(r.pending)); } catch { clear(); return { state: 'none', error: 'The sign-in could not be read. Start again.' }; }
  if (Date.now() - p.last_poll < p.interval * 1000 - 300) return { state: 'pending', interval: p.interval };
  p.last_poll = Date.now();
  const keep = () => put(kind, { pending: seal(JSON.stringify(p)) }, by);
  let tokens: Tokens | null = null;
  try {
    if (kind === 'chatgpt-plan') {
      const res = await postJson(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, { device_auth_id: p.device_auth_id, user_code: p.user_code });
      if (res.status === 403 || res.status === 404) { keep(); return { state: 'pending', interval: p.interval }; }
      if (res.status === 429) { p.interval = Math.min(p.interval + 2, 30); keep(); return { state: 'pending', interval: p.interval }; }
      if (!res.ok) { clear(); return { state: 'denied', error: `OpenAI stopped the sign-in (${res.status}).` }; }
      const c = await res.json().catch(() => ({})) as { authorization_code?: string; code_verifier?: string };
      if (!c.authorization_code || !c.code_verifier) { clear(); return { state: 'denied', error: 'OpenAI approved but sent no code. Start again.' }; }
      const ex = await postForm(CODEX_TOKEN_URL, { grant_type: 'authorization_code', code: c.authorization_code, redirect_uri: `${CODEX_ISSUER}/deviceauth/callback`, client_id: CODEX_CLIENT_ID, code_verifier: c.code_verifier });
      const t = await ex.json().catch(() => ({})) as Partial<Tokens>;
      if (!ex.ok || !t.access_token || !t.refresh_token) { clear(); return { state: 'denied', error: `OpenAI did not hand over the sign-in (${ex.status}).` }; }
      tokens = { access_token: t.access_token, refresh_token: t.refresh_token, id_token: t.id_token };
    } else {
      const res = await postForm(`${XAI_ISSUER}/oauth2/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: XAI_CLIENT_ID, device_code: p.device_code || '' });
      const d = await res.json().catch(() => ({})) as Partial<Tokens> & { error?: string; error_description?: string };
      if (res.ok && d.access_token && d.refresh_token) tokens = { access_token: d.access_token, refresh_token: d.refresh_token, id_token: d.id_token };
      else if (d.error === 'authorization_pending') { keep(); return { state: 'pending', interval: p.interval }; }
      else if (d.error === 'slow_down') { p.interval = Math.min(p.interval + 1, 30); keep(); return { state: 'pending', interval: p.interval }; }
      else { clear(); return { state: d.error === 'expired_token' ? 'expired' : 'denied', error: `xAI stopped the sign-in: ${String(d.error_description || d.error || res.status).slice(0, 160)}` }; }
    }
  } catch { keep(); return { state: 'pending', interval: p.interval }; }
  const id = claims(tokens.id_token), acc = claims(tokens.access_token);
  const email = typeof id.email === 'string' ? id.email : typeof acc.email === 'string' ? acc.email : '';
  put(kind, { secret: seal(JSON.stringify(tokens)), status: 'ok', detail: '', account: email, pending: null, pending_until: null, last4: '' }, by);
  await refreshPlanModels(kind).catch(() => {});
  return { state: 'done' };
}

const refreshing = new Map<PlanKind, Promise<Tokens>>();
/** The plan's access token, renewed shortly before it expires (rotated refresh tokens are kept). */
export async function planCredential(kind: PlanKind, force = false): Promise<{ token: string; accountId: string | null; baseUrl: string }> {
  const read = (): Tokens | null => { const s = connSecret(kind); try { return s ? JSON.parse(s) as Tokens : null; } catch { return null; } };
  if (!read()) throw new Error(`${kind === 'chatgpt-plan' ? 'ChatGPT' : 'SuperGrok'} is not connected. Sign in under Settings › AI connections.`);
  const job = refreshing.get(kind) ?? (async () => {
    const t = read()!;
    const exp = expOf(t.access_token);
    if (!force && exp && exp > now() + 120) return t;
    const res = await (kind === 'chatgpt-plan'
      ? postForm(CODEX_TOKEN_URL, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CODEX_CLIENT_ID })
      : postForm(`${XAI_ISSUER}/oauth2/token`, { grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: XAI_CLIENT_ID })).catch(() => null);
    if (!res) { if (exp && exp > now() + 30) return t; throw new Error('Could not reach the provider to renew the sign-in.'); }
    const d = await res.json().catch(() => ({})) as Partial<Tokens>;
    if (!res.ok || !d.access_token) {
      if ([400, 401, 403].includes(res.status)) { put(kind, { secret: null, status: 'error', detail: 'The sign-in ended. Sign in again.' }, null); throw new Error('The plan sign-in ended. Sign in again under Settings › AI connections.'); }
      throw new Error(`Could not renew the plan sign-in (${res.status}).`);
    }
    const next = { access_token: d.access_token, refresh_token: d.refresh_token || t.refresh_token, id_token: d.id_token || t.id_token };
    put(kind, { secret: seal(JSON.stringify(next)) }, null);
    return next;
  })();
  refreshing.set(kind, job);
  try {
    const t = await job;
    return { token: t.access_token, accountId: kind === 'chatgpt-plan' ? chatgptAccountId(t.access_token) : null, baseUrl: kind === 'chatgpt-plan' ? CODEX_BASE_URL : XAI_BASE_URL };
  } finally { refreshing.delete(kind); }
}
export function planHeaders(kind: PlanKind, c: { token: string; accountId: string | null }, sessionId?: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': UA };
  if (kind === 'chatgpt-plan') { h.originator = 'ctrl-os'; if (c.accountId) h['ChatGPT-Account-ID'] = c.accountId; if (sessionId) h.session_id = sessionId; }
  else if (sessionId) h['x-grok-conv-id'] = sessionId;
  return h;
}
export async function refreshPlanModels(kind: PlanKind): Promise<string[]> {
  const c = await planCredential(kind);
  let list: string[] = [];
  if (kind === 'chatgpt-plan') {
    const h: Record<string, string> = { Authorization: `Bearer ${c.token}`, Accept: 'application/json', 'User-Agent': UA };
    if (c.accountId) h['ChatGPT-Account-Id'] = c.accountId;
    const res = await fetch(`${CODEX_BASE_URL}/models?client_version=1.0.0`, { headers: h, signal: AbortSignal.timeout(12_000) }).catch(() => null);
    const d = res?.ok ? await res.json().catch(() => ({})) as { models?: { slug?: string; visibility?: string; priority?: number }[] } : {};
    list = (d.models ?? []).filter((m) => m.slug && !/^(hide|hidden)$/i.test(m.visibility || '')).sort((a, b) => (a.priority ?? 1e4) - (b.priority ?? 1e4)).map((m) => m.slug!);
  } else {
    const res = await fetch(`${XAI_BASE_URL}/models`, { headers: { Authorization: `Bearer ${c.token}`, 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) }).catch(() => null);
    const d = res?.ok ? await res.json().catch(() => ({})) as { data?: { id: string }[] } : {};
    list = (d.data ?? []).map((m) => m.id).filter((id) => /^grok-/.test(id) && !/imagine|image|video/.test(id));
  }
  const models = list.length ? list : FALLBACK[kind];
  put(kind, { models: JSON.stringify(models.slice(0, 40)) }, null);
  return models;
}
export async function planSignOut(kind: PlanKind) {
  const s = connSecret(kind);
  if (s) {
    try {
      const t = JSON.parse(s) as Tokens;
      const [url, client] = kind === 'chatgpt-plan' ? [`${CODEX_ISSUER}/api/accounts/oauth/revoke`, CODEX_CLIENT_ID] : [`${XAI_ISSUER}/oauth2/revoke`, XAI_CLIENT_ID];
      await postForm(url, { token: t.refresh_token, token_type_hint: 'refresh_token', client_id: client }).catch(() => null);
    } catch { /* nothing to revoke */ }
  }
  removeConnection(kind);
}
