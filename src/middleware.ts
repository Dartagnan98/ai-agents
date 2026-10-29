// AI Agents - Auth middleware
// Checks for next-auth session cookie; redirects to /login if missing.
// Cannot import auth.ts directly because it chains to better-sqlite3,
// which is not available in the Edge Runtime.

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';
import { getToken } from 'next-auth/jwt';

// Allowed CORS origins - localhost dev + configured deployment URL + mobile app
// Built once at module load: env-derived origins are validated via `new URL()`,
// malformed values are dropped with a warning, and wildcards are explicitly rejected.
function buildAllowedOrigins(): string[] {
  const staticOrigins = ['http://localhost:3000', 'http://localhost:3001'];
  const envCandidates: Array<[string, string | undefined]> = [
    ['NEXTAUTH_URL', process.env.NEXTAUTH_URL],
    ['DASHBOARD_URL', process.env.DASHBOARD_URL],
    ['MOBILE_APP_ORIGIN', process.env.MOBILE_APP_ORIGIN],
  ];

  const validated: string[] = [];
  for (const [name, raw] of envCandidates) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed === '*') {
      console.warn(
        `[middleware] Ignoring wildcard CORS origin from ${name}; wildcards are not allowed.`,
      );
      continue;
    }
    try {
      validated.push(new URL(trimmed).origin);
    } catch {
      console.warn(
        `[middleware] Ignoring malformed CORS origin from ${name}: ${JSON.stringify(raw)}`,
      );
    }
  }

  return Array.from(new Set([...staticOrigins, ...validated]));
}

const ALLOWED_ORIGINS: string[] = buildAllowedOrigins();

function getAllowedOrigin(requestOrigin: string | null): string | null {
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  return null;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const requestOrigin = request.headers.get('origin');
  const corsOrigin = getAllowedOrigin(requestOrigin) ?? 'null';

  // Handle CORS preflight requests
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
      },
    });
  }

  // View as (lib/view-as.ts) is read-only: while this browser looks as someone else, nothing can be changed, except stopping it and
  // signing out. The cookie's own checks (signed, owner, expiry) are in the app; any value here is enough to refuse a write.
  if (request.cookies.has('ctrlos_viewas') && request.method !== 'GET' && request.method !== 'HEAD'
    && pathname !== '/api/view-as' && !pathname.startsWith('/api/auth')) {
    return NextResponse.json({ error: 'You are viewing as someone else, which is read-only. Stop viewing to make changes.' }, { status: 403 });
  }

  // Allow public paths
  // Security (H7): SSE endpoints require ?token=<jwt> auth — removed from public whitelist
  if (
    pathname.startsWith('/login') ||
    // the first-run agency setup checks who asks itself (app/setup/page.tsx): the owner step needs no session, the rest an owner or admin
    pathname === '/setup' ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico' ||
    // PWA install assets must be readable without a session, or iOS/Android can't
    // read the manifest or fetch the home-screen icon.
    pathname === '/manifest.webmanifest' ||
    pathname === '/robots.txt' || // crawlers read it signed out (app/robots.ts: stay out)
    // the brand icons drawn by app/icon/[size] and app/apple-icon (link previews fetch them signed out too; lib/brand-icon.tsx)
    /^\/icon\/\d+$/.test(pathname) ||
    pathname === '/apple-icon' ||
    // the same icons under the names browsers ask for on their own (rewritten in next.config.ts)
    pathname === '/apple-touch-icon.png' || pathname === '/apple-touch-icon-precomposed.png' || pathname === '/icon-192.png' || pathname === '/icon-512.png' ||
    pathname.startsWith('/glass/') || // liquid glass maps and wallpapers (public/glass, app/liquid-glass.css): images only, the sign-in page uses them too
    pathname === '/api/health' || // P5 uptime check: states and ages only, no secrets (app/api/health/route.ts)
    // the agents's tool server gates itself: loopback only, with a run key minted by app/api/ai/chat (app/api/ai/mcp/route.ts)
    pathname === '/api/ai/mcp' ||
    // the agents on Telegram: the path secret + Telegram's secret header are checked by the route (app/api/ai/telegram)
    pathname.startsWith('/api/ai/telegram/') ||
    // WhatsApp bridges on this server: loopback only, each number's own token checked by the route (app/api/wa/inbound)
    pathname.startsWith('/api/wa/inbound/') ||
    // chart images in Slack posts (lib/charts/slack-charts.ts): the 32-hex file name is the key; Slack fetches them signed out
    pathname.startsWith('/api/chart-img/') ||
    // the AI Agents Slack app (docs/SLACK_APP.md): events check X-Slack-Signature; the OAuth return checks its signed state + nonce cookie
    pathname === '/api/slack/events' || pathname === '/api/slack/oauth' ||
    false
  ) {
    const response = NextResponse.next();
    response.headers.set('Access-Control-Allow-Origin', corsOrigin);
    response.headers.set('Vary', 'Origin');
    return response;
  }

  // GAP-0030: Verify the NextAuth session token. Previous implementation only
  // checked `request.cookies.has('authjs.session-token')` — a name-only presence
  // check that any attacker could satisfy with `Cookie: authjs.session-token=anything`.
  // Behavioral exploit was confirmed 2026-05-16T11:30Z: fake-value cookie returned
  // 200 OK on `/api/approvals`. Replaced with `getToken` which decodes and
  // verifies the NextAuth JWE using AUTH_SECRET — only sessions actually
  // issued by `lib/auth.ts` pass.
  const authSecretForSession = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  let hasSession = false;
  if (authSecretForSession) {
    try {
      const token = await getToken({
        req: request,
        secret: authSecretForSession,
        // NextAuth v5 auto-detects the cookie name based on secureCookie;
        // we rely on that default so this works in both dev (`authjs.session-token`)
        // and prod (`__Secure-authjs.session-token`).
      });
      // a support session (D, 2026-10-09) also stops at its own expiry here, for routes that only rely on this check; the app
      // re-checks the switch on every auth() call (lib/auth.ts jwt callback)
      const supportExp = (token as { supportExp?: unknown } | null)?.supportExp;
      hasSession = !!token && !((token as { supportSid?: unknown }).supportSid && !(typeof supportExp === 'number' && Date.now() < supportExp));
    } catch {
      hasSession = false;
    }
  } else {
    // No secret configured — refuse rather than silently allow. Same posture
    // as the Bearer-token branch below.
    console.error(
      '[middleware] CRITICAL: AUTH_SECRET/NEXTAUTH_SECRET is unset. Refusing all requests until configured.',
      { pathname, method: request.method },
    );
    const res = NextResponse.json(
      { error: 'Server misconfiguration: auth secret not configured' },
      { status: 500 },
    );
    res.headers.set('Access-Control-Allow-Origin', corsOrigin);
    res.headers.set('Vary', 'Origin');
    return res;
  }

  // Check for Bearer token (mobile app)
  const authHeader = request.headers.get('Authorization');
  let hasBearerToken = false;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (token.length > 0) {
      // Security (H6): Verify JWT signature — presence-only check bypassed by any string.
      const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
      if (!authSecret) {
        console.error(
          '[middleware] CRITICAL: Bearer token presented but AUTH_SECRET/NEXTAUTH_SECRET is unset. Refusing request.',
          { pathname, method: request.method },
        );
        const res = NextResponse.json(
          { error: 'Server misconfiguration: auth secret not configured' },
          { status: 500 },
        );
        res.headers.set('Access-Control-Allow-Origin', corsOrigin);
        res.headers.set('Vary', 'Origin');
        return res;
      }
      try {
        const secret = new TextEncoder().encode(authSecret);
        await jwtVerify(token, secret);
        hasBearerToken = true;
      } catch {
        hasBearerToken = false;
      }
    }
  }

  if (!hasSession && !hasBearerToken) {
    // For API routes, return 401 instead of redirect
    if (pathname.startsWith('/api/')) {
      const res = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      res.headers.set('Access-Control-Allow-Origin', corsOrigin);
      res.headers.set('Vary', 'Origin');
      return res;
    }
    const loginUrl = new URL('/login', request.url);
    // the query string too (2026-10-07: a call's link keeps its ?t= moment through the sign-in)
    loginUrl.searchParams.set('callbackUrl', pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-pathname', pathname);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Access-Control-Allow-Origin', corsOrigin);
  response.headers.set('Vary', 'Origin');
  // Standard security headers
  response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return response;
}

export const config = {
  matcher: [
    // every route except static files
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
