'use client';

import { createContext, useContext } from 'react';
import { cn } from '@/lib/utils';
import { DEFAULT_TZ, setBrowserTz } from '@/lib/tz';
import { setBrowserCurrency } from '@/lib/currency';

// The install's name and monogram (lib/brand.ts), handed down from the root layout to the login page, the
// splash, the rail and the tab labels. tz + currency (HARDCODE_AUDIT B1/B4, D 2026-10-10): the agency's reporting zone and money
// currency, so client code formats times and money the agency's way (useBrand().tz, or agencyTz() from lib/tz.ts).
export interface Brand { name: string; short: string; mono: string; tz: string; currency: string; wordmark?: string } // wordmark: /wordmark address when the agency set a wide logo // short: Settings › Businesses short name, used inside sentences
const BrandContext = createContext<Brand>({ name: '', short: '', mono: '', tz: DEFAULT_TZ, currency: 'USD' }); // always provided by the root layout
export const BrandProvider = ({ brand, children }: { brand: Brand; children: React.ReactNode }) => {
  setBrowserTz(brand.tz); setBrowserCurrency(brand.currency); // browser only; before children render, so their formatters read the agency's zone and money
  return <BrandContext.Provider value={brand}>{children}</BrandContext.Provider>;
};
export const useBrand = () => useContext(BrandContext);

/** The sign-in pages' mark: the agency's wide logo when set (Settings › Agency, D 2026-10-12), else the monogram tile. */
export function AuthMark() {
  const { wordmark, name } = useBrand();
  // eslint-disable-next-line @next/next/no-img-element
  return wordmark ? <img src={wordmark} alt={name} className="mx-auto h-10 w-auto max-w-[240px] object-contain dark:invert" /> : <BrandMark dark className="mx-auto size-12 rounded-[15px]" />;
}

/** The brand's monogram (else the name's initials, else a plain dot: white label, no product mark). `dark` = white on ink (login), else
 *  ink on white (rail). */
export function BrandMark({ className, dark = false }: { className?: string; dark?: boolean }) {
  const { mono, name } = useBrand();
  const ink = dark ? '#FFFFFF' : '#0E1422';
  const text = mono || name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return (
    <span className={cn('flex size-10 items-center justify-center rounded-[13px]', dark ? 'bg-[#0E1422]' : 'bg-white', className)}>
      {text
        ? <span className="font-heading text-[15px] font-bold tracking-[-0.02em]" style={{ color: ink }}>{text}</span>
        : <span aria-hidden className="size-2.5 rounded-full" style={{ background: ink }} />}
    </span>
  );
}
