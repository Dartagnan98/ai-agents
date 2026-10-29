import { execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Composio through its CLI (2026-09-29, D: "clients bring their own key", "show the icons of apps"). The
// server is signed in once (`composio login` as the user the dashboard runs as); that sign-in holds every
// linked app, and the fleet agents on the box use the same apps through the Composio plugin. The dashboard
// lists apps, mints hosted-auth links and starts the sign-in; it never sees tokens.
// ponytail: CLI, not the REST API. The CLI sign-in key is not a project API key and the REST path needs
// one; switch to fetch() against backend.composio.dev if per-business user ids are ever needed.
const DIR = process.env.COMPOSIO_HOME || path.join(os.homedir(), '.composio');
const CLI = process.env.COMPOSIO_CLI || path.join(DIR, 'composio');
export const SLUG = /^[a-z0-9_]{2,40}$/;
export const logoUrl = (slug: string) => `https://logos.composio.dev/api/${slug}`;

export interface Conn { status: string; word_id?: string; alias?: string | null }
export type ConnStatus = 'ACTIVE' | 'INITIALIZING' | 'EXPIRED' | 'FAILED' | 'NONE';
export interface App { slug: string; name: string; description: string; tools: number; auth: string[] }

const readJson = (file: string): unknown => { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; } };
export const composioInstalled = (): boolean => fs.existsSync(CLI);
/** Signed in = a user key in user_data.json (a pending login writes the file with api_key null). */
export function signedIn(): boolean {
  const u = readJson(path.join(DIR, 'user_data.json')) as { api_key?: unknown } | null;
  return typeof u?.api_key === 'string' && u.api_key.length > 0;
}

const ENV = () => ({ ...process.env, NO_COLOR: '1', CI: '1' });
function run(args: string[], timeout = 25_000, env: NodeJS.ProcessEnv = ENV()): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(CLI, args, { timeout, maxBuffer: 8_000_000, env }, (err, stdout) =>
      err ? reject(new Error(`composio ${args[0]} did not answer`)) : resolve(String(stdout)));
  });
}

/** The CLI decorates output; keep the JSON value (object or array) only. */
function jsonIn(text: string, open = '{', close = '}'): unknown {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const a = clean.indexOf(open), b = clean.lastIndexOf(close);
  if (a < 0 || b < a) return null;
  try { return JSON.parse(clean.slice(a, b + 1)); } catch { return null; }
}

/** `composio connections list` -> toolkit slug -> linked accounts. Pure. */
export function parseConnections(text: string): Record<string, Conn[]> {
  const j = jsonIn(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
  const out: Record<string, Conn[]> = {};
  for (const [slug, list] of Object.entries(j as Record<string, unknown>)) {
    if (Array.isArray(list)) out[slug] = list.filter((x): x is Conn => !!x && typeof x === 'object' && typeof (x as Conn).status === 'string');
  }
  return out;
}

const RANK: Record<string, number> = { ACTIVE: 3, INITIALIZING: 2, INITIATED: 2, EXPIRED: 1, FAILED: 1 };
/** The account that matters for an app: an active one beats a pending one beats an expired one. Pure. */
export function bestOf(list: Conn[] | undefined): { status: ConnStatus; alias: string | null } {
  let best: Conn | null = null;
  for (const c of list ?? []) if (!best || (RANK[c.status] ?? 0) > (RANK[best.status] ?? 0)) best = c;
  if (!best) return { status: 'NONE', alias: null };
  const s = best.status.toUpperCase();
  return { status: s === 'INITIATED' ? 'INITIALIZING' : (['ACTIVE', 'INITIALIZING', 'EXPIRED', 'FAILED'].includes(s) ? (s as ConnStatus) : 'FAILED'), alias: best.alias ?? null };
}

/** `composio link <slug> --no-wait --no-browser` -> the hosted-auth URL. Pure. */
const COMPOSIO_URL = /https:\/\/[a-z0-9.-]+\.composio\.dev\/\S+/;
export function parseLink(text: string): { url: string; id: string | null } | null {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const j = jsonIn(clean) as { redirect_url?: unknown; connected_account_id?: unknown } | null;
  const fromJson = j && typeof j.redirect_url === 'string' ? j.redirect_url : null;
  const url = (fromJson || clean.match(COMPOSIO_URL)?.[0] || '').replace(/[),.;]+$/g, '');
  return url && COMPOSIO_URL.test(url) ? { url, id: typeof j?.connected_account_id === 'string' ? j.connected_account_id : null } : null;
}

/** Catalog rows from the CLI cache (toolkits.json) or from `dev toolkits list`. Pure. */
export function parseCatalog(raw: unknown): App[] {
  if (!Array.isArray(raw)) return [];
  const out: App[] = [];
  for (const t of raw as Record<string, unknown>[]) {
    if (!t || typeof t.slug !== 'string' || !SLUG.test(t.slug)) continue;
    const meta = (t.meta && typeof t.meta === 'object' ? t.meta : t) as Record<string, unknown>;
    out.push({ slug: t.slug, name: typeof t.name === 'string' ? t.name : t.slug, description: typeof meta.description === 'string' ? meta.description : '',
      tools: typeof meta.tools_count === 'number' ? meta.tools_count : 0, auth: Array.isArray(t.auth_schemes) ? (t.auth_schemes as string[]) : [] });
  }
  return out;
}

/** Name, slug or description match; name hits first, then bigger toolkits. Pure. */
export function filterCatalog(apps: App[], q: string, limit = 2000): App[] {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  const score = (a: App) => (a.slug === s || a.name.toLowerCase() === s ? 3 : a.name.toLowerCase().startsWith(s) || a.slug.startsWith(s) ? 2 : a.name.toLowerCase().includes(s) || a.slug.includes(s) ? 1 : a.description.toLowerCase().includes(s) ? 0.5 : 0);
  return apps.map((a) => ({ a, k: score(a) })).filter((x) => x.k > 0).sort((x, y) => y.k - x.k || y.a.tools - x.a.tools).slice(0, limit).map((x) => x.a);
}

let cat: { at: number; apps: App[] } | null = null;
const CATALOG_FILE = () => path.join(DIR, 'toolkits.json');
/** The toolkit list cached on the box. An empty read is not cached, so a catalog written later shows up on the next open. */
export function catalog(): App[] {
  if (cat && cat.apps.length > 0 && Date.now() - cat.at < 600_000) return cat.apps;
  const apps = parseCatalog(readJson(CATALOG_FILE()));
  if (apps.length) cat = { at: Date.now(), apps };
  return apps;
}

/** Fill the catalog from the project key when the box has no toolkit cache yet. */
export async function loadCatalog(): Promise<App[]> {
  const local = catalog();
  if (local.length) return local;
  let key = '';
  try { key = fs.readFileSync(PROJECT_FILE(), 'utf8').trim(); } catch { return []; }
  if (!PROJECT_KEY.test(key)) return [];
  const items: unknown[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < 5; page++) {
      const url = new URL('https://backend.composio.dev/api/v3/toolkits');
      url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url, { headers: { 'x-api-key': key, 'user-agent': 'ai-agents' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) return [];
      const data = await res.json() as { items?: unknown[]; next_cursor?: unknown };
      if (Array.isArray(data.items)) items.push(...data.items);
      cursor = typeof data.next_cursor === 'string' && data.next_cursor ? data.next_cursor : null;
      if (!cursor) break;
    }
  } catch { return []; }
  const apps = parseCatalog(items);
  if (!apps.length) return [];
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CATALOG_FILE(), JSON.stringify(items));
  cat = { at: Date.now(), apps };
  return apps;
}

export async function searchCatalog(q: string, limit = 48): Promise<App[]> {
  const local = await loadCatalog();
  if (local.length) return q.trim() ? filterCatalog(local, q, limit) : local;
  if (!q.trim() || !signedIn()) return [];
  try { return parseCatalog(jsonIn(await run(['dev', 'toolkits', 'list', '--query', q.trim().slice(0, 80), '--limit', String(limit)]), '[', ']')); } catch { return []; }
}

export async function composioInfo(): Promise<{ available: boolean; email: string | null; org: string | null; note: string }> {
  if (!composioInstalled()) return { available: false, email: null, org: null, note: 'The Composio CLI is not installed on this server.' };
  if (!signedIn()) return { available: false, email: null, org: null, note: 'Not signed in yet.' };
  try {
    const j = jsonIn(await run(['whoami'], 15_000)) as { email?: unknown; current_org_name?: unknown } | null;
    const email = typeof j?.email === 'string' ? j.email : null;
    return { available: true, email, org: typeof j?.current_org_name === 'string' ? j.current_org_name : null, note: email ? `Signed in as ${email}.` : 'Signed in.' };
  } catch { return { available: false, email: null, org: null, note: 'The Composio CLI did not answer. Check the sign-in on the server.' }; }
}

/** Run one Composio tool. `account` is the connection alias, such as the business key. */
export async function composioExecute(slug: string, data: Record<string, unknown>, account?: string): Promise<{ data: unknown } | { error: string }> {
  if (!composioInstalled() || !signedIn()) return { error: 'Composio is not signed in on this server.' };
  const args = ['execute', slug, '-d', JSON.stringify(data)];
  if (account) args.push('--account', account);
  const text = await new Promise<string>((resolve, reject) => {
    execFile(CLI, args, { timeout: 45_000, maxBuffer: 8_000_000, env: ENV() }, (err, stdout, stderr) => {
      if (!err) { resolve(String(stdout)); return; }
      const detail = `${stdout ?? ''}\n${stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim().slice(0, 280);
      reject(new Error(detail || 'Composio did not answer.'));
    });
  }).catch((err: Error) => err);
  if (text instanceof Error) return { error: text.message };
  const parsed = jsonIn(text) ?? jsonIn(text, '[', ']');
  return parsed === null ? { error: 'Composio returned no data.' } : { data: parsed };
}

export async function composioConnections(): Promise<Record<string, Conn[]>> {
  if (!composioInstalled() || !signedIn()) return {};
  try { return parseConnections(await run(['connections', 'list'])); } catch { return {}; }
}

/** A connection selector from `composio connections list`: a word id (`slack_grume-niuan`) or a `ca_` id. */
export const CONN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,80}$/;

/** What `composio connections remove` printed. The CLI confirms on a terminal and defaults to No. Pure. */
export function parseRemove(text: string): { ok: true } | { error: string } {
  const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  if (/Removed \S+ connection/.test(clean)) return { ok: true };
  if (/No connection matched/.test(clean)) return { error: 'That connection is already gone.' };
  if (/Failed to remove/.test(clean)) return { error: 'Composio could not remove that connection.' };
  if (/No connection removed/.test(clean)) return { error: 'Composio left the connection in place.' };
  return { error: 'Composio did not confirm the removal.' };
}

// The CLI's confirm is a terminal prompt that defaults to No and ignores a piped "y". A pty wide enough
// to draw the question, then the y key, is the non-interactive yes. The selector is argv, never interpolated.
const REMOVE_PY = `
import os, pty, select, struct, fcntl, termios, time, sys, re
selector, cli = sys.argv[1], sys.argv[2]
pid, fd = pty.fork()
if pid == 0:
    os.environ["NO_COLOR"] = "1"
    os.environ["CI"] = "1"
    os.environ["COLUMNS"] = "120"
    os.environ["LINES"] = "40"
    os.execv(cli, [cli, "connections", "remove", selector])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
out, sent, end = b"", False, time.time() + 25
while time.time() < end:
    ready, _, _ = select.select([fd], [], [], 0.3)
    if ready:
        try:
            chunk = os.read(fd, 16384)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        text = out.decode("utf-8", "replace")
        if (not sent) and ("connection?" in text or "Yes /" in text):
            os.write(fd, b"y")
            sent = True
    wpid, _status = os.waitpid(pid, os.WNOHANG)
    if wpid:
        while True:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if not ready:
                break
            try:
                chunk = os.read(fd, 16384)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
        break
else:
    try:
        os.kill(pid, 15)
    except OSError:
        pass
sys.stdout.write(re.sub(r"\\x1b\\[[0-9;?]*[A-Za-z]", "", out.decode("utf-8", "replace")))
`;

/** Remove one linked account. `selector` is that account's word id, so a second account of the same app stays. */
export function composioRemove(selector: string): Promise<{ ok: true } | { error: string }> {
  if (!CONN_ID.test(selector)) return Promise.resolve({ error: 'Unknown connection.' });
  if (!composioInstalled() || !signedIn()) return Promise.resolve({ error: 'Composio is not signed in on this server.' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: { ok: true } | { error: string }) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const child = spawn('python3', ['-c', REMOVE_PY, selector, CLI], { env: ENV() });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ error: 'Composio did not confirm the removal.' }); }, 30_000);
    child.stdout.on('data', (b) => { out += String(b); });
    child.stderr.on('data', (b) => { out += String(b); });
    child.on('error', () => done({ error: 'Composio did not confirm the removal.' }));
    child.on('close', () => done(parseRemove(out)));
  });
}

export const ALIAS = /^[a-z0-9][a-z0-9-]{1,31}$/;
/** Start a hosted OAuth link for one app; the person finishes it in the browser. An alias adds a second account of the same app. */
export async function composioLink(slug: string, alias?: string): Promise<{ url: string } | { error: string }> {
  if (!SLUG.test(slug)) return { error: 'Unknown app.' };
  if (alias !== undefined && !ALIAS.test(alias)) return { error: 'Name it with lowercase letters, digits and dashes, 2 to 32 characters (e.g. second-shop).' };
  if (!composioInstalled() || !signedIn()) return { error: 'Composio is not signed in on this server.' };
  try {
    const link = parseLink(await run(['link', slug, '--no-wait', '--no-browser', ...(alias ? ['--alias', alias] : [])], 40_000));
    return link ? { url: link.url } : { error: 'Composio did not return a link for this app.' };
  } catch (err) { return { error: String((err as Error).message || err) }; }
}

/** A sign-in the person has not finished yet (the CLI caches it for 10 minutes). */
export function pendingLogin(): { url: string; expiresAt: string } | null {
  const p = readJson(path.join(DIR, 'pending-login-session.json')) as { loginUrl?: unknown; expiresAt?: unknown } | null;
  const url = typeof p?.loginUrl === 'string' ? p.loginUrl : null, exp = typeof p?.expiresAt === 'string' ? p.expiresAt : null;
  return url && exp && Date.parse(exp) > Date.now() && url.startsWith('https://dashboard.composio.dev/') ? { url, expiresAt: exp } : null;
}

/** Print the sign-in URL, then leave a poller running that saves the credentials once the person signs in. */
// switching (D, 2026-10-19: no way to change the account in the app): the CLI will not start a sign-in while one is saved, so the new
// one runs under a scratch HOME and its user_data.json is copied over the live one only once it holds a key. The old sign-in keeps
// working until then, and an abandoned switch changes nothing.
const SWITCH_HOME = () => `${DIR}-switch`;
export async function startLogin(switching = false): Promise<{ url: string } | { error: string }> {
  if (!composioInstalled()) return { error: 'The Composio CLI is not installed on this server.' };
  if (signedIn() && !switching) return { error: 'Already signed in.' };
  const sw = signedIn() ? SWITCH_HOME() : null;
  const env = sw ? { ...ENV(), HOME: sw, SW_FROM: path.join(sw, '.composio', 'user_data.json'), SW_TO: path.join(DIR, 'user_data.json') } : ENV();
  try {
    if (sw) { fs.rmSync(sw, { recursive: true, force: true }); fs.mkdirSync(sw, { recursive: true, mode: 0o700 }); }
    const out = (await run(['login', '--no-browser', '--no-wait', '-y', '--no-skill-install'], 30_000, env)).replace(/\x1b\[[0-9;]*m/g, '');
    const url = out.match(/https:\/\/dashboard\.composio\.dev\/\S*cliKey=\S+/)?.[0] ?? (sw ? null : pendingLogin()?.url);
    if (!url) return { error: 'Composio did not return a sign-in link.' };
    if (sw) spawn('/bin/sh', ['-c', `"$0" login --poll -y --no-skill-install; grep -q '"api_key":"' "$SW_FROM" && install -m 600 "$SW_FROM" "$SW_TO"`, CLI],
      { detached: true, stdio: 'ignore', env }).unref();
    else spawn(CLI, ['login', '--poll', '-y', '--no-skill-install'], { detached: true, stdio: 'ignore', env }).unref();
    return { url };
  } catch (err) { return { error: String((err as Error).message || err) }; }
}

const PROJECT_KEY = /^ak_[A-Za-z0-9._-]{8,180}$/;
export type ComposioKeyKind = 'user' | 'project' | 'org' | 'invalid';

/** ak_ is a project key (REST). uak_ is a user key (CLI sign-in). oak_ is an org key, which this box does not store. */
export function composioKeyKind(key: string): ComposioKeyKind {
  const trimmed = key.trim();
  if (/^oak_[A-Za-z0-9._-]{8,180}$/.test(trimmed)) return 'org';
  if (PROJECT_KEY.test(trimmed)) return 'project';
  if (/^uak_[A-Za-z0-9._-]{8,180}$/.test(trimmed)) return 'user';
  if (/^[A-Za-z0-9._-]{20,200}$/.test(trimmed)) return 'user';
  return 'invalid';
}

const PROJECT_FILE = () => path.join(DIR, 'project_api_key');

/** True when a project key is on disk. The value never leaves the server. */
export function projectKeySaved(): boolean {
  try { return PROJECT_KEY.test(fs.readFileSync(PROJECT_FILE(), 'utf8').trim()); } catch { return false; }
}

/** Check a project key against Composio, then store it. It does not sign the CLI in. */
export async function saveProjectKey(key: string): Promise<{ ok: true } | { error: string }> {
  const trimmed = key.trim();
  if (composioKeyKind(trimmed) !== 'project') return { error: 'That is not a project key. A project key starts with ak_.' };
  let status = 0;
  try {
    const res = await fetch('https://backend.composio.dev/api/v3/connected_accounts?limit=1', {
      headers: { 'x-api-key': trimmed, 'user-agent': 'ai-agents' },
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    await res.body?.cancel();
  } catch { return { error: 'Composio did not answer. Try the key again.' }; }
  if (status !== 200) return { error: 'Composio did not accept that project key.' };
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = PROJECT_FILE();
  fs.writeFileSync(file, `${trimmed}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { ok: true };
}

function cliError(text: string): string {
  const message = text.match(/"message":"([^"]{1,180})"/)?.[1];
  return message || 'Composio did not accept that key.';
}

/** Sign the server in with a pasted Composio user API key. The key is not returned or logged. */
export function loginWithUserKey(key: string): Promise<{ ok: true } | { error: string }> {
  const trimmed = key.trim();
  if (composioKeyKind(trimmed) === 'project') return Promise.resolve({ error: 'That is a project key (ak_). It is saved separately and does not sign this server in. Paste a user key (uak_), or use Connect Composio.' });
  if (composioKeyKind(trimmed) === 'org') return Promise.resolve({ error: 'That is an organization key. Paste a project key (ak_) or a user key (uak_).' });
  if (composioKeyKind(trimmed) !== 'user') return Promise.resolve({ error: 'That does not look like a Composio key. A project key starts with ak_. A user key starts with uak_.' });
  if (!composioInstalled()) return Promise.resolve({ error: 'The Composio CLI is not installed on this server.' });
  return new Promise((resolve) => {
    execFile(CLI, ['login', '--user-api-key', trimmed, '-y', '--no-skill-install'], { timeout: 40_000, maxBuffer: 1_000_000, env: ENV() }, (err, stdout, stderr) => {
      const detail = cliError(`${stdout ?? ''}\n${stderr ?? ''}`.replaceAll(trimmed, ''));
      if (err || !signedIn()) resolve({ error: detail });
      else resolve({ ok: true });
    });
  });
}
