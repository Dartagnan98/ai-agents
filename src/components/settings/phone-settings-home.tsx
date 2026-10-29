import Link from 'next/link';
import { IconChevronRight } from '@tabler/icons-react';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from '@/components/settings/sections';

const ROW = 'flex min-h-[52px] items-center gap-3.5 px-4 py-2 text-[17px]';
const SEP = 'border-t border-[rgba(60,60,67,0.12)] dark:border-white/10';

// Phone Settings home (the SetHome board, D 2026-10-15): Setup on its own, then each group as an inset list of rows with an icon and a
// chevron, like Settings on an iPhone. A row opens that section as its own page (?tab=). Desktop keeps the sidebar.
export function PhoneSettingsHome() {
  const setup = SETTINGS_SECTIONS.find((x) => x.id === 'setup');
  return (
    <div className="flex flex-col gap-2 md:hidden">
      <h1 className="mb-2">Settings</h1>
      {setup && (
        <Link href="/settings?tab=setup" className={`${ROW} mb-4 rounded-[22px] bg-card`}>
          <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-cobalt text-white"><setup.icon size={19} stroke={2} /></span>
          <span className="min-w-0 flex-1"><span className="block">Setup</span><span className="block text-[13px] text-muted-foreground">{setup.about}</span></span>
          <IconChevronRight size={16} stroke={2.4} className="shrink-0 text-[#A3A3A8]" />
        </Link>
      )}
      {SETTINGS_GROUPS.map((g) => {
        const list = SETTINGS_SECTIONS.filter((x) => x.group === g && x.id !== 'setup');
        if (!list.length) return null;
        return (
          <section key={g} className="mb-4">
            <h3 className="mx-4 mb-1.5 text-[13px] font-semibold uppercase tracking-[0.02em] text-muted-foreground">{g}</h3>
            <div className="overflow-hidden rounded-[22px] bg-card">
              {list.map(({ id, label, icon: I }, i) => (
                <Link key={id} href={`/settings?tab=${id}`} className={`${ROW} ${i > 0 ? SEP : ''}`}>
                  <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-cobalt text-white"><I size={17} stroke={2} /></span>
                  <span className="flex-1 truncate">{label}</span>
                  <IconChevronRight size={16} stroke={2.4} className="shrink-0 text-[#A3A3A8]" />
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
