import 'server-only';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { seal, unseal } from '@/lib/secret-crypto';
import { getCTXRoot } from '@/lib/config';
import { agencyIdNow } from '@/lib/slack/app';

// WhatsApp for agents (D, 2026-10-28: "add in the WhatsApp connectors the way I have them for another install ... like Slack and Telegram,
// all in one place"). A number per agent, linked to this server as
// a device (like WhatsApp Web) by scanning a QR in Settings › AI connections. The same Go bridge another install runs (one per number, a
// child of the app copy that holds the routine clock) keeps the WhatsApp session in <data>/wa/<agency>/<key>/store and holds the gates:
// only the admin numbers and the listed groups reach /api/wa/inbound (lib/wa/inbound.ts), which runs the number's agent.

const ready = schemaOnce(); // per agency database
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS wa_numbers (key TEXT PRIMARY KEY, label TEXT NOT NULL, agent_id INTEGER NOT NULL, port INTEGER NOT NULL UNIQUE,
    secret TEXT NOT NULL, admins TEXT NOT NULL DEFAULT '{}', groups TEXT NOT NULL DEFAULT '[]', ambient TEXT NOT NULL DEFAULT '[]', mode TEXT NOT NULL DEFAULT 'live',
    created_by INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  ready.mark();
}

export interface WaNumber { key: string; label: string; agent_id: number; port: number; admins: Record<string, string>; groups: string[]; ambient: string[]; mode: 'live' | 'off'; created_by: number; created_at: number }
type Row = Omit<WaNumber, 'admins' | 'groups' | 'ambient'> & { admins: string; groups: string; ambient: string; secret: string };
const parse = <T,>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
const toNum = (r: Row): WaNumber => ({ key: r.key, label: r.label, agent_id: r.agent_id, port: r.port, admins: parse(r.admins, {}), groups: parse(r.groups, []), ambient: parse(r.ambient, []),
  mode: r.mode === 'off' ? 'off' : 'live', created_by: r.created_by, created_at: r.created_at });
export function listNumbers(): WaNumber[] { ensure(); return (db.prepare('SELECT * FROM wa_numbers ORDER BY created_at').all() as Row[]).map(toNum); }
export function getNumber(key: string): WaNumber | undefined { ensure(); const r = db.prepare('SELECT * FROM wa_numbers WHERE key = ?').get(key) as Row | undefined; return r ? toNum(r) : undefined; }
/** The bridge's API token and the webhook token (sealed together). */
export function secrets(key: string): { bridge: string; hook: string } | null {
  ensure();
  const r = db.prepare('SELECT secret FROM wa_numbers WHERE key = ?').get(key) as { secret: string } | undefined;
  return r ? parse(unseal(r.secret), null) : null;
}

const digits = (s: string) => s.replace(/[^0-9]/g, '');
/** Admin numbers as { "17785551234": "Sam Lee, the owner" } (pure); groups as JIDs (…@g.us). */
export function cleanAdmins(v: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(v).map(([n, who]) => [digits(n), String(who).trim().slice(0, 120)]).filter(([n, who]) => n.length >= 8 && n.length <= 15 && who));
}
export const cleanGroups = (v: string[]) => [...new Set(v.map((g) => g.trim()).filter((g) => /^[0-9-]{8,40}@g\.us$/.test(g)))];

// every agency's numbers share this server's ports: each number's folder keeps its port, so a new one never takes a port another agency uses
const waRoot = () => path.join(getCTXRoot(), 'wa');
function portsInUse(): Set<number> {
  const used = new Set<number>();
  try {
    for (const a of fs.readdirSync(waRoot())) for (const k of fs.readdirSync(path.join(waRoot(), a))) {
      const p = Number(fs.readFileSync(path.join(waRoot(), a, k, 'port'), 'utf8').trim());
      if (p) used.add(p);
    }
  } catch { /* none yet */ }
  return used;
}

export function addNumber(a: { label: string; agentId: number; admins: Record<string, string>; groups?: string[]; ambient?: string[]; by: number }): WaNumber {
  ensure();
  const label = a.label.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
  if (label.length < 2) throw new Error('Give the number a name (e.g. "the AI line").');
  const admins = cleanAdmins(a.admins);
  if (!Object.keys(admins).length) throw new Error('Add at least one admin number: only admins can talk to the agent.');
  const groups = cleanGroups(a.groups ?? []), ambient = cleanGroups(a.ambient ?? []).filter((g) => groups.includes(g));
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'wa';
  let key = base;
  for (let i = 2; getNumber(key); i++) key = `${base}-${i}`;
  const used = new Set([...portsInUse(), ...listNumbers().map((n) => n.port)]);
  let port = 4101;
  while (used.has(port)) port++;
  const secret = { bridge: crypto.randomBytes(24).toString('base64url'), hook: crypto.randomBytes(24).toString('base64url') };
  db.prepare('INSERT INTO wa_numbers (key, label, agent_id, port, secret, admins, groups, ambient, mode, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(key, label, a.agentId, port, seal(JSON.stringify(secret)), JSON.stringify(admins), JSON.stringify(groups), JSON.stringify(ambient), 'live', a.by, Math.floor(Date.now() / 1000));
  fs.mkdirSync(dirOf(key), { recursive: true });
  fs.writeFileSync(path.join(dirOf(key), 'port'), String(port));
  return getNumber(key)!;
}
export function updateNumber(key: string, a: { label?: string; agentId?: number; admins?: Record<string, string>; groups?: string[]; ambient?: string[]; mode?: string }) {
  const n = getNumber(key);
  if (!n) throw new Error('No such number.');
  const admins = a.admins ? cleanAdmins(a.admins) : n.admins;
  if (!Object.keys(admins).length) throw new Error('Keep at least one admin number.');
  const groups = a.groups ? cleanGroups(a.groups) : n.groups, ambient = (a.ambient ? cleanGroups(a.ambient) : n.ambient).filter((g) => groups.includes(g));
  db.prepare('UPDATE wa_numbers SET label = ?, agent_id = ?, admins = ?, groups = ?, ambient = ?, mode = ? WHERE key = ?')
    .run((a.label ?? n.label).trim().slice(0, 60) || n.label, a.agentId ?? n.agent_id, JSON.stringify(admins), JSON.stringify(groups), JSON.stringify(ambient), a.mode === 'off' ? 'off' : a.mode === 'live' ? 'live' : n.mode, key);
  stop(key); // the gates live in the bridge's environment: the clock starts it again with the new ones
}
/** Removes the number: stops its bridge and deletes its WhatsApp session and messages from this server (the phone keeps everything). */
export function removeNumber(key: string) {
  ensure();
  stop(key);
  db.prepare('DELETE FROM wa_numbers WHERE key = ?').run(key);
  fs.rmSync(dirOf(key), { recursive: true, force: true });
}

// ─── the bridges (children of the app copy that runs the routine clock) ───
const dirOf = (key: string) => path.join(waRoot(), agencyIdNow(), key);
const bridgeBin = () => process.env.WA_BRIDGE_BIN || path.join(process.cwd(), 'whatsapp-bridge', 'whatsapp-bridge');
const g = globalThis as unknown as { __waKids?: Map<string, { proc: ChildProcess; started: number; fails: number; next: number }> };
const kids = (g.__waKids ??= new Map());
const kidKey = (key: string) => `${agencyIdNow()}:${key}`;

function start(n: WaNumber) {
  const s = secrets(n.key);
  if (!s) return;
  const bin = bridgeBin();
  if (!fs.existsSync(bin)) { console.warn(`[wa] no bridge at ${bin}: run npm run build:wa-bridge`); return; }
  const dir = dirOf(n.key);
  fs.mkdirSync(path.join(dir, 'store'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'port'), String(n.port));
  killStale(dir); // a bridge left over from another app copy or an earlier run would hold the port
  const allow = [...Object.keys(n.admins), ...n.groups].join(',');
  const out = fs.openSync(path.join(dir, 'bridge.log'), 'a');
  const proc = spawn(bin, [], { cwd: dir, stdio: ['ignore', out, out], env: {
    PATH: '/usr/bin:/bin', HOME: dir, TZ: 'UTC',
    WHATSAPP_BRIDGE_PORT: String(n.port), WHATSAPP_BRIDGE_TOKEN: s.bridge,
    WEBHOOK_URL: `http://127.0.0.1:${process.env.PORT || '3000'}/api/wa/inbound/${encodeURIComponent(agencyIdNow())}?n=${encodeURIComponent(n.key)}&t=${encodeURIComponent(s.hook)}`,
    // no send allow list: an empty one makes the bridge refuse to start; who may wake the agent is the gate that matters
    WHATSAPP_INBOUND_ALLOWLIST: allow, WHATSAPP_AMBIENT_GROUPS: n.ambient.join(','),
    WHATSAPP_MEDIA_ROOTS: path.join(dir, 'outbox'), FORWARD_SELF: 'false', WHATSAPP_LOG_LEVEL: 'INFO',
  } as unknown as NodeJS.ProcessEnv });
  fs.closeSync(out);
  if (proc.pid) fs.writeFileSync(path.join(dir, 'bridge.pid'), String(proc.pid));
  const k = kidKey(n.key), prev = kids.get(k);
  const entry = { proc, started: Date.now(), fails: prev?.fails ?? 0, next: 0 };
  kids.set(k, entry);
  proc.on('exit', (code, signal) => {
    if (kids.get(k)?.proc !== proc) return;
    // a bridge that dies within a minute backs off (1, 2, 4... up to 30 min), so a broken one never spins; stopped on purpose = again at once
    const quick = Date.now() - entry.started < 60_000 && signal !== 'SIGTERM';
    entry.fails = quick ? entry.fails + 1 : 0;
    entry.next = Date.now() + (quick ? Math.min(30 * 60_000, 60_000 * 2 ** (entry.fails - 1)) : 2000);
    console.warn(`[wa] ${n.key} bridge exited (${code}); next try in ${Math.round((entry.next - Date.now()) / 1000)} s`);
  });
}
// The page (server actions) and the clock can be different app copies, so stopping goes by the pid file the bridge was started with,
// and only the clock starts bridges (a stopped one is back within a tick, with the new settings).
function killStale(dir: string, skip?: number) {
  const pidFile = path.join(dir, 'bridge.pid');
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  if (pid > 1 && pid !== skip) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  fs.rmSync(pidFile, { force: true });
}
function stop(key: string) {
  const k = kids.get(kidKey(key)); kids.delete(kidKey(key));
  try { k?.proc.kill('SIGTERM'); } catch { /* gone */ }
  killStale(dirOf(key), k?.proc.pid);
}

/** From the routine clock (this agency): every live number has its bridge running, unless it is waiting out a backoff; paused ones stop. */
export function bridgesTick() {
  const nums = listNumbers(), prefix = `${agencyIdNow()}:`;
  for (const [k] of kids) if (k.startsWith(prefix) && !nums.some((n) => kidKey(n.key) === k && n.mode === 'live')) stop(k.slice(prefix.length));
  for (const n of nums) {
    if (n.mode !== 'live') continue;
    const k = kids.get(kidKey(n.key));
    if (k && k.proc.exitCode === null && !k.proc.killed) continue;
    if (k && Date.now() < k.next) continue;
    start(n);
  }
}

/** Linked or not, the QR to scan when not, and the bridge's last log lines when it is down. */
export async function numberStatus(key: string): Promise<{ running: boolean; connected: boolean; qr: string | null; log: string }> {
  const n = getNumber(key), s = secrets(key);
  let running = false, connected = false;
  if (n && s) {
    const r = await fetch(`http://127.0.0.1:${n.port}/api/health`, { headers: { Authorization: `Bearer ${s.bridge}` }, signal: AbortSignal.timeout(3000) }).catch(() => null);
    running = !!r;
    connected = !!r && r.ok && !!(await r.json().catch(() => ({})) as { connected?: boolean }).connected;
  }
  // WhatsApp's codes last 20 to 60 seconds and the bridge writes each new one; a code older than 2 minutes is gone
  const qrFile = path.join(dirOf(key), 'store', '.qr-code.txt');
  const qr = !connected && fs.existsSync(qrFile) && Date.now() - fs.statSync(qrFile).mtimeMs < 120_000 ? fs.readFileSync(qrFile, 'utf8').trim() : null;
  let log = '';
  try { log = fs.readFileSync(path.join(dirOf(key), 'bridge.log'), 'utf8').split('\n').filter((l) => l.trim()).slice(-8).join('\n'); } catch { /* none yet */ }
  return { running, connected, qr, log: connected ? '' : fs.existsSync(bridgeBin()) ? log.slice(-1500) : `No bridge at ${bridgeBin()}: run npm run build:wa-bridge` };
}

/** A call to the number's bridge (send, react). */
export async function bridgeCall(key: string, apiPath: string, body: unknown): Promise<{ success?: boolean; message?: string }> {
  const n = getNumber(key), s = secrets(key);
  if (!n || !s) throw new Error('No such WhatsApp number.');
  const r = await fetch(`http://127.0.0.1:${n.port}/api/${apiPath}`, { method: 'POST', headers: { Authorization: `Bearer ${s.bridge}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
    .catch((e: unknown) => { throw new Error(`The WhatsApp bridge is not answering (${e instanceof Error ? e.message : String(e)}). Is the number linked?`); });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { success: r.ok, message: text.slice(0, 300) }; }
}
