'use client';

import { createContext, useContext, useEffect, useState } from 'react';

// A page's own sub-tabs (components/shared/sub-tabs.tsx) reported to the desktop sidebar, which lists them under the page
// (D, 2026-10-09: "tabs and sub tabs all in line"). Each page still decides its own list (agency vs contract, role), so the
// sidebar never keeps a second copy of it. The last list seen per page is remembered, so a page shows its sub-pages before it opens.
export interface SubItem { label: string; href: string; on: boolean }
export interface SubReport { path: string; items: SubItem[] }
type Ctx = { report: SubReport | null; seen: Record<string, { label: string; href: string }[]>; set: (r: SubReport | null) => void };
const SubTabsContext = createContext<Ctx>({ report: null, seen: {}, set: () => {} });

const KEY = 'fleet-subtabs-seen';
export function SubTabsProvider({ children }: { children: React.ReactNode }) {
  const [report, setReport] = useState<SubReport | null>(null);
  const [seen, setSeen] = useState<Ctx['seen']>({});
  useEffect(() => { try { setSeen(JSON.parse(sessionStorage.getItem(KEY) || '{}')); } catch { /* storage blocked */ } }, []);
  const set = (r: SubReport | null) => {
    setReport(r);
    if (!r) return;
    setSeen((s) => {
      const next = { ...s, [r.path]: r.items.map(({ label, href }) => ({ label, href })) };
      try { sessionStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
      return next;
    });
  };
  return <SubTabsContext.Provider value={{ report, seen, set }}>{children}</SubTabsContext.Provider>;
}
export const useSubTabs = () => useContext(SubTabsContext);

/** Rendered by SubTabs: tells the sidebar this page's sub-pages and which one is open. */
export function SubTabsReport({ path, items }: SubReport) {
  const { set } = useContext(SubTabsContext);
  const sig = JSON.stringify(items);
  useEffect(() => { set({ path, items }); return () => set(null); }, [path, sig]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
