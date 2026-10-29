import 'server-only';
import fs from 'fs';
import path from 'path';
import { db } from '@/lib/db';
import { driveDir } from '@/lib/drive/service';
import { membershipByLocal, platformDb } from '@/lib/platform/db';
import { isMultiTenant } from '@/lib/platform/mode';
import { currentAgencySync } from '@/lib/platform/tenant-db';
import { getGrant } from '@/lib/user-access';

// HTML pages published by workspace scripts. One file per name,
// republishing replaces it, per agency next to its Drive. Every page needs an agency sign-in:
// "specific_members" opens to owners, admins and the named people (matched by email); anything else to any signed-in login.
export type PageAccess = 'members' | 'workspace';
export interface PageMeta { name: string; title: string; access: PageAccess; emails: string[]; updatedAt: string }

export const MAX_PAGE_BYTES = 5_000_000;
const NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
const dir = () => path.join(path.dirname(driveDir()), 'published-pages');
const fileOf = (name: string, ext: 'html' | 'json') => (NAME.test(name) ? path.join(dir(), `${name}.${ext}`) : null);

/** A page name ("Weekly Report", "team-notes-v2") as a URL-safe name. */
export const pageName = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export function savePage(name: string, html: string, access: PageAccess, emails: string[]): PageMeta {
  const h = fileOf(name, 'html'), j = fileOf(name, 'json');
  if (!h || !j) throw new Error('name is letters, digits and dashes.');
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw new Error('The page is over 5 MB.');
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim() || name;
  const meta: PageMeta = { name, title, access, emails: [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))], updatedAt: new Date().toISOString() };
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(`${h}.tmp`, html);
  fs.renameSync(`${h}.tmp`, h);
  fs.writeFileSync(j, JSON.stringify(meta));
  return meta;
}

export function readPage(name: string): { meta: PageMeta; html: Buffer } | null {
  const h = fileOf(name, 'html'), j = fileOf(name, 'json');
  if (!h || !j || !fs.existsSync(h) || !fs.existsSync(j)) return null;
  return { meta: JSON.parse(fs.readFileSync(j, 'utf8')) as PageMeta, html: fs.readFileSync(h) };
}

/** The login's email (platform account), else its username: what "specific_members" matches against. */
function loginEmail(uid: number): string {
  if (isMultiTenant()) {
    const m = membershipByLocal(currentAgencySync().id, uid);
    const u = m && platformDb().prepare('SELECT email, username FROM users WHERE id = ?').get(m.userId) as { email: string | null; username: string | null } | undefined;
    if (u) return (u.email || u.username || '').toLowerCase();
  }
  return ((db.prepare('SELECT username FROM users WHERE id = ?').get(uid) as { username: string } | undefined)?.username ?? '').toLowerCase();
}

export function maySee(meta: PageMeta, uid: number): boolean {
  const g = getGrant(uid);
  if (g.role === 'owner' || g.role === 'admin') return true;
  if (meta.access === 'workspace') return Object.keys(g.businesses).length > 0; // a removed or empty login sees nothing
  const email = loginEmail(uid);
  return !!email && meta.emails.includes(email);
}
