// the agents tool output guard (D, 2026-10-10, docs/SECRETS_ENCRYPTION.md "Agents use keys without seeing them"). Every tool result and
// tool error the headless model reads passes through here (lib/ai/tools.ts callTool, the one path app/api/ai/mcp and every runner use):
// the exact values of the agency's keys (Settings keys, connector keys, AI connections, the app's own secret env) and their URL-encoded,
// base64 and JSON-escaped forms, plus key-shaped strings (Stripe sk_/rk_/whsec_, GHL pit-, Bearer/Basic, Postgres URL passwords, Slack
// xox*, OpenAI sk-, GitHub gh*_, Google AIza, Telegram bot tokens, JWTs) become [hidden]. biz_ ids, GHL location ids and publishable
// pk_ keys stay. Twin of fleet-sync/fleet_agent_run.py (the box agents' fleet-run agent mode), same rules.
// No tool returns a key today (checked 10-10); this is the net under every tool, including app_run results and knowledge documents.

export const HIDDEN = '[hidden]';
const MIN = 8;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|_PW|_URL|_DSN|AUTH|CREDENTIAL|PRIVATE|WEBHOOK|COOKIE|SESSION)/i;
const NOT_SECRET_NAME = /(_GHL_LOCATION|_WHOP_COMPANY|^WHOP_COMPANY_|_ON|_ENABLED|_MODE|_TZ|_ACCOUNT_ID|CHAT_ID|_PUBLIC_URL|_KEY_FILE|^APP_URL|^NEXTAUTH_URL)$/; // the app's own public address is printed in links (chart images, pages)

// a pattern's first group, when it has one, is printed ("Bearer ", "postgres://user:"); the rest becomes [hidden]
export const KEY_PATTERNS: RegExp[] = [
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bwhsec_[A-Za-z0-9+/=]{8,}/,
  /\bpit-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/,
  /(\b[Bb]earer\s+)[A-Za-z0-9._~+/=-]{8,}/,
  /(\b[Bb]asic\s+)[A-Za-z0-9+/=]{12,}/,
  /(\bpostgres(?:ql)?:\/\/[^\s:/@'"]+:)[^\s@'"/]+(?=@)/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

/** True when a stored name/value pair is a secret (settings such as CONN_*_GHL_LOCATION or WHOP_COMPANY_* = biz_ ids are not). */
export function isSecret(name: string, value: string): boolean {
  if (!value || value.length < MIN || /^\d{1,15}$/.test(value) || /^(true|false)$/i.test(value)) return false;
  if (NOT_SECRET_NAME.test(name)) return false;
  if (/^https?:\/\/[^/@?#\s]+\/?$/.test(value)) return false; // a bare web address (APP_URL, AUTH_URL) is public; links with a path or login can carry a key
  return SECRET_NAME.test(name);
}

function b64Variants(raw: Buffer): string[] {
  const out = new Set<string>();
  for (let k = 0; k < 3; k++) {
    const data = Buffer.concat([Buffer.alloc(k), raw]);
    for (const enc of [data.toString('base64'), data.toString('base64url')]) {
      const mid = enc.slice(4 * Math.floor((k + 2) / 3), 4 * Math.floor(data.length / 3));
      if (mid.length >= 12) out.add(mid);
      if (k === 0) { out.add(enc); out.add(enc.replace(/=+$/, '')); }
    }
  }
  return [...out].filter((v) => v.length >= 12);
}

/** Every form a value can be printed in: as is, URL-encoded, JSON-escaped, base64 (any alignment), a Postgres URL's password. */
export function encodedForms(value: string): string[] {
  const forms = new Set<string>([value, encodeURIComponent(value), encodeURI(value), JSON.stringify(value).slice(1, -1),
    JSON.stringify(value).slice(1, -1).replace(/\//g, '\\/'), ...b64Variants(Buffer.from(value, 'utf8'))]);
  const m = value.match(/^postgres(?:ql)?:\/\/[^:/@]+:([^@]+)@/);
  if (m) { forms.add(m[1]); try { forms.add(decodeURIComponent(m[1])); } catch { /* not encoded */ } }
  return [...forms].filter((f) => f.length >= MIN);
}

/** The strings to hide for a set of named values (non-secret settings skipped). */
export function secretNeedles(named: Record<string, string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(named)) if (typeof v === 'string' && isSecret(k, v.trim())) for (const f of encodedForms(v.trim())) out.add(f);
  return [...out];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text with every needle and key-shaped string replaced by [hidden], and how many were replaced. */
export function redactSecrets(text: string, needles: string[]): { text: string; count: number } {
  if (!text) return { text, count: 0 };
  const lits = [...new Set(needles.filter((n) => n && n.length >= MIN))].sort((a, b) => b.length - a.length);
  let count = 0, out = text;
  if (lits.length) out = out.replace(new RegExp(lits.map(esc).join('|'), 'g'), () => { count++; return HIDDEN; });
  for (const p of KEY_PATTERNS) {
    out = out.replace(new RegExp(p.source, 'g'), (m: string, keep?: unknown) => {
      count++;
      return typeof keep === 'string' && m.startsWith(keep) ? keep + HIDDEN : HIDDEN;
    });
  }
  return { text: out, count };
}

/** The app's own secret env (AUTH_SECRET, REVO_DB_URL, METRICS_KEY, CLAUDE_CODE_OAUTH_TOKEN, ...): hidden too. */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

/** Runs one tool and scrubs what it returns, and the message of what it throws. `collect` gathers the agency's named values; when it
 *  fails (no key file, a locked database), the key-shaped patterns and the env still apply: the tool never breaks over this. */
export async function guardToolOutput(fn: () => Promise<string>, collect: () => Record<string, string | null | undefined>): Promise<string> {
  const needles = () => { try { return secretNeedles(collect()); } catch { return secretNeedles(envSecrets()); } };
  try {
    const text = await fn();
    return redactSecrets(text, needles()).text;
  } catch (e) {
    throw new Error(redactSecrets(e instanceof Error ? e.message : String(e), needles()).text);
  }
}
