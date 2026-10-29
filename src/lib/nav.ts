// a logo's address carries a short fingerprint so browsers cache it until it changes (the image itself is served by app/api/logo)
export const logoVersion = (s: string) => { let h = 0; for (let i = 0; i < s.length; i += 97) h = (h * 31 + s.charCodeAt(i)) | 0; return `${s.length.toString(36)}${(h >>> 0).toString(36)}`; };

// App navigation (Porcelain Signal redesign, 2026-09-29): a rail of areas, each area's pages run as
// tabs along the top. One source for the rail, the tabs, the phone bar, the More sheet and ⌘K.
export type AreaKey = string;
/** `also`: older hrefs that now live on this page: the tab stays lit and access follows it. */
export interface NavTab { label: string; href: string; id?: string; also?: string[] }
export interface Area { key: AreaKey; label: string; short: string; name: string; mono: string; business: boolean; tabs: NavTab[]; module?: string; logo?: string }

const CORE: Area[] = [
  // AI = the chat and the Inbox; then Agents, Automation, Performance, Memory and Library
  { key: 'HOME', label: 'COMMAND', short: 'AI', name: 'AI', mono: 'AI', business: false, tabs: [{ label: 'AI', href: '/ai' }, { label: 'Inbox', href: '/ai/inbox' }] },
  { key: 'OPS', label: 'AGENTS', short: 'Agents', name: 'Agents', mono: 'AG', business: false, tabs: [
    { label: 'Agents', href: '/ai/agents' }, { label: 'Tasks', href: '/ai/tasks' }, { label: 'Comms', href: '/ai/comms' }, { label: 'Tests', href: '/ai/tests' },
  ] },
  { key: 'AUTO', label: 'AUTOMATION', short: 'Automation', name: 'Automation', mono: 'AU', business: false, tabs: [
    { label: 'Routines', href: '/ai/routines' }, { label: 'Automations', href: '/ai/automations' },
  ] },
  { key: 'PERF', label: 'PERFORMANCE', short: 'Performance', name: 'Performance', mono: 'PF', business: false, tabs: [
    { label: 'Fleet health', href: '/workflows/health' }, { label: 'Analytics', href: '/analytics' }, { label: 'Strategy', href: '/strategy' },
  ] },
  { key: 'INTEL', label: 'MEMORY', short: 'Memory', name: 'Memory', mono: 'ME', business: false, tabs: [
    { label: 'Memory', href: '/ai/memory' }, { label: 'Graph', href: '/ai/graph' }, { label: 'Skills', href: '/ai/skills' },
  ] },
  { key: 'LIB', label: 'LIBRARY', short: 'Library', name: 'Library', mono: 'LB', business: false, tabs: [
    { label: 'Knowledge', href: '/knowledge-base' }, { label: 'Wiki', href: '/wiki' }, { label: 'Experiments', href: '/experiments' },
  ] },
];
const SETTINGS: Area = { key: 'SETTINGS', label: 'SETTINGS', short: 'Settings', name: 'Settings', mono: 'ST', business: false, tabs: [{ label: 'Settings', href: '/settings' }] };

/** The AI area's own pages (the agents's agents, routines, skills, memory, graph, comms): every owner and admin's, whichever menu they sit in. */
export const isAiPage = (href: string) => href === '/ai' || href.startsWith('/ai/');

/** Operations and Intelligence: the AI side pages an admin can be given one by one. The AI area itself (HOME) is every owner and
 *  admin's, always (D, 2026-10-09), so it has no switches. */
export function aiAreas(): { key: string; label: string; tabs: NavTab[] }[] {
  // the AI pages that moved in (/ai/...) stay every admin's (isAiPage), so they are no switch here
  return CORE.filter((a) => a.key !== 'HOME' && a.key !== 'LEGACY').map((a) => ({ key: a.key, label: a.short, tabs: a.tabs.filter((t) => !isAiPage(t.href)) }));
}

/** Every page of the app, by area. */
export function buildAreas(brand = 'Dashboard'): Area[] {
  // the areas read "<BRAND> · SETTINGS" at the top of the page (lib/brand.ts)
  const branded = (a: Area): Area => ({ ...a, label: `${brand.toUpperCase()} · ${a.label}` });
  return [...CORE.map(branded), branded(SETTINGS)];
}

export const AREAS: Area[] = buildAreas();

/** The area and tab for a path: the longest tab href that prefixes it ('/' only matches itself). */
const EMPTY_AREA: Area = { key: 'NONE', label: 'DASHBOARD', short: 'Dashboard', name: 'Dashboard', mono: 'D', business: false, tabs: [] };

export function locate(areas: Area[], pathname: string): { area: Area; tab: NavTab | null } {
  if (areas.length === 0) return { area: EMPTY_AREA, tab: null };
  let best: { area: Area; tab: NavTab } | null = null;
  let bestLen = 0;
  for (const area of areas) for (const tab of area.tabs) for (const h of [tab.href, ...(tab.also ?? [])]) {
    const hit = h === '/' ? pathname === '/' : pathname === h || pathname.startsWith(`${h}/`);
    if (hit && (!best || h.length > bestLen)) { best = { area, tab }; bestLen = h.length; }
  }
  return best ?? { area: areas[0], tab: null };
}

/** A nav href with the current ?org= carried over. */
export const withOrg = (href: string, org: string | null | undefined) => (org && org !== 'all' ? `${href}?org=${encodeURIComponent(org)}` : href);

/** The same page in another business, keeping the date range (D, 2026-10-02: switching contract while on Leads should
 *  stay on Leads, to compare); the business's first page when it has no such page. */
export function sameTabHref(target: Area, pathname: string, search = ''): string {
  const first = target.tabs[0]?.href ?? '/';
  const m = pathname.match(/^\/b\/[^/]+(\/[^?#]*)?$/);
  if (!m) return first;
  const want = `/b/${target.key}${m[1] ?? ''}`;
  const tab = target.tabs.find((t) => t.href === want);
  if (!tab) return first;
  const q = new URLSearchParams(search), keep = new URLSearchParams();
  for (const k of ['range', 'cmp', 'from', 'to', 'source']) { const v = q.get(k); if (v) keep.set(k, v); }
  return keep.size ? `${tab.href}?${keep}` : tab.href;
}
