import { PageHeader } from '@/components/shared/page-kit';
import { SettingsView } from '@/components/settings/settings-view';
import { SETTINGS_SECTIONS } from '@/components/settings/sections';
import { PhoneSettingsHome } from '@/components/settings/phone-settings-home';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

// Settings: the open section's own title and one line on what it is for (D, 2026-10-09: settings cleanup), then the section.
// The section list is the sidebar on desktop and a pill row on phones (components/settings/settings-view.tsx).
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const params = await searchParams;
  const s = SETTINGS_SECTIONS.find((x) => x.id === params.tab) ?? SETTINGS_SECTIONS[0];
  // phones (the SetHome board): no section picked = the Settings list; a section = its own page with a way back
  const home = !params.tab;
  return (
    <>
      {home && <PhoneSettingsHome />}
      <div className={`flex flex-col gap-6 ${home ? 'max-md:hidden' : ''}`}>
        <Link href="/settings" className="-mb-3 flex items-center gap-1 text-[17px] text-cobalt md:hidden">
          <svg width="12" height="18" viewBox="0 0 12 20" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden><path d="M10 2L2 10l8 8" /></svg>Settings
        </Link>
        <PageHeader title={s.label} purpose={s.about} />
        <SettingsView />
      </div>
    </>
  );
}
