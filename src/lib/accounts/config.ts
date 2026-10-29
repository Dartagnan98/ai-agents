// Accounts settings from env (D, 2026-10-09, P3, docs/ACCOUNTS.md).

export type SignupMode = 'open' | 'invite' | 'closed';

/** SIGNUP_MODE: open (anyone), invite (only with a sign-up link D made with scripts/signup-invite.mjs), closed. Unset = closed in
 *  production (nobody signs up before D opens it), open in dev. */
export function signupMode(env: NodeJS.ProcessEnv = process.env): SignupMode {
  const v = (env.SIGNUP_MODE ?? '').trim().toLowerCase();
  if (v === 'open' || v === 'invite' || v === 'closed') return v;
  return env.NODE_ENV === 'production' ? 'closed' : 'open';
}

/** The app's own address for links in emails: APP_URL, else NEXTAUTH_URL / AUTH_URL / DASHBOARD_URL. A request's Host header is only
 *  trusted outside production (a forged Host would otherwise put an attacker's domain in a reset link). Null = cannot make links. */
export function appUrl(reqOrigin?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const v of [env.APP_URL, env.NEXTAUTH_URL, env.AUTH_URL, env.DASHBOARD_URL]) {
    const t = (v ?? '').trim();
    if (!t) continue;
    try { return new URL(t).origin; } catch { /* next */ }
  }
  if (env.NODE_ENV !== 'production' && reqOrigin) { try { return new URL(reqOrigin).origin; } catch { /* none */ } }
  return null;
}
