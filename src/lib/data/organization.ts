// AI Agents - Organization metadata reader
// Reads context.json and brand-voice.md from the framework root org directory.

import fs from 'fs';
import { getOrgs, getOrgContextPath, getOrgBrandVoicePath } from '@/lib/config';

export interface OrgContext {
  name: string;
  description: string;
  industry: string;
  icp: string;
  value_prop: string;
}

const DEFAULT_CONTEXT: OrgContext = {
  name: '',
  description: '',
  industry: '',
  icp: '',
  value_prop: '',
};

/**
 * The org Settings > Organization edits: the org picked in the top bar (?org=) when it is a real
 * org, else the first org with a context.json, else the first org ('' when there are none).
 * `picked` is false for the fallback, so the page can say which org it chose.
 */
export function resolveSettingsOrg(requested?: string | null): { org: string; picked: boolean } {
  const orgs = getOrgs();
  if (requested && requested !== 'all' && orgs.includes(requested)) return { org: requested, picked: true };
  return { org: orgs.find((o) => fs.existsSync(getOrgContextPath(o))) ?? orgs[0] ?? '', picked: false };
}

/**
 * Read context.json for an org. Returns defaults if file missing.
 */
export function getOrganizationContext(org: string): OrgContext {
  const filePath = getOrgContextPath(org);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_CONTEXT };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return {
      name: data.name ?? '',
      description: data.description ?? '',
      industry: data.industry ?? '',
      icp: data.icp ?? '',
      value_prop: data.value_prop ?? '',
    };
  } catch {
    return { ...DEFAULT_CONTEXT };
  }
}

/**
 * Read brand-voice.md for an org. Returns empty string if missing.
 */
export function getBrandVoice(org: string): string {
  const filePath = getOrgBrandVoicePath(org);
  if (!fs.existsSync(filePath)) {
    return '';
  }
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}
