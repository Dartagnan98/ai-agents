import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { getGrant, sessionUserId } from '@/lib/user-access';
import { setInstallValue, setupState, setupTokenRequired, usersCount } from '@/lib/agency-setup';
import { OwnerForm } from '@/components/setup/owner-form';

export const dynamic = 'force-dynamic';

// First-run agency setup (D, 2026-10-07). Public in the middleware so the empty install can make its owner; everything after that needs
// the owner or an admin signed in. Once Go live is pressed (or on an install that had logins before this existed) it sends you home.
function Frame({ title, sub, wide, children }: { title: string; sub: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <main className="min-h-dvh bg-background px-4 py-8 sm:px-8 sm:py-12">
      <div className={wide ? 'mx-auto flex max-w-[1180px] flex-col gap-6' : 'mx-auto flex max-w-[460px] flex-col gap-6'}>
        <header className="flex flex-col gap-1.5">
          <span className="micro-label">Setup</span>
          <h1 className="font-heading text-[26px] font-semibold tracking-[-0.02em] sm:text-[30px]">{title}</h1>
          <p className="max-w-[75ch] text-[13.5px] leading-relaxed text-muted-foreground">{sub}</p>
        </header>
        {children}
      </div>
    </main>
  );
}

export default async function SetupPage() {
  const state = setupState();
  if (usersCount() === 0) {
    if (state === 'complete') redirect('/login');
    return (
      <Frame title="Make your login" sub="This install is new. Make the owner login: the owner sets up the AI connection, the agents and who else can sign in.">
        <section className="rounded-[22px] bg-card px-5 py-6 shadow-[var(--card-shadow)] sm:px-7"><OwnerForm needsToken={setupTokenRequired()} /></section>
      </Frame>
    );
  }
  const session = await auth();
  const uid = sessionUserId(session);
  if (!session || !uid) redirect('/login?callbackUrl=%2Fsetup');
  if (state === 'complete') redirect('/');
  const role = getGrant(uid).role;
  // the AI agents app has no agency wizard: once the owner has signed in, setup is done and the chat opens
  if ((role as string) === 'owner' || role === 'admin') { setInstallValue('agency_setup', 'complete', 'AI agents app: owner made'); redirect('/ai'); }
  return <Frame title="Almost ready" sub="The owner is still setting up this install."><span /></Frame>;
}
