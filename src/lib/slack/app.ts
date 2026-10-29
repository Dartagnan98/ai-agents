import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { db } from '@/lib/db';
import { installSecret } from '@/lib/location-id';
import { agencySecret, setAgencySecrets } from '@/lib/agency-secrets';
import { appUrl } from '@/lib/accounts/config';
import { isMultiTenant } from '@/lib/platform/mode';
import { getAgency, platformDb } from '@/lib/platform/db';
import { runWithTenant } from '@/lib/platform/context';
import { currentAgencySync } from '@/lib/platform/tenant-db';

// The AI Agents Slack app (D, 2026-10-10, docs/SLACK_APP.md). ONE app (platform env SLACK_CLIENT_ID / SLACK_CLIENT_SECRET /
// SLACK_SIGNING_SECRET) that each agency installs into its own workspace with "Add to Slack". The bot token is the agency's secret
// (setAgencySecrets, sealed per agency); the workspace -> agency map lives in platform.db (`slack_installs`, single-agency mode: the
// app SQLite) so Events API calls, which carry only a team id, find their agency. One workspace = one agency.

export const SLACK_SCOPES = ['app_mentions:read', 'channels:history', 'channels:read', 'groups:history', 'groups:read', 'chat:write', 'chat:write.customize', 'reactions:write',
  'im:write', 'im:history', 'users:read', 'users:read.email'];
const SINGLE = 'single'; // the agency id of a single-agency install (one agency, no platform.db)

export interface SlackAppConfig { clientId: string; clientSecret: string; signingSecret: string }
/** The platform's Slack app, or null when any of the three is missing (then the Connect button is hidden). */
export function slackAppConfig(env: NodeJS.ProcessEnv = process.env): SlackAppConfig | null {
  const clientId = (env.SLACK_CLIENT_ID ?? '').trim(), clientSecret = (env.SLACK_CLIENT_SECRET ?? '').trim(), signingSecret = (env.SLACK_SIGNING_SECRET ?? '').trim();
  return clientId && clientSecret && signingSecret ? { clientId, clientSecret, signingSecret } : null;
}
export const redirectUri = (env: NodeJS.ProcessEnv = process.env) => { const base = appUrl(null, env); return base ? `${base}/api/slack/oauth` : null; };

/** The agency-level secret name the bot token is saved under. Agencies: SLACK_BOT_TOKEN, the name the sync worker's `slack` job already
 *  reads (so polling works off the same install). The legacy agency (the agency): SLACK_APP_BOT_TOKEN, so its ctrl-fleet.env SLACK_BOT_TOKEN
 *  (its box jobs' bot) is never overwritten. */
export const tokenName = () => 'SLACK_BOT_TOKEN';
/** The current agency's bot token ('' when not connected). */
export const botToken = () => agencySecret(tokenName()).trim();
/** The current agency's id for the map ('single' in single-agency mode). */
export const agencyIdNow = () => (isMultiTenant() ? currentAgencySync().id : SINGLE);
/** Runs fn as that agency (multi-agency mode); single mode has only one. */
export function asAgency<T>(agencyId: string, fn: () => T): T {
  return isMultiTenant() && agencyId !== SINGLE ? runWithTenant(agencyId, fn) : fn();
}
/** Whether that agency is the legacy one (the agency, or the single-agency install). */
export const isLegacyId = (agencyId: string) => agencyId === SINGLE || !isMultiTenant() || !!getAgency(agencyId)?.legacy;

// ─── request signature (Slack signing secret, v0) ───
/** True when X-Slack-Signature matches v0:timestamp:body (HMAC-SHA256, signing secret) and the timestamp is within 5 minutes. */
export function verifySlackSignature(secret: string, timestamp: string | null, body: string, signature: string | null, now = Date.now()): boolean {
  if (!secret || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const want = Buffer.from(`v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`);
  const got = Buffer.from(signature);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ─── OAuth state (agency + login + nonce, 10 minutes, HMAC with the install secret) ───
const STATE_MS = 10 * 60_000;
const stateSig = (body: string, secret: string) => crypto.createHmac('sha256', secret).update(`ctrlos-slack-state v1:${body}`).digest('base64url');
export function signState(agencyId: string, userId: number, now = Date.now(), secret = installSecret()): { state: string; nonce: string } {
  const nonce = crypto.randomBytes(12).toString('base64url');
  const body = Buffer.from(JSON.stringify({ a: agencyId, u: userId, n: nonce, e: now + STATE_MS })).toString('base64url');
  return { state: `${body}.${stateSig(body, secret)}`, nonce };
}
export function readState(state: string | null, now = Date.now(), secret = installSecret()): { agencyId: string; userId: number; nonce: string } | null {
  const m = /^([A-Za-z0-9_-]{10,400})\.([A-Za-z0-9_-]{43})$/.exec(state ?? '');
  if (!m) return null;
  const want = Buffer.from(stateSig(m[1], secret)), got = Buffer.from(m[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try {
    const v = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf-8')) as { a?: string; u?: number; n?: string; e?: number };
    if (typeof v.a !== 'string' || !(v.a === SINGLE || /^agc_[0-9A-Za-z]{20}$/.test(v.a)) || !Number.isInteger(v.u) || typeof v.n !== 'string' || !(Number(v.e) > now)) return null;
    return { agencyId: v.a, userId: v.u!, nonce: v.n };
  } catch { return null; }
}

/** Slack's "Add to Slack" address for this state. */
export function authorizeUrl(cfg: SlackAppConfig, state: string, redirect: string): string {
  const q = new URLSearchParams({ client_id: cfg.clientId, scope: SLACK_SCOPES.join(','), redirect_uri: redirect, state });
  return `https://slack.com/oauth/v2/authorize?${q}`;
}

// ─── workspace -> agency map ───
export interface SlackInstall { teamId: string; agencyId: string; teamName: string; botUserId: string; appId: string; status: 'active' | 'disconnected'; installedBy: number | null; installedAt: number; updatedAt: number }
function mapDb(): Database.Database {
  const d = isMultiTenant() ? platformDb() : (db as unknown as Database.Database);
  d.exec(`CREATE TABLE IF NOT EXISTS slack_installs (
    team_id TEXT PRIMARY KEY, agency_id TEXT NOT NULL, team_name TEXT NOT NULL DEFAULT '', bot_user_id TEXT NOT NULL DEFAULT '', app_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active', installed_by INTEGER, installed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_slack_installs_agency ON slack_installs(agency_id);`);
  return d;
}
type Row = { team_id: string; agency_id: string; team_name: string; bot_user_id: string; app_id: string; status: string; installed_by: number | null; installed_at: number; updated_at: number };
const installOf = (r: Row): SlackInstall => ({ teamId: r.team_id, agencyId: r.agency_id, teamName: r.team_name, botUserId: r.bot_user_id, appId: r.app_id,
  status: r.status === 'active' ? 'active' : 'disconnected', installedBy: r.installed_by, installedAt: r.installed_at, updatedAt: r.updated_at });

export function installForTeam(teamId: string): SlackInstall | null {
  const r = mapDb().prepare('SELECT * FROM slack_installs WHERE team_id = ?').get(teamId) as Row | undefined;
  return r ? installOf(r) : null;
}
/** The agency's live install (one at a time). */
export function installForAgency(agencyId: string): SlackInstall | null {
  const r = mapDb().prepare(`SELECT * FROM slack_installs WHERE agency_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`).get(agencyId) as Row | undefined;
  return r ? installOf(r) : null;
}

/** Records a workspace for an agency. Refuses a workspace that is live for another agency. A new workspace replaces the agency's old one. */
export function claimTeam(agencyId: string, t: { teamId: string; teamName: string; botUserId: string; appId: string }, by: number | null, now = Date.now()): { ok: true } | { ok: false; error: string } {
  if (!/^T[A-Z0-9]{2,30}$/.test(t.teamId)) return { ok: false, error: 'Slack did not say which workspace this is.' };
  const d = mapDb();
  return d.transaction(() => {
    const cur = d.prepare('SELECT * FROM slack_installs WHERE team_id = ?').get(t.teamId) as Row | undefined;
    if (cur && cur.status === 'active' && cur.agency_id !== agencyId) {
      return { ok: false as const, error: `The Slack workspace "${cur.team_name || t.teamName}" is already connected to another install. One workspace can serve one agency: disconnect it there first.` };
    }
    d.prepare(`DELETE FROM slack_installs WHERE agency_id = ? AND team_id <> ?`).run(agencyId, t.teamId);
    d.prepare(`INSERT INTO slack_installs (team_id, agency_id, team_name, bot_user_id, app_id, status, installed_by, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      ON CONFLICT(team_id) DO UPDATE SET agency_id = excluded.agency_id, team_name = excluded.team_name, bot_user_id = excluded.bot_user_id, app_id = excluded.app_id,
        status = 'active', installed_by = excluded.installed_by, installed_at = excluded.installed_at, updated_at = excluded.updated_at`)
      .run(t.teamId, agencyId, t.teamName.slice(0, 120), t.botUserId, t.appId, by, now, now);
    return { ok: true as const };
  }).immediate();
}
export function markDisconnected(teamId: string, now = Date.now()): void {
  mapDb().prepare(`UPDATE slack_installs SET status = 'disconnected', updated_at = ? WHERE team_id = ?`).run(now, teamId);
}
export function dropTeam(teamId: string): void {
  mapDb().prepare('DELETE FROM slack_installs WHERE team_id = ?').run(teamId);
}

// ─── Slack Web API ───
export type SlackFetch = typeof fetch;
/** One Web API call (form-encoded for oauth.*, JSON otherwise). Never throws: { ok: false, error } on any failure. */
export async function slackApi(method: string, opts: { token?: string; json?: Record<string, unknown>; form?: Record<string, string> }, f: SlackFetch = fetch): Promise<Record<string, unknown> & { ok: boolean; error?: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string;
  if (opts.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(opts.form).toString(); }
  else { headers['Content-Type'] = 'application/json; charset=utf-8'; body = JSON.stringify(opts.json ?? {}); }
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await f(`https://slack.com/api/${method}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
      const j = await r.json().catch(() => null) as (Record<string, unknown> & { ok?: boolean; error?: string }) | null;
      // rate limited = nothing was done: wait what Slack asks (max 30 s) and try again, twice
      if (j?.error === 'ratelimited' && attempt < 2) { await new Promise((ok) => setTimeout(ok, Math.min(30, Number(r.headers?.get?.('retry-after')) || 5) * 1000)); continue; }
      if (!j) return { ok: false, error: `http_${r.status}` };
      return { ...j, ok: j.ok === true };
    }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** The OAuth callback's work: exchange the code, then save the token for the state's agency and claim the workspace. */
export async function finishInstall(code: string, state: { agencyId: string; userId: number }, f: SlackFetch = fetch): Promise<{ ok: true; teamName: string } | { ok: false; error: string }> {
  const cfg = slackAppConfig(), redirect = redirectUri();
  if (!cfg || !redirect) return { ok: false, error: 'The Slack app is not set up on this server (SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET, APP_URL).' };
  if (state.agencyId !== SINGLE && isMultiTenant()) { const a = getAgency(state.agencyId); if (!a || a.status !== 'active') return { ok: false, error: 'That agency is not active.' }; }
  const r = await slackApi('oauth.v2.access', { form: { client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: redirect } }, f);
  const token = typeof r.access_token === 'string' ? r.access_token : '';
  const team = (r.team ?? {}) as { id?: string; name?: string };
  if (!r.ok || !/^xoxb-/.test(token) || !team.id) return { ok: false, error: `Slack did not finish the install (${r.error ?? 'no bot token'}).` };
  const t = { teamId: team.id, teamName: String(team.name ?? ''), botUserId: String(r.bot_user_id ?? ''), appId: String(r.app_id ?? '') };
  const claimed = claimTeam(state.agencyId, t, state.userId);
  if (!claimed.ok) {
    await slackApi('auth.revoke', { token }, f); // we will not use it: give it back
    return claimed;
  }
  asAgency(state.agencyId, () => setAgencySecrets({ [tokenName()]: token }, state.userId));
  return { ok: true, teamName: t.teamName };
}

/** Forgets the current agency's bot token (app_uninstalled / tokens_revoked: Slack already killed it). */
export const setTokenCleared = () => setAgencySecrets({ [tokenName()]: '' });

/** Disconnect button: give the token back to Slack, forget it and the workspace. Current agency. */
export async function disconnectSlack(f: SlackFetch = fetch): Promise<void> {
  const id = agencyIdNow(), inst = installForAgency(id), token = botToken();
  if (token) await slackApi('auth.revoke', { token }, f);
  if (token || inst) setAgencySecrets({ [tokenName()]: '' });
  if (inst) dropTeam(inst.teamId);
}

/** What Settings › Agency shows: whether the app is on this server, and the agency's connected workspace. */
export function slackAppStatus(): { available: boolean; team: string | null } {
  let team: string | null = null;
  try { const i = installForAgency(agencyIdNow()); team = i ? (i.teamName || i.teamId) : null; } catch { team = null; }
  return { available: !!slackAppConfig() && !!redirectUri(), team };
}
