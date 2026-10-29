import 'server-only';
import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import { describeCron } from './cron';

// Operations › Automations (D 2026-10-28; the hub's from 2026-10-25): what runs on this box outside the agents' routines,
// read only. systemd timers, the scheduled jobs in /etc/cron.d (Fleet syncs, scores, backups, mirrors) and pm2 services. OS housekeeping
// timers and cron files are left out.
const run = promisify(execFile);
const OS_TIMERS = /^(apt-|apport|certbot|dpkg|e2scrub|fstrim|logrotate|man-db|mdadm|mdcheck|mdmonitor|motd|snapd|systemd-|ua-timer|update-notifier|xfs_)/;

export interface SystemJob { kind: 'timer' | 'cron' | 'service'; id: string; name: string; on: boolean; schedule: string; lastRun: number | null; nextRun: number | null; ok: boolean | null; note: string }

// systemd schedules in words: "every 300" (seconds), "*-*-* 07,11:00:00 America/Vancouver", "Sun *-*-* 09:00:00 ..."
const secs = (n: number) => (n % 3600 === 0 ? `${n / 3600 === 1 ? 'hour' : `${n / 3600} h`}` : n % 60 === 0 ? `${n / 60 === 1 ? 'minute' : `${n / 60} min`}` : `${n} s`);
const clock = (h: string, m: string) => `${Number(h) % 12 || 12}${m === '00' ? '' : `:${m}`} ${Number(h) < 12 ? 'AM' : 'PM'}`;
const DAYS: Record<string, string> = { Mon: 'Mondays', Tue: 'Tuesdays', Wed: 'Wednesdays', Thu: 'Thursdays', Fri: 'Fridays', Sat: 'Saturdays', Sun: 'Sundays' };
function timerWords(v: string): string {
  const every = /^every (\d+)(s|min|h)?$/.exec(v);
  if (every) return `Every ${secs(Number(every[1]) * (every[2] === 'min' ? 60 : every[2] === 'h' ? 3600 : 1))}`;
  const step = /^(?:\*-\*-\* )?\*:(\d+)\/(\d+)/.exec(v);
  if (step) return `Every ${step[2]} min`;
  const hourly = /^(?:\*-\*-\* )?\*:(\d+)(?::00)?(?: |$)/.exec(v);
  if (hourly) return `Hourly at :${hourly[1]}`;
  const cal = /^(?:(\w{3}) )?\*-\*-\* ([\d,]+):([\d,]+)(?::\d+)?/.exec(v);
  if (!cal) return v;
  const [, dow, hs, ms] = cal;
  const times = hs.split(',').flatMap((h) => ms.split(',').map((m) => clock(h, m)));
  return `${dow ? `${DAYS[dow] ?? dow}` : 'Daily'} at ${times.join(', ')}`;
}
const cronWords = (c: string) => { const step = /^\*\/(\d+) \* \* \* \*$/.exec(c); return step ? `Every ${step[1]} min` : describeCron(c, 'UTC'); };
const MOVED: Record<string, string> = {};
const usec = (v?: string) => { const t = v ? Date.parse(v.replace(/^\w{3} /, '')) : NaN; return Number.isFinite(t) ? t : null; };
// "systemctl show" prints one block per unit, blank-line separated
const blocks = (out: string) => out.split(/\n\n+/).map((b) => Object.fromEntries(b.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])));

async function timers(): Promise<SystemJob[]> {
  const { stdout } = await run('systemctl', ['list-unit-files', '--type=timer', '--no-legend']);
  const names = stdout.split('\n').map((l) => l.split(/\s+/)[0]).filter((n) => n?.endsWith('.timer') && !n.includes('@') && !OS_TIMERS.test(n));
  if (!names.length) return [];
  const units = names.flatMap((n) => [n, n.replace(/\.timer$/, '.service')]);
  const show = blocks((await run('systemctl', ['show', ...units, '-p', 'Id,Description,ActiveState,UnitFileState,NextElapseUSecRealtime,LastTriggerUSec,Result,ExecMainStartTimestamp,ExecMainStatus'])).stdout);
  const by = new Map(show.map((b) => [b.Id, b]));
  return names.map((n) => {
    const t = by.get(n) ?? {}, s = by.get(n.replace(/\.timer$/, '.service')) ?? {};
    let schedule = '';
    try { schedule = fs.readFileSync(`/etc/systemd/system/${n}`, 'utf8').split('\n').filter((l) => /^On(Calendar|UnitActiveSec|BootSec)=/.test(l)).map((l) => l.replace(/^OnUnitActiveSec=/, 'every ').replace(/^OnCalendar=/, '').replace(/^OnBootSec=.*/, ''))
      .filter(Boolean).map(timerWords).join(', '); } catch { /* unit elsewhere */ }
    const lastRun = usec(s.ExecMainStartTimestamp) ?? usec(t.LastTriggerUSec);
    return { kind: 'timer', id: n, name: (s.Description || t.Description || n), on: t.ActiveState === 'active', schedule,
      lastRun, nextRun: usec(t.NextElapseUSecRealtime), ok: lastRun ? s.Result === 'success' && (s.ExecMainStatus ?? '0') === '0' : null, note: MOVED[n] ? `Moved to the routine ${MOVED[n]}` : '' };
  });
}

// /etc/cron.d files: "m h dom mon dow user command", a comment line above a job names it; "#" in front of a job = off
const OS_CRON = /^(certbot|e2scrub_all|sysstat|php|popularity-contest|\.placeholder)$/;
async function crontab(): Promise<SystemJob[]> {
  const out: SystemJob[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync('/etc/cron.d').filter((f) => !OS_CRON.test(f)).sort(); } catch { return out; }
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(`/etc/cron.d/${file}`, 'utf8'); } catch { continue; }
    let comment = '';
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || /^[A-Z_]+=/.test(line)) { if (!line) comment = ''; continue; }
      const off = line.startsWith('#') && /^#\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\w+\s+\//.test(line);
      const body = off ? line.replace(/^#\s*/, '') : line;
      const m = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+\w+\s+(.+)$/.exec(body);
      if ((line.startsWith('#') && !off) || !m) { if (line.startsWith('#')) comment = line.replace(/^#\s*/, ''); continue; }
      const [, sched, cmd] = m;
      const what = /sync\.py\s+([\w-]+)/.exec(cmd)?.[1] ?? /([\w.-]+\.(?:py|sh|mjs|ts|js))\b/.exec(cmd)?.[1] ?? cmd.slice(0, 40);
      const log = / >>?\s*(\/\S+\.log)/.exec(cmd)?.[1];
      let lastRun: number | null = null;
      try { if (log) lastRun = fs.statSync(log).mtimeMs; } catch { /* no log yet */ }
      out.push({ kind: 'cron', id: `${file} ${sched} ${what}`, name: `${file}: ${what}`, on: !off, schedule: cronWords(sched), lastRun, nextRun: null, ok: null, note: (comment || cmd).slice(0, 220) });
    }
  }
  return out;
}

async function services(): Promise<SystemJob[]> {
  const { stdout } = await run('pm2', ['jlist'], { maxBuffer: 20 * 1024 * 1024 }).catch(() => ({ stdout: '[]' }));
  const list = JSON.parse(stdout || '[]') as { name: string; pm2_env: { status: string; pm_uptime: number; restart_time: number } }[];
  return list.map((p) => ({ kind: 'service', id: p.name, name: p.name, on: p.pm2_env.status === 'online', schedule: 'Always running', lastRun: p.pm2_env.pm_uptime || null, nextRun: null,
    ok: p.pm2_env.status === 'online', note: `${p.pm2_env.restart_time} restarts` }));
}

export async function systemJobs(): Promise<{ timers: SystemJob[]; cron: SystemJob[]; services: SystemJob[]; errors: string[] }> {
  const errors: string[] = [];
  // a machine without systemd or pm2 (a Mac, a laptop) just has none of those: not an error
  const safe = <T,>(p: Promise<T[]>, what: string) => p.catch((e: unknown) => { if ((e as { code?: string })?.code !== 'ENOENT') errors.push(`${what}: ${e instanceof Error ? e.message : String(e)}`); return [] as T[]; });
  const [t, c, s] = await Promise.all([safe(timers(), 'timers'), safe(crontab(), 'crontab'), safe(services(), 'pm2')]);
  return { timers: t, cron: c, services: s, errors };
}
