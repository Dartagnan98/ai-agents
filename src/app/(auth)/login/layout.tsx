import { redirect } from 'next/navigation';
import { setupPending, usersCount } from '@/lib/agency-setup';

export const dynamic = 'force-dynamic';

// A new install with no login yet has nobody to sign in: /setup makes the owner first.
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  if (setupPending() && usersCount() === 0) redirect('/setup');
  return <>{children}</>;
}
