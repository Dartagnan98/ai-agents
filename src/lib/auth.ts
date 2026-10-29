// NextAuth v5 configuration
// Credentials provider backed by SQLite users table

import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from './db';
import { checkRateLimit, resetRateLimit } from './rate-limit';
import { findLoginUser, passwordMatches, savedPassword } from './login-user';

// too many tries from one address: a sign-in error (back to /login with the code), not a crash. A plain Error sent people to the broken
// /api/auth/error page and the login screen read it as "this browser did not keep the session"
class RateLimited extends CredentialsSignin { code = 'rate_limited'; }
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  // Force simple cookie names without __Secure- / __Host- prefixes.
  // NextAuth v5 auto-enables these for HTTPS (including Cloudflare tunnels via
  // X-Forwarded-Proto), but tunnel proxies may not forward Secure-prefixed
  // cookies reliably. The middleware checks for authjs.session-token, so this
  // must stay consistent.
  cookies: {
    sessionToken: {
      name: 'authjs.session-token',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
    csrfToken: {
      name: 'authjs.csrf-token',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
    callbackUrl: {
      name: 'authjs.callback-url',
      options: { sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
    pkceCodeVerifier: {
      name: 'authjs.pkce.code_verifier',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
    state: {
      name: 'authjs.state',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
    nonce: {
      name: 'authjs.nonce',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: process.env.NODE_ENV === 'production' },
    },
  },
  providers: [
    Credentials({
      name: 'Credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
        // Security (H8): Rate limit auth attempts to prevent brute force.
        // Only trust x-forwarded-for when behind a known proxy (TRUST_PROXY=true);
        // otherwise it is trivially spoofable.
        const trustProxy = process.env.TRUST_PROXY === 'true';
        const headers = (request as Request | undefined)?.headers;
        const ip = trustProxy
          ? (headers?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0')
          // CF-Connecting-IP is set by Cloudflare and is not spoofable from outside CF
          : (headers?.get('x-real-ip') ?? headers?.get('cf-connecting-ip') ?? '0.0.0.0');

        // per address only against mass guessing (a whole office shares one; D 2026-10-23: one rep's typos locked out Chris Park),
        // and per person below, once the login is known: 10 tries in 15 minutes. A login that does not exist never counts against anyone.
        if (!checkRateLimit(`ip:${ip}`, 30).allowed) throw new RateLimited();

        if (!credentials?.username || !credentials?.password) return null;

        // Seed admin user on first auth attempt if no users exist
        await seedAdminUser();

        const user = findLoginUser(db, credentials.username as string);
        if (!user) return null;

        if (!checkRateLimit(`login:local-${user.id}`, 10).allowed) throw new RateLimited();

        const valid = await passwordMatches(credentials.password as string, user.password_hash);
        if (!valid) return null;

        // Auth successful — reset rate limit counter
        resetRateLimit(`ip:${ip}`); resetRateLimit(`login:local-${user.id}`);

        return {
          id: String(user.id),
          name: user.username,
        };
      },
    }),
  ],
  pages: {
    signIn: '/login',
    // sign-in errors land on the sign-in page with the error code; the library's own error page crashed here (no agency yet)
    error: '/login',
  },
  session: {
    strategy: 'jwt',
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        return token;
      }
      return token;
    },
    session({ session, token }) {
      if (token.id && session.user) {
        session.user.id = token.id as string;
      }
      if (token.agency && session.user) (session.user as { agency?: string }).agency = token.agency as string;
      return session;
    },
    authorized({ auth: session }) {
      return !!session;
    },
  },
});

/** Seed admin user from env vars, or sync password if SYNC_ADMIN_PASSWORD=true */
export async function seedAdminUser(): Promise<void> {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM users')
    .get() as { count: number };

  // Early return: users already exist and no password sync requested.
  // Do NOT validate ADMIN_PASSWORD here — existing deployments may not have it set,
  // and we don't need it when there is nothing to seed or sync.
  if (row.count > 0 && process.env.SYNC_ADMIN_PASSWORD !== 'true') {
    return;
  }

  const username = process.env.ADMIN_USERNAME ?? 'admin';

  // Security (H8): Do not fall back to hardcoded password.
  // Only validate when we actually need the password (seeding or syncing).
  const password = process.env.ADMIN_PASSWORD;
  // a downloaded install has no seed admin: the owner is made on /setup (lib/actions/agency-setup.ts createOwner)
  if (!password && row.count === 0 && process.env.FLEET_FIRST_RUN_SETUP === '1') return;
  if (!password) {
    throw new Error('ADMIN_PASSWORD environment variable is required but not set.');
  }
  const KNOWN_DEFAULTS = ['password', 'admin', 'changeme'];
  if (process.env.NODE_ENV === 'production' && KNOWN_DEFAULTS.includes(password)) {
    throw new Error('ADMIN_PASSWORD is a known default. Set a strong password in .env.local');
  }

  if (row.count > 0) {
    // Opt-in password sync: only update stored hash when SYNC_ADMIN_PASSWORD=true.
    // This prevents the dashboard from silently overwriting a password that was
    // changed through the UI on every restart.
    const user = db
      .prepare('SELECT password_hash FROM users WHERE username = ?')
      .get(username) as { password_hash: string } | undefined;
    if (user) {
      const matches = await passwordMatches(password, user.password_hash);
      if (!matches) {
        const hash = await bcrypt.hash(savedPassword(password), 12);
        db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
        console.log(`[auth] Admin password updated from environment (SYNC_ADMIN_PASSWORD=true)`);
      }
    }
    return;
  }

  const hash = await bcrypt.hash(savedPassword(password), 12);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
    username,
    hash
  );

  console.log(`[auth] Seeded admin user: ${username}`);
}
