import 'server-only';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { composioConnections, composioExecute } from '@/lib/connectors/composio';

// Connected apps for agents (D, 2026-10-09, "Use my connected apps"): an agent given apps (slack, gmail, googlesheets...)
// can search those apps' tools and run them through the Composio connections in Settings › Connectors. Reading runs at once;
// anything that sends, creates, updates or deletes becomes an Approve card first (lib/ai/approvals.ts).
const CLI = process.env.COMPOSIO_CLI || path.join(process.env.COMPOSIO_HOME || path.join(os.homedir(), '.composio'), 'composio');
const READ = /_(FIND|LIST|GET|FETCH|SEARCH|RETRIEVE|READ|DESCRIBE|COUNT|LOOKUP)(_|$)/;
export const isReadTool = (slug: string) => READ.test(slug.toUpperCase());
/** The app a tool slug belongs to ('SLACK_SEND_MESSAGE' -> 'slack'), checked against the agent's apps. */
export const appOfTool = (slug: string, apps: string[]) => apps.find((a) => slug.toUpperCase().startsWith(`${a.toUpperCase()}_`)) ?? null;

/** Apps with an ACTIVE connection here (the agent editor offers these). */
// Kept 5 minutes, refreshed behind the answer (perf audit 2026-10-16: the Agents list waited ~0.9 s on Composio every open).
// ponytail: one cache for the install; per agency once agencies get their own Composio accounts.
let appsMemo: { at: number; v: Promise<string[]> } | null = null;
const loadApps = async (): Promise<string[]> => {
  const all = await composioConnections().catch(() => ({} as Record<string, { status: string }[]>));
  return Object.entries(all).filter(([, list]) => list.some((c) => c.status === 'ACTIVE')).map(([slug]) => slug).sort();
};
export async function connectedApps(): Promise<string[]> {
  if (!appsMemo) appsMemo = { at: Date.now(), v: loadApps() };
  else if (Date.now() - appsMemo.at > 5 * 60_000) { const m = appsMemo; m.at = Date.now(); void loadApps().then((x) => { m.v = Promise.resolve(x); }, () => {}); } // keep answering with the last list until the new one lands
  return appsMemo.v;
}
export function searchAppTools(query: string, apps: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(CLI, ['search', query, '--toolkits', apps.join(','), '--limit', '5'], { timeout: 40_000, maxBuffer: 4_000_000 }, (err, stdout) => {
      if (err) { resolve(`Tool search failed: ${String(err.message).slice(0, 200)}`); return; }
      const out = String(stdout); resolve(out.length > 12_000 ? `${out.slice(0, 12_000)}\n[cut]` : out);
    });
  });
}
export async function runAppTool(slug: string, data: Record<string, unknown>): Promise<string> {
  const r = await composioExecute(slug, data);
  if ('error' in r) throw new Error(r.error);
  const text = JSON.stringify(r.data);
  return text.length > 20_000 ? `${text.slice(0, 20_000)}[cut]` : text;
}
