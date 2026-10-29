import type { NextConfig } from "next";
import { readFileSync } from "node:fs";

// One id per deploy (deploy.sh writes .deploy-id before the build; the same file is read again when the copies start), so the browser
// knows a new build is out and Next does a full reload instead of calling actions the new build no longer has (2026-10-09, D:
// "make sure this glitch does not keep happening").
const deploymentId = (() => { try { return readFileSync(".deploy-id", "utf8").trim() || undefined; } catch { return undefined; } })();

// Next.js 15.2+ blocks non-localhost origins from /_next/* dev-internal
// resources by default. When the dashboard is accessed over Tailscale, a LAN
// IP, or a reverse proxy, the browser receives the SSR HTML but the client
// bundle cannot finish hydrating because dev-resource requests are rejected —
// useEffect never fires, the CSRF token is never fetched, and the login form
// is stuck.
//
// Set DASHBOARD_ALLOWED_DEV_ORIGINS to a comma-separated list of hostnames or
// IPs to whitelist (e.g. "100.64.95.40,mybox.local,dashboard.example.com").
// Localhost is always allowed. Only reads in development; production builds
// ignore the setting.
const allowedDevOrigins = (process.env.DASHBOARD_ALLOWED_DEV_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // Deploys build into NEXT_DIST_DIR (.next-build) and swap it in at the end, so the running app never reads a
  // half-built .next (2026-10-02: rebuilding in place took app.example.com down during each build).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  ...(deploymentId ? { deploymentId } : {}),
  serverExternalPackages: ['better-sqlite3', '@resvg/resvg-js'], // resvg: native PNG renderer for Slack charts (lib/charts)
  // Home has its own package-lock and a node_modules symlink off this disk.
  // Pin the build to this app so Turbopack does not walk up there.
  turbopack: { root: process.cwd() },
  // Client router cache (2026-09-29, D: location/range switches felt slow): a page seen in the last two
  // minutes is shown from memory when its tab is tapped again; the data behind it is stale-while-revalidate
  // for 15 minutes anyway, so nothing gets older than it already was.
  experimental: { staleTimes: { dynamic: 120, static: 300 } },
  ...(allowedDevOrigins.length > 0 && { allowedDevOrigins }),
  // Icons browsers fetch on their own: /favicon.ico and the
  // home-screen names iOS and bookmarks ask for were a 404 or the old static files; they now draw the agency's logo like the tab icon does
  // (app/icon/[size], app/apple-icon, lib/brand-icon.tsx). beforeFiles so they win over anything left in public/.
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/favicon.ico', destination: '/icon/32' },
        { source: '/apple-touch-icon.png', destination: '/apple-icon' },
        { source: '/apple-touch-icon-precomposed.png', destination: '/apple-icon' },
        { source: '/icon-192.png', destination: '/icon/192' },
        { source: '/icon-512.png', destination: '/icon/512' },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [
      {
        // Prevent aggressive caching of API routes and pages through the tunnel
        source: '/((?!_next/static).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
