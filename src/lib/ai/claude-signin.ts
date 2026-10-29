import 'server-only';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { saveKey } from './connections';

// Sign in with the Claude subscription from Settings (D, 2026-10-13: "it just reconnects it"; our own install only). The server runs
// Claude Code's own `claude setup-token` (the binary the Agent SDK ships) (the CLI's supported way to make a 1-year token for a script): we show its sign-in link, the
// person signs in to Claude and pastes back the code Claude shows, we hand that code to the CLI, read the token it prints and save it
// sealed as the Claude subscription connection. The token is never shown or logged. One sign-in at a time per app copy (nginx ip_hash
// keeps a browser on one copy); an abandoned one is killed after 10 minutes.

const strip = (s: string) => s.replace(/\x1b\[[0-9;?>=]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[()][A-Za-z0-9]/g, '').replace(/\r/g, '');
// for showing what Claude said: cursor moves stand in for spaces on its screen
const readable = (s: string) => strip(s.replace(/\x1b\[[0-9;?>=]*[A-Za-z]/g, ' '));
// non-greedy up to state=: the CLI can redraw and print the link twice with nothing between (seen on the box, 2026-10-13)
const URL_RE = /https:\/\/claude\.(?:com|ai)\/[^\s'"]*?oauth\/authorize\?[^\s'"]*?state=(?:(?!https:)[A-Za-z0-9_-])+/;
// the Agent SDK's own Claude Code binary (the SDK ships it per platform), so no separate CLI install is needed; else `claude` on PATH
const sdkClaude = () => { const b = path.join(process.cwd(), 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'); return fs.existsSync(b) ? b : 'claude'; };
const TOKEN_RE = /sk-ant-oat[0-9]+-[A-Za-z0-9_-]{20,}/;

let cur: { child: ChildProcessWithoutNullStreams; out: string; timer: NodeJS.Timeout } | null = null;
const stop = () => { if (!cur) return; clearTimeout(cur.timer); try { cur.child.kill('SIGKILL'); } catch { /* gone */ } cur = null; };
const waitFor = (re: RegExp, ms: number, view: (s: string) => string = strip) => new Promise<string | null>((resolve) => {
  const t0 = Date.now();
  const tick = () => {
    const m = cur ? view(cur.out).match(re) : null;
    if (m) return resolve(m[0]);
    if (!cur || Date.now() - t0 > ms) return resolve(null);
    setTimeout(tick, 300);
  };
  tick();
});

/** Starts `claude setup-token` and returns Claude's sign-in link. */
export async function startClaudeSignIn(): Promise<{ url: string }> {
  stop();
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.ANTHROPIC_API_KEY; // a fresh login, not the one in use
  const child = spawn('script', ['-q', '-c', `stty cols 4000 2>/dev/null; '${sdkClaude().replace(/'/g, '')}' setup-token`, '/dev/null'], { cwd: '/tmp', env });
  cur = { child, out: '', timer: setTimeout(stop, 10 * 60_000) };
  const me = cur;
  child.stdout.on('data', (d) => { me.out += String(d); });
  child.stderr.on('data', (d) => { me.out += String(d); });
  child.on('close', () => { if (cur === me) clearTimeout(me.timer); });
  const url = await waitFor(URL_RE, 25_000);
  if (!url) { stop(); throw new Error('Claude did not give a sign-in link. Is Claude Code installed on the server?'); }
  return { url };
}

/** The first token that answers one tiny Claude run (Haiku, no tools). */
async function firstWorking(tokens: string[]): Promise<string | null> {
  for (const t of tokens) {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: t };
    delete env.ANTHROPIC_API_KEY;
    const ok = await new Promise<boolean>((resolve) => {
      const c = spawn(sdkClaude(), ['-p', 'Reply with just: ok', '--model', 'haiku'], { cwd: '/tmp', env });
      const kill = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } resolve(false); }, 60_000);
      c.on('close', (code) => { clearTimeout(kill); resolve(code === 0); });
      c.on('error', () => { clearTimeout(kill); resolve(false); });
      c.stdin.end();
    });
    if (ok) return t;
  }
  return null;
}

/** Hands Claude's code to the waiting sign-in, saves the token it prints. */
export async function finishClaudeSignIn(code: string, by: number, account = ''): Promise<{ ok: true } | { error: string }> {
  const c = code.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account.trim())) return { error: 'Type the full email of the Claude account you signed in with.' };
  if (!cur) return { error: 'The sign-in timed out or ran on another copy of the app. Start it again.' };
  if (!c || c.length > 400 || /\s/.test(c)) return { error: 'Paste the code Claude shows after you sign in.' };
  // the code, then Enter on its own (2026-10-15): a long code and its Enter in one write reach Claude as one paste, the Enter becomes
  // part of the pasted text and the code is never submitted (Claude's screen showed only the masked code; a short test code passed)
  cur.child.stdin.write(c);
  await new Promise((r) => setTimeout(r, 800));
  if (!cur) return { error: 'The sign-in stopped. Start it again.' };
  cur.child.stdin.write('\r');
  // read with cursor moves as spaces (2026-10-15): Claude draws "Store this token" right after the token with only a cursor move between,
  // so dropping the moves glued the words onto it (a 120-character token, 401 invalid)
  const token = await waitFor(TOKEN_RE, 90_000, readable);
  // what Claude said after the code (2026-10-15: a real sign-in came back with no token and the reason was hidden), any token blanked
  const said = cur ? readable(cur.out.slice(-1500)).split(/Paste\s*code\s*here\s*if\s*prompted\s*>?/i).pop()!.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[token]').replace(/\*{4,}[^\s]*/g, '[code]').replace(/\s+/g, ' ').trim().slice(-400) : '';
  stop();
  if (!token) {
    console.error('[ai] Claude sign-in, no token. Claude said:', said);
    if (/does not permit|policy/i.test(said)) return { error: `This Claude account's organization does not allow long-lived tokens. Sign in with a personal Pro or Max account, or ask its admin. Claude said: ${said}` };
    if (/invalid|expired|status code 4/i.test(said)) return { error: `Claude did not accept that code. Start again and paste the newest code. Claude said: ${said}` };
    return { error: `No token came back. Claude said: ${said || 'nothing'}` };
  }
  // only a token Claude accepts replaces the working login: one short run with it before saving (the full token, else its 108-character
  // form, the length every subscription token has had)
  const good = await firstWorking([...new Set([token, token.slice(0, 108)])]);
  if (!good) return { error: 'Claude gave a token but it did not work in a test run. Nothing was changed. Start again.' };
  const r = await saveKey('claude-token', good, by, account);
  return r.ok ? { ok: true } : { error: r.error ?? 'Could not save the login.' };
}
