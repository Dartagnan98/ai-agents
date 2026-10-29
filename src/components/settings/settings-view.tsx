'use client';

import { SETTINGS_SECTIONS } from '@/components/settings/sections';
import { AiConnectionsTab } from '@/components/settings/ai-connections-tab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AllowedRootsTab } from '@/components/settings/allowed-roots-tab';
import { UsersTab } from '@/components/settings/users-tab';
import { ConnectorsTab } from '@/components/settings/connectors-tab';
import { AppearanceTab } from '@/components/settings/appearance-tab';
import { useOrg } from '@/hooks/use-org';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const TRIGGER = 'h-[34px] flex-none gap-2 px-3.5 text-[13px]';
const ICON = 'size-4';

/**
 * Settings sections as kit pill tabs; the bar scrolls sideways on phones. Organization follows the
 * org picked in the top bar and starts fresh when it changes (no half-made edits carried over).
 */
const TABS: string[] = SETTINGS_SECTIONS.map((x) => x.id);

export function SettingsView() {
  const { currentOrg, orgs } = useOrg();
  // ?tab= opens a section directly (the Setup checklist links here).
  const wanted = useSearchParams().get('tab');
  const current = wanted && TABS.includes(wanted) ? wanted : 'ai';
  // the section lives in the URL (D, 2026-10-09: settings in the left sidebar on desktop, which links to ?tab=)
  const router = useRouter(), pathname = usePathname(), sp = useSearchParams();
  const pick = (v: string) => { const q = new URLSearchParams(sp.toString()); q.set('tab', v); router.replace(`${pathname}?${q}`, { scroll: false }); };
  return (
    <Tabs value={current} onValueChange={(v) => pick(String(v))} className="flex flex-col gap-6">
      <div className="hidden">{/* phones open sections from the Settings list (phone-settings-home.tsx); desktop uses the sidebar */}
        <TabsList aria-label="Settings sections" className="h-auto max-w-full justify-start gap-0.5 overflow-x-auto border border-border bg-card p-[3px] [scrollbar-width:none]">
          {SETTINGS_SECTIONS.filter((x) => x.group !== 'AI' || orgs.length > 0).map(({ id, label, icon: I }) => <TabsTrigger key={id} value={id} className={TRIGGER}><I className={ICON} stroke={1.7} />{label}</TabsTrigger>)}
        </TabsList>
      </div>

      <TabsContent value="ai">
        <AiConnectionsTab />
      </TabsContent>

      <TabsContent value="connectors">
        <ConnectorsTab />
      </TabsContent>

      <TabsContent value="users">
        <UsersTab />
      </TabsContent>

      <TabsContent value="allowed-roots">
        <div className="max-w-4xl">
          <AllowedRootsTab />
        </div>
      </TabsContent>

      <TabsContent value="appearance">
        <div className="max-w-2xl">
          <AppearanceTab />
        </div>
      </TabsContent>
    </Tabs>
  );
}
