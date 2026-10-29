import type { Brand } from '@/components/brand';
import { reportTz } from '@/lib/report-tz';

/** The app's name: APP_NAME in .env.local, else AI Agents. */
const NAME = process.env.APP_NAME || 'AI Agents';
export const PRODUCT_BRAND: Brand = { name: NAME, short: NAME, mono: 'AI', tz: 'America/New_York', currency: 'USD' };

export function getBrand(): Brand { return brandContext().brand; }

/** The brand plus what the root layout needs for icons and the manifest. */
export function brandContext(): { brand: Brand; ref: string | null; neutral: boolean } {
  return { brand: { ...PRODUCT_BRAND, tz: reportTz() }, ref: null, neutral: false };
}
