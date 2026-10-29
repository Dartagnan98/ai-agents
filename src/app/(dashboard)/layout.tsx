import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { buildAreas } from '@/lib/nav';
import { getBrand } from '@/lib/brand';
import { filterAreas, NO_ACCESS, landingHref, pathAllowed } from '@/lib/access';
import { getGrant, realSessionUserId, sessionUserId } from '@/lib/user-access';
import { ViewAsBar } from '@/components/shared/view-as-bar';
import { db } from '@/lib/db';
import { DashboardShell } from '@/components/layout/dashboard-shell';
import { PopoverCloser } from '@/components/shared/popover-closer';
import { setupPending } from '@/lib/agency-setup';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect('/login');
  const pathname = (await headers()).get('x-pathname') ?? '';
  // a new install makes its owner login first (app/setup)
  if (setupPending()) redirect('/setup');

  const all = buildAreas(getBrand().name);
  const userId = sessionUserId(session);
  const grant = userId ? getGrant(userId) : NO_ACCESS;
  const areas = filterAreas(all, grant);
  if (pathname && !pathAllowed(all, areas, pathname, grant.role === 'owner')) redirect(landingHref(areas));

  // View as (lib/view-as.ts): an owner looking as someone else, read-only
  const viewing = userId !== null && userId !== realSessionUserId(session)
    ? (db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined)?.username ?? `login ${userId}` : null;

  return (
    <DashboardShell orgs={[]} areas={areas} views={false} staff={false}>
      <PopoverCloser />{viewing && <ViewAsBar name={viewing} />}{children}
    </DashboardShell>
  );
}
