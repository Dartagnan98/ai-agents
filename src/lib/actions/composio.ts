'use server';

import { requireFullAccess } from '@/lib/user-access';
import { SLUG, bestOf, composioConnections, composioInfo, composioKeyKind, composioLink, composioRemove, loadCatalog, loginWithUserKey, logoUrl, pendingLogin, projectKeySaved, saveProjectKey, searchCatalog, startLogin, type App, type ConnStatus } from '@/lib/connectors/composio';

// Settings > Connectors > Apps (2026-09-29): the Composio app gallery. Every card is an app the fleet agents
// can act in once it is linked; the featured ones are the template's core stack.
export interface AppAccount { alias: string | null; status: ConnStatus; id: string }
export interface AppCard { slug: string; name: string; logo: string; status: ConnStatus; alias: string | null; tools: number; description: string; auth: string[]; accounts: AppAccount[] }
export interface ComposioState { installed: boolean; signedIn: boolean; projectKey: boolean; email: string | null; note: string; pending: { url: string; expiresAt: string } | null; apps: AppCard[] }

/** The template's core stack, in the order the gallery shows them. Names override Composio's where it reads oddly. */
// the apps a new install suggests (one click each); any of the catalog's others is under Connect an app
const FEATURED: [string, string][] = [
  ['gmail', 'Gmail'], ['googlecalendar', 'Google Calendar'], ['googledrive', 'Google Drive'], ['googledocs', 'Google Docs'], ['googlesheets', 'Google Sheets'],
  ['slack', 'Slack'], ['notion', 'Notion'], ['github', 'GitHub'], ['linear', 'Linear'], ['outlook', 'Outlook'],
];
/** "bing_webmaster_tools" -> "Bing Webmaster Tools" when the catalog cache has no name for it. */
const titleCase = (slug: string) => slug.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function card(slug: string, conns: Record<string, { status: string; alias?: string | null; word_id?: string }[]>, byslug: Map<string, App>, name?: string): AppCard {
  const a = byslug.get(slug);
  const { status, alias } = bestOf(conns[slug]);
  const accounts: AppAccount[] = (conns[slug] ?? []).map((c) => ({ alias: c.alias ?? null, status: bestOf([c]).status, id: c.word_id ?? '' }));
  return { slug, name: name ?? a?.name ?? titleCase(slug), logo: logoUrl(slug), status, alias, tools: a?.tools ?? 0, description: a?.description ?? '', auth: a?.auth ?? [], accounts };
}

export async function fetchComposio(): Promise<ComposioState> {
  await requireFullAccess();
  const info = await composioInfo();
  const conns = info.available ? await composioConnections() : {};
  const byslug = new Map((await loadCatalog()).map((a) => [a.slug, a]));
  const apps = FEATURED.map(([slug, name]) => card(slug, conns, byslug, name));
  for (const slug of Object.keys(conns).sort()) if (SLUG.test(slug) && !apps.some((a) => a.slug === slug) && bestOf(conns[slug]).status !== 'NONE') apps.push(card(slug, conns, byslug));
  return { installed: info.note !== 'The Composio CLI is not installed on this server.', signedIn: info.available, projectKey: projectKeySaved(), email: info.email, note: info.note, pending: info.available ? null : pendingLogin(), apps };
}

/** Every app in the Composio catalog. An empty query is the full list; a search narrows it. */
export async function searchApps(q: string): Promise<AppCard[]> {
  await requireFullAccess();
  const apps = await loadCatalog();
  const conns = await composioConnections();
  const byslug = new Map(apps.map((a) => [a.slug, a]));
  const list = q.trim()
    ? await searchCatalog(q, 2000)
    : [...apps].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return list.map((a) => card(a.slug, conns, byslug));
}

/** Remove one linked account by its word id. Other accounts of the same app stay. */
export async function removeAppAccount(id: string): Promise<{ success: true } | { success: false; error: string }> {
  await requireFullAccess();
  const r = await composioRemove(id);
  return 'ok' in r ? { success: true } : { success: false, error: r.error };
}

/** Mint a hosted sign-in link; `alias` names a second (third...) account of the same app. */
export async function linkApp(slug: string, alias?: string): Promise<{ success: true; url: string } | { success: false; error: string }> {
  await requireFullAccess();
  if (!SLUG.test(slug)) return { success: false, error: 'Unknown app.' };
  const r = await composioLink(slug, alias?.trim().toLowerCase() || undefined);
  return 'url' in r ? { success: true, url: r.url } : { success: false, error: r.error };
}

export async function connectComposio(switching = false): Promise<{ success: true; url: string } | { success: false; error: string }> {
  await requireFullAccess();
  const r = await startLogin(switching);
  return 'url' in r ? { success: true, url: r.url } : { success: false, error: r.error };
}

/** Paste a project key (ak_, stored for the API) or a user key (uak_, signs the CLI in). Neither value is returned. */
export async function saveComposioKey(key: string): Promise<{ success: true; kind: 'project' | 'user' } | { success: false; error: string }> {
  await requireFullAccess();
  const kind = composioKeyKind(key);
  if (kind === 'project') {
    const r = await saveProjectKey(key);
    return 'ok' in r ? { success: true, kind: 'project' } : { success: false, error: r.error };
  }
  if (kind === 'org') return { success: false, error: 'That is an organization key. Paste a project key (ak_) or a user key (uak_).' };
  if (kind !== 'user') return { success: false, error: 'That does not look like a Composio key. A project key starts with ak_. A user key starts with uak_.' };
  const r = await loginWithUserKey(key);
  return 'ok' in r ? { success: true, kind: 'user' } : { success: false, error: r.error };
}
