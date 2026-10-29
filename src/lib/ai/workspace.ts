import 'server-only';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { listSkills } from './store';

// Agent workspace (D, 2026-10-27: "we want this to be able to do whatever it needs"; plan docs/AGENT_WORKSPACE.md). Each agency has a
// folder on the box where owner/admin agent runs write files and run Python or shell. Every command runs as its own transient systemd
// unit as the unprivileged user `fleetwork` (scripts/fleet-work/setup.sh makes it): /root (the app, its DB and .env) and /home are hidden,
// the system is read only, other agencies' folders are masked, known readable caches are blocked, no network (loopback only, for the
// fleet package later), and memory/CPU/time are capped. The app never runs agent commands as itself.
export const WORK_ROOT = process.env.FLEET_WORK_ROOT || '/srv/fleet-work';
const WORK_USER = 'fleetwork';
const MAX_SECONDS = 3600, DEFAULT_SECONDS = 120; // chat commands cap themselves at 900; scheduled scripts get the hour
const MAX_OUTPUT = 30_000; // chars of output the model reads back
const MAX_PARALLEL = 2; // the the agency box has ~1 GB free: per app copy, the rest wait their turn
const BLOCKED = ['/opt', '/var/log', '/var/cache/ctrl-os-zoom', '/var/cache/ctrl-os-zoom-clean', '/var/cache/ctrl-os-charts',
  '/var/cache/ctrl-os-models', '/etc/letsencrypt', '/var/backups'];

const ready = schemaOnce();
function ensureLog() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_workspace_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, thread_id INTEGER,
    tool TEXT NOT NULL, detail TEXT NOT NULL, exit_code INTEGER, ms INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))`);
  ready.mark();
}
export function logWorkspace(userId: number, threadId: number | null, tool: string, detail: string, exitCode: number | null, ms: number) {
  ensureLog();
  db.prepare('INSERT INTO ai_workspace_log (user_id, thread_id, tool, detail, exit_code, ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, threadId, tool, detail.slice(0, 2000), exitCode, ms);
}

/** The agency's folder name: its id, letters/digits/dashes only. */
export const agencySlug = (agency: string | undefined) => (agency || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'default';

/** A path inside the workspace, relative, no "..": the sandbox is the real wall, this keeps answers and logs readable. */
export function workPath(p: string): string {
  const s = (p || '').trim().replace(/^\.\/+/, '');
  if (!s || s.length > 300 || s.startsWith('/') || s.split('/').some((x) => x === '..') || /[\0\n]/.test(s)) {
    throw new Error('Use a path inside the workspace, like skills/x/run.py or out/report.csv (no leading / and no ..).');
  }
  return s;
}

let uidCache: { uid: number; gid: number } | null = null;
function workUser(): { uid: number; gid: number } {
  if (uidCache) return uidCache;
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${WORK_USER}:`));
  if (!line) throw new Error('The agent workspace is not set up on this server yet (scripts/fleet-work/setup.sh).');
  const [, , uid, gid] = line.split(':');
  return (uidCache = { uid: Number(uid), gid: Number(gid) });
}

/** The agency's folder, made on first use, owned by the workspace user and closed to others. Inside the sandbox it is /work, the layout
 *  scripts expect: skills/ state/ out/ tmp/ temp/ data/. */
const SUBDIRS = ['skills', 'state', 'out', 'tmp', 'temp', 'data'];
function agencyDir(agency: string | undefined): string {
  const dir = path.join(WORK_ROOT, agencySlug(agency));
  if (!fs.existsSync(path.join(dir, 'data'))) {
    const { uid, gid } = workUser();
    for (const d of [dir, ...SUBDIRS.map((x) => path.join(dir, x))]) {
      if (fs.existsSync(d)) continue;
      fs.mkdirSync(d, { mode: 0o700 });
      fs.chownSync(d, uid, gid);
    }
  }
  return dir;
}

// Scripts reach Fleet's own tools (the fleet Python package, lib/ai/fleet-py) with a short-lived run key: written to a root-only file and
// handed to the unit as a systemd credential ($CREDENTIALS_DIRECTORY/fleet_key, readable by that unit only), never on a command line.
const KEY_DIR = '/run/fleet-keys';
export const FLEET_LIB = process.env.FLEET_LIB_DIR || '/srv/fleet-lib';

/** The systemd-run arguments for one command in one agency's folder (exported for the tests). */
export function unitArgs(dir: string, seconds: number, argv: string[], unit = `fleetwork-${crypto.randomBytes(5).toString('hex')}`,
  fleet?: { keyFile: string; mcpUrl: string }): string[] {
  const props = [
    `User=${WORK_USER}`, `Group=${WORK_USER}`, 'WorkingDirectory=/work',
    'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'PrivateDevices=yes', 'ProtectProc=invisible', 'ProcSubset=pid',
    'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectControlGroups=yes', 'ProtectClock=yes', 'ProtectHostname=yes',
    'NoNewPrivileges=yes', 'RestrictSUIDSGID=yes', 'CapabilityBoundingSet=', 'LockPersonality=yes', 'RestrictNamespaces=yes',
    // its own folder at /work; the real folder and every other agency's are out of reach (tried on the box 2026-10-28)
    `BindPaths=${dir}:/work`, `InaccessiblePaths=${WORK_ROOT}`,
    ...BLOCKED.map((p) => `InaccessiblePaths=-${p}`),
    'IPAddressDeny=any', 'IPAddressAllow=localhost',
    'MemoryMax=1G', 'MemorySwapMax=0', 'CPUQuota=100%', 'TasksMax=64', `RuntimeMaxSec=${seconds}`,
    'Environment=HOME=/work', 'Environment=TMPDIR=/work/tmp', 'Environment=PYTHONDONTWRITEBYTECODE=1', 'Environment=LANG=C.UTF-8',
    `Environment=PYTHONPATH=${FLEET_LIB}`, `Environment=PATH=${FLEET_LIB}/bin:/usr/local/bin:/usr/bin:/bin`,
    ...(fleet ? [`LoadCredential=fleet_key:${fleet.keyFile}`, `Environment=FLEET_MCP_URL=${fleet.mcpUrl}`] : []),
  ];
  return ['--quiet', '--wait', '--pipe', '--collect', `--unit=${unit}`, ...props.flatMap((p) => ['-p', p]), '--', ...argv];
}

/** Copies the fleet Python package from this build's source to FLEET_LIB when it changed (root-owned, read-only to the sandbox). */
let libHash = '';
export function installFleetLib() {
  const src = [path.join(process.cwd(), 'src/lib/ai/fleet-py'), path.join(process.cwd(), 'dashboard/src/lib/ai/fleet-py'), '/root/ctrl-fleet/dashboard/src/lib/ai/fleet-py']
    .find((d) => fs.existsSync(d));
  if (!src) throw new Error('The fleet Python package is missing from this build.');
  const files: [string, Buffer][] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== '__pycache__') walk(p); } else if ((e.name.endsWith('.py') && !e.name.startsWith('test_')) || path.basename(d) === 'bin') files.push([path.relative(src, p), fs.readFileSync(p)]);
  } };
  walk(src);
  const h = crypto.createHash('sha256');
  for (const [p, b] of files.sort(([a], [b]) => a.localeCompare(b))) h.update(p).update(b);
  const hash = h.digest('hex');
  if (hash === libHash && fs.existsSync(path.join(FLEET_LIB, '.hash')) && fs.readFileSync(path.join(FLEET_LIB, '.hash'), 'utf8') === hash) return;
  const next = `${FLEET_LIB}.new`;
  fs.rmSync(next, { recursive: true, force: true });
  // bin/ is on the sandbox PATH, so executable
  for (const [p, b] of files) { fs.mkdirSync(path.dirname(path.join(next, p)), { recursive: true, mode: 0o755 }); fs.writeFileSync(path.join(next, p), b, { mode: p.startsWith('bin/') ? 0o755 : 0o644 }); }
  fs.writeFileSync(path.join(next, '.hash'), hash);
  fs.chmodSync(next, 0o755);
  fs.rmSync(FLEET_LIB, { recursive: true, force: true });
  fs.renameSync(next, FLEET_LIB);
  libHash = hash;
}

const g = globalThis as unknown as { __fleetWork?: { busy: number; waiting: (() => void)[] } };
const slots = (g.__fleetWork ??= { busy: 0, waiting: [] });
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (slots.busy >= MAX_PARALLEL) await new Promise<void>((r) => slots.waiting.push(r));
  slots.busy++;
  try { return await fn(); } finally { slots.busy--; slots.waiting.shift()?.(); }
}

/** Long output keeps its start and its end (errors land at the end). */
export function clip(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  return `${s.slice(0, head)}\n[… ${(s.length - max).toLocaleString('en-US')} characters cut …]\n${s.slice(s.length - (max - head))}`;
}

export interface WorkResult { code: number | null; out: string; ms: number; timedOut: boolean }

/** Runs argv in the agency's sandbox; stdin optional; `runKey` lets its scripts call Fleet tools. Output is stdout and stderr together, in order. */
export async function runInWorkspace(agency: string | undefined, argv: string[], opts: { seconds?: number; stdin?: string; runKey?: string } = {}): Promise<WorkResult> {
  const dir = agencyDir(agency), seconds = Math.min(MAX_SECONDS, Math.max(5, Math.floor(opts.seconds ?? DEFAULT_SECONDS)));
  installFleetLib();
  return slot(() => new Promise<WorkResult>((resolve) => {
    const started = Date.now(), unit = `fleetwork-${crypto.randomBytes(5).toString('hex')}`;
    let fleet: { keyFile: string; mcpUrl: string } | undefined;
    if (opts.runKey) {
      fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
      fleet = { keyFile: path.join(KEY_DIR, unit), mcpUrl: `http://127.0.0.1:${process.env.PORT || '3000'}/api/ai/mcp` }; // this app copy: run keys live in its memory
      fs.writeFileSync(fleet.keyFile, opts.runKey, { mode: 0o600 });
    }
    const done = (r: WorkResult) => { if (fleet) fs.rmSync(fleet.keyFile, { force: true }); resolve(r); };
    const child = spawn('systemd-run', unitArgs(dir, seconds, argv, unit, fleet), { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', timedOut = false;
    const add = (b: Buffer) => { if (out.length < 400_000) out += b.toString('utf8'); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    // RuntimeMaxSec stops the unit; this is the backstop if systemd-run itself hangs
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, (seconds + 15) * 1000);
    child.on('error', (e) => { clearTimeout(timer); done({ code: null, out: `Could not start the workspace: ${e.message}`, ms: Date.now() - started, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, out, ms: Date.now() - started, timedOut: timedOut || (code !== 0 && Date.now() - started >= seconds * 1000) }); });
    child.stdin.end(opts.stdin ?? '');
  }));
}

// Team skills as folders in /work/skills/<name>/ (SKILL.md + their files), written by the sandbox user (root never writes into the
// workspace: a link there could point anywhere). Only files an earlier sync wrote are removed, so state a script keeps in its skill folder
// stays. A name with dashes also gets an underscore link.
const PY_SYNC = `import json,sys,os,shutil
a=json.load(sys.stdin); base='/work/skills'; mf=os.path.join(base,'.fleet-synced.json')
old=json.load(open(mf)) if os.path.exists(mf) else {}
new={}
for s in a['skills']:
  d=os.path.join(base,s['name']); new[s['name']]=[]
  for f in s['files']:
    p=os.path.normpath(os.path.join(d,f['path']))
    if not p.startswith(d+os.sep): continue
    os.makedirs(os.path.dirname(p),exist_ok=True)
    if os.path.islink(p): os.unlink(p)
    if not os.path.exists(p) or open(p,encoding='utf-8',errors='replace').read()!=f['body']: open(p,'w',encoding='utf-8').write(f['body'])
    new[s['name']].append(f['path'])
  os.makedirs(os.path.join(d,'state'),exist_ok=True)  # scripts keep their state there
  alias=os.path.join(base,s['name'].replace('-','_'))
  if alias!=d and not os.path.exists(alias): os.symlink(s['name'],alias)
for name,paths in old.items():
  keep=set(new.get(name,[]))
  for rel in paths:
    p=os.path.join(base,name,rel)
    if rel not in keep and os.path.isfile(p) and not os.path.islink(p): os.remove(p)
  if name not in new:
    alias=os.path.join(base,name.replace('-','_'))
    if os.path.islink(alias): os.unlink(alias)
    d=os.path.join(base,name)
    if os.path.isdir(d) and not os.listdir(d): os.rmdir(d)
json.dump(new,open(mf,'w'))
print(f"{len(new)} skills in /work/skills")`;
export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export interface SyncSkill { name: string; files: { path: string; body: string }[] }
const synced = new Map<string, string>();
/** Writes the team skills into the agency's workspace when they changed since the last sync on this app copy. */
export async function syncSkills(agency: string | undefined, skills: SyncSkill[]): Promise<string | null> {
  const list = skills.filter((s) => SKILL_NAME.test(s.name)).map((s) => ({ name: s.name, files: s.files.filter((f) => f.path && !f.path.startsWith('/') && !f.path.split('/').includes('..')) }));
  const payload = JSON.stringify({ skills: list }), hash = crypto.createHash('sha256').update(payload).digest('hex'), key = agencySlug(agency);
  if (synced.get(key) === hash) return null;
  const r = await runInWorkspace(agency, ['/usr/bin/python3', '-I', '-c', PY_SYNC], { seconds: 120, stdin: payload });
  if (r.code !== 0) return `Skills could not be copied into the workspace: ${clip(r.out, 1500)}`;
  synced.set(key, hash);
  return null;
}

/** The team skills (SKILL.md + files) of what this person sees, into the workspace; a string = why it failed. */
export async function syncTeamSkills(agency: string | undefined, userId: number): Promise<string | null> {
  const team = listSkills(userId).filter((sk) => sk.id > 0 && sk.share === 'team')
    .map((sk) => ({ name: sk.name, files: [{ path: 'SKILL.md', body: sk.body }, ...(sk.files ?? []).map((f) => ({ path: f.path, body: f.body }))] }));
  return syncSkills(agency, team);
}

/** The last line a command printed (a run's one-line summary). */
export const lastLine = (out: string) => out.split('\n').map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 300) ?? '';

/** The answer the model reads for a command. */
export function describeRun(r: WorkResult, seconds: number): string {
  const status = r.timedOut ? `stopped after ${seconds} s (time limit)` : r.code === 0 ? 'exit 0' : `exit ${r.code ?? 'unknown'}`;
  return `[${status}, ${(r.ms / 1000).toFixed(1)} s]\n${clip(r.out) || '(no output)'}`;
}

// File helpers: each one is a command in the same sandbox, so they see exactly what a script sees.
// The python snippets read their arguments as JSON on stdin (never from the command line).
const PY_EDIT = `import json,sys,os
a=json.load(sys.stdin); p=a['path']
t=open(p,encoding='utf-8').read() if os.path.exists(p) else None
if t is None: sys.exit('No file '+p)
n=t.count(a['old'])
if n==0: sys.exit('The text to replace is not in '+p)
if n>1 and not a.get('all'): sys.exit(f'The text to replace is in {p} {n} times: add more around it, or set all')
open(p,'w',encoding='utf-8').write(t.replace(a['old'],a['new']) if a.get('all') else t.replace(a['old'],a['new'],1))
print(f"Replaced {n if a.get('all') else 1} in {p}")`;
const PY_WRITE = `import json,sys,os
a=json.load(sys.stdin); p=a['path']
d=os.path.dirname(p)
if d: os.makedirs(d,exist_ok=True)
open(p,'w',encoding='utf-8').write(a['content'])
print(f"Wrote {len(a['content'])} characters to {p}")`;

export const editArgs = (p: string, oldText: string, newText: string, all: boolean) =>
  ({ argv: ['/usr/bin/python3', '-I', '-c', PY_EDIT], stdin: JSON.stringify({ path: workPath(p), old: oldText, new: newText, all }) });
export const writeArgs = (p: string, content: string) =>
  ({ argv: ['/usr/bin/python3', '-I', '-c', PY_WRITE], stdin: JSON.stringify({ path: workPath(p), content }) });
/** Up to 4 MB of one file (read_file-style paging happens in the app). */
export const readArgs = (p: string) => ({ argv: ['/usr/bin/head', '-c', String(4 * 1024 * 1024), '--', workPath(p)] });
/** Files whose name matches (no query), or lines that contain the query (fixed string, any case), under a folder. */
export function searchArgs(query: string, under: string, name: string) {
  const dir = under ? workPath(under) : '.';
  if (!query) return { argv: ['/usr/bin/find', dir, '-type', 'f', ...(name ? ['-name', name] : []), '-not', '-path', '*/__pycache__/*'] };
  return { argv: ['/usr/bin/grep', '-rnIiF', '--exclude-dir=__pycache__', ...(name ? [`--include=${name}`] : []), '-m', '50', '--', query, dir] };
}
