import { locate, type Area } from './nav';

// Who sees what. Owner and admin: every page (admins cannot change owners). Everyone else (a member): the AI chat only, with their
// own notes and files (lib/ai/access.ts). Older stored roles (manager, client, user) all read as a member.
export type AccessRole = 'owner' | 'admin' | 'manager' | 'client' | 'user';

export interface AccessGrant {
  role: AccessRole;
  ai: string[];
  /** kept for stored grants from older installs; always empty here */
  businesses: Record<string, string[]>;
  rep?: boolean;
}

export const OWNER_ACCESS: AccessGrant = { role: 'owner', ai: [], businesses: {} };
export const FULL_ACCESS: AccessGrant = OWNER_ACCESS;
/** A session whose login cannot be found: nothing open. */
export const NO_ACCESS: AccessGrant = { role: 'user', ai: [], businesses: {} };

const isAdmin = (g: AccessGrant) => g.role === 'owner' || g.role === 'admin';
/** A member reaches the chat (/ai) only. */
const MEMBER_PAGES = new Set(['/ai']);

/** Areas this grant can see. */
export function filterAreas(areas: Area[], grant: AccessGrant): Area[] {
  if (isAdmin(grant)) return areas;
  if (grant.role === 'user') return [];
  return areas.map((a) => ({ ...a, tabs: a.tabs.filter((t) => MEMBER_PAGES.has(t.href)) })).filter((a) => a.tabs.length);
}

/** Where a signed-in user lands: their first allowed page, or the empty-access screen. */
export function landingHref(areas: Area[]): string {
  return homeArea(areas)?.tabs[0]?.href ?? '/no-access';
}

export function homeArea(areas: Area[]): Area | undefined {
  return areas.find((a) => a.tabs.length);
}

/** A path the app knows is allowed only when this user's areas contain that same page. */
export function pathAllowed(all: Area[], visible: Area[], pathname: string, owner: boolean): boolean {
  if (owner || pathname === '/' || pathname === '/no-access') return true;
  const wanted = locate(all, pathname).tab;
  const got = locate(visible, pathname).tab;
  if (!wanted) return true; // not a nav page (account pages and the like): each page checks itself
  if (!got) return false;
  return got.href === wanted.href || got.href.length > wanted.href.length;
}

/** A grant as stored: owner and admin keep their role; anything else is a member. */
export function normalizeGrant(grant: AccessGrant): AccessGrant {
  if (grant.role === 'owner') return { ...OWNER_ACCESS };
  if (grant.role === 'admin') return { role: 'admin', ai: [], businesses: {} };
  return { role: grant.role === 'user' ? 'user' : 'manager', ai: [], businesses: {} };
}
