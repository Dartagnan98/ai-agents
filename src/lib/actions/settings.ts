'use server';

import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { revalidatePath } from 'next/cache';
import { CTX_ROOT, getOrgs, getAgentsForOrg, getAgentDir, getOrgContextPath, getOrgBrandVoicePath, getAllowedRootsConfigPath } from '@/lib/config';
import { db } from '@/lib/db';
import { resolveSettingsOrg } from '@/lib/data/organization';
import { BRAND_VOICE_FIELDS, buildBrandVoice, formatJsonLike, parseBrandVoice, readJsonFile, writeFileAtomic, type BrandVoiceKey } from '@/lib/org-files';
import type { ActionResult, User } from '@/lib/types';
import { normalizeGrant, type AccessGrant } from '@/lib/access';
import { aiAreas } from '@/lib/nav';
import { assertPlatformUsernameFree } from '@/lib/platform/users';
import { deleteGrant, getGrant, grantEmpty, ownerId, requireFullAccess, assertMayChange } from '@/lib/user-access';
import { savedPassword } from '@/lib/login-user';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramConfig {
  agent: string;
  org: string;
  botToken: string; // masked
  chatId: string;
}

export interface SystemConfig {
  heartbeatStalenessThreshold: number; // seconds
  maxCrashesPerDay: number;
  sessionRefreshInterval: number; // seconds
}

const CONFIG_DIR = path.join(CTX_ROOT, 'config');
const SYSTEM_CONFIG_PATH = path.join(CONFIG_DIR, 'dashboard-settings.json');

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return token.slice(0, 4) + '****' + token.slice(-4);
}

export async function fetchTelegramConfigs(): Promise<TelegramConfig[]> {
  await requireFullAccess();
  try {
    const configs: TelegramConfig[] = [];
    const orgs = getOrgs();

    for (const org of orgs) {
      const agents = getAgentsForOrg(org);
      for (const agent of agents) {
        const agentDir = getAgentDir(agent, org);
        const envPath = path.join(agentDir, '.env');

        if (!fs.existsSync(envPath)) continue;

        const content = fs.readFileSync(envPath, 'utf-8');
        let botToken = '';
        let chatId = '';

        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('#')) continue;

          const match = trimmed.match(/^(\w+)=(.*)$/);
          if (!match) continue;

          const [, key, value] = match;
          const cleanValue = value.replace(/^["']|["']$/g, '');

          if (key === 'TELEGRAM_BOT_TOKEN' || key === 'TG_BOT_TOKEN' || key === 'BOT_TOKEN') {
            botToken = cleanValue;
          } else if (key === 'TELEGRAM_CHAT_ID' || key === 'TG_CHAT_ID' || key === 'CHAT_ID') {
            chatId = cleanValue;
          }
        }

        if (botToken || chatId) {
          configs.push({
            agent,
            org,
            botToken: botToken ? maskToken(botToken) : '-',
            chatId: chatId || '-',
          });
        }
      }
    }

    return configs;
  } catch {
    return [];
  }
}

export async function getFullToken(
  agent: string,
  org: string,
): Promise<{ botToken: string; chatId: string } | null> {
  await requireFullAccess();
  try {
    const agentDir = getAgentDir(agent, org);
    const envPath = path.join(agentDir, '.env');

    if (!fs.existsSync(envPath)) return null;

    const content = fs.readFileSync(envPath, 'utf-8');
    let botToken = '';
    let chatId = '';

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^(\w+)=(.*)$/);
      if (!match) continue;

      const [, key, value] = match;
      const cleanValue = value.replace(/^["']|["']$/g, '');

      if (key === 'TELEGRAM_BOT_TOKEN' || key === 'TG_BOT_TOKEN' || key === 'BOT_TOKEN') {
        botToken = cleanValue;
      } else if (key === 'TELEGRAM_CHAT_ID' || key === 'TG_CHAT_ID' || key === 'CHAT_ID') {
        chatId = cleanValue;
      }
    }

    return { botToken, chatId };
  } catch {
    return null;
  }
}

export async function saveTelegramConfig(
  agent: string,
  org: string,
  botToken: string,
  chatId: string,
): Promise<ActionResult> {
  await requireFullAccess();
  try {
    const agentDir = getAgentDir(agent, org);
    const envPath = path.join(agentDir, '.env');

    if (!fs.existsSync(envPath)) {
      return { success: false, error: '.env file not found for this agent' };
    }

    const content = fs.readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');
    const newLines: string[] = [];
    let foundBotToken = false;
    let foundChatId = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const match = trimmed.match(/^(\w+)=(.*)$/);

      if (match) {
        const [, key] = match;
        if (key === 'TELEGRAM_BOT_TOKEN' || key === 'TG_BOT_TOKEN' || key === 'BOT_TOKEN') {
          newLines.push(`${key}=${botToken}`);
          foundBotToken = true;
          continue;
        }
        if (key === 'TELEGRAM_CHAT_ID' || key === 'TG_CHAT_ID' || key === 'CHAT_ID') {
          newLines.push(`${key}=${chatId}`);
          foundChatId = true;
          continue;
        }
      }

      newLines.push(line);
    }

    // If keys weren't found, append them
    if (!foundBotToken) {
      newLines.push(`BOT_TOKEN=${botToken}`);
    }
    if (!foundChatId) {
      newLines.push(`CHAT_ID=${chatId}`);
    }

    fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');

    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// System Config
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_CONFIG: SystemConfig = {
  heartbeatStalenessThreshold: 120,
  maxCrashesPerDay: 5,
  sessionRefreshInterval: 300,
};

export async function fetchSystemConfig(): Promise<SystemConfig> {
  await requireFullAccess();
  try {
    if (fs.existsSync(SYSTEM_CONFIG_PATH)) {
      const raw = fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SYSTEM_CONFIG, ...parsed };
    }
  } catch {
    // Fall through to default
  }
  return { ...DEFAULT_SYSTEM_CONFIG };
}

export async function saveSystemConfig(config: SystemConfig): Promise<ActionResult> {
  await requireFullAccess();
  try {
    const validated: SystemConfig = {
      heartbeatStalenessThreshold: Math.max(10, Math.min(3600, Math.round(config.heartbeatStalenessThreshold))),
      maxCrashesPerDay: Math.max(1, Math.min(100, Math.round(config.maxCrashesPerDay))),
      sessionRefreshInterval: Math.max(30, Math.min(3600, Math.round(config.sessionRefreshInterval))),
    };

    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(SYSTEM_CONFIG_PATH, JSON.stringify(validated, null, 2), 'utf-8');

    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function addUser(username: string, password: string): Promise<ActionResult> {
  try {
    await requireFullAccess();
    const trimmed = username.trim();
    if (!trimmed) return { success: false, error: 'Username is required' };
    if (trimmed.length < 3) return { success: false, error: 'Username must be at least 3 characters' };
    if (trimmed.length > 50) return { success: false, error: 'Username must be under 50 characters' };
    if (!password || password.length < 6) return { success: false, error: 'Password must be at least 6 characters' };

    // Check for duplicate
    const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(trimmed) as User | undefined;
    if (existing) return { success: false, error: 'Username already exists' };
    assertPlatformUsernameFree(trimmed); // multi-agency mode: usernames are global (D, 2026-10-09)

    const hash = await bcrypt.hash(savedPassword(password), 12);
    const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(trimmed, hash);
    grantEmpty(Number(info.lastInsertRowid));

    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteUser(userId: number): Promise<ActionResult> {
  try {
    const me = await requireFullAccess();
    // Prevent deleting the last user
    const count = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    if (count.count <= 1) {
      return { success: false, error: 'Cannot delete the last user' };
    }
    if (userId === ownerId()) {
      return { success: false, error: 'The owner account cannot be deleted.' };
    }
    assertMayChange(me, userId);

    deleteGrant(userId);
    try { db.prepare('DELETE FROM contract_team WHERE manager_user_id = ? OR member_user_id = ?').run(userId, userId); } catch { /* no team table yet */ }
    db.prepare('DELETE FROM crm_user_links WHERE user_id = ?').run(userId);
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    if (result.changes === 0) {
      return { success: false, error: 'User not found' };
    }

    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Organization metadata (Settings > Organization: profile + brand voice)
// ---------------------------------------------------------------------------

export interface OrgProfile {
  name: string;
  description: string;
  industry: string;
  icp: string;
  value_prop: string;
}

export interface BrandVoiceView {
  /** brand-voice.md exists (saving creates it when it doesn't). */
  exists: boolean;
  tone: string;
  style: string;
  guidelines: string;
  /** The hint comment under each heading, used as the input placeholder. */
  hints: Record<BrandVoiceKey, string>;
  /** Headings of any other ## sections in the file; saving keeps them. */
  extraSections: string[];
}

export interface OrgMetadata {
  /** The org being edited ('' when there are no orgs). */
  org: string;
  /** True when it is the org picked in the top bar, false for the fallback. */
  picked: boolean;
  context: OrgProfile;
  brandVoice: BrandVoiceView;
  /** Set when context.json exists but can't be read, so the profile can't be saved safely. */
  problem?: string;
}

const PROFILE_KEYS = ['name', 'description', 'industry', 'icp', 'value_prop'] as const;
const PROFILE_MAX = 2000;
const BRAND_VOICE_MAX: Record<BrandVoiceKey, number> = { tone: 2000, style: 4000, guidelines: 20000 };
const EMPTY_PROFILE: OrgProfile = { name: '', description: '', industry: '', icp: '', value_prop: '' };

const asText = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

/** Cut to `max` UTF-16 units without leaving half an emoji behind. */
const cap = (s: string, max: number) => (s.length > max ? s.slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : s);

function readBrandVoiceFile(org: string): string | null {
  try {
    return fs.readFileSync(getOrgBrandVoicePath(org), 'utf-8');
  } catch {
    return null;
  }
}

function brandVoiceView(md: string | null): BrandVoiceView {
  const parsed = parseBrandVoice(md ?? '');
  return { exists: md !== null, ...parsed.values, hints: parsed.hints, extraSections: parsed.others.map((o) => o.heading) };
}

/** context.json as an object; null when missing; throws a readable message when it's broken. */
function readOrgContext(org: string): { ctx: Record<string, unknown>; raw: string } | null {
  const contextPath = getOrgContextPath(org);
  if (!fs.existsSync(contextPath)) return null;
  let parsed: { data: unknown; raw: string };
  try {
    parsed = readJsonFile(contextPath);
  } catch {
    throw new Error(`orgs/${org}/context.json is not valid JSON. Fix it by hand before editing the profile here.`);
  }
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw new Error(`orgs/${org}/context.json does not hold an object. Fix it by hand before editing the profile here.`);
  }
  return { ctx: parsed.data as Record<string, unknown>, raw: parsed.raw };
}

/**
 * Profile + brand voice for the org picked in the top bar. With no org picked ('all' or nothing)
 * or a name that isn't an org, it falls back to the first org with a context.json; `org` and
 * `picked` say which org that was.
 */
export async function fetchOrgMetadata(requested?: string): Promise<OrgMetadata> {
  await requireFullAccess();
  const { org, picked } = resolveSettingsOrg(typeof requested === 'string' ? requested : undefined);
  if (!org) return { org: '', picked: false, context: { ...EMPTY_PROFILE }, brandVoice: brandVoiceView(null) };

  const context = { ...EMPTY_PROFILE };
  let problem: string | undefined;
  try {
    const found = readOrgContext(org);
    if (found) for (const key of PROFILE_KEYS) context[key] = asText(found.ctx[key]);
  } catch (err) {
    problem = err instanceof Error ? err.message : String(err);
  }

  return { org, picked, context, brandVoice: brandVoiceView(readBrandVoiceFile(org)), ...(problem ? { problem } : {}) };
}

/**
 * Save the five profile fields into orgs/<org>/context.json. Only these keys change; timezone,
 * orchestrator, approval categories and everything else in the file stay as they are. Values are
 * trimmed and capped at 2,000 characters. Creates the file when the org has none.
 */
export async function saveOrgProfile(
  org: string,
  fields: Partial<OrgProfile>,
): Promise<ActionResult & { context?: OrgProfile }> {
  await requireFullAccess();
  try {
    if (typeof org !== 'string' || !getOrgs().includes(org)) return { success: false, error: 'Unknown org.' };
    const found = readOrgContext(org);
    const ctx = found?.ctx ?? {};
    const saved = { ...EMPTY_PROFILE };
    for (const key of PROFILE_KEYS) {
      const next = fields?.[key];
      if (typeof next === 'string') ctx[key] = cap(next.trim(), PROFILE_MAX).trim();
      saved[key] = asText(ctx[key]);
    }
    writeFileAtomic(
      getOrgContextPath(org),
      found ? formatJsonLike(found.raw, ctx) : JSON.stringify(ctx, null, 2) + '\n',
    );
    revalidatePath('/settings');
    return { success: true, context: saved };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Save Tone, Style and Guidelines into orgs/<org>/brand-voice.md. Other ## sections, the title and
 * any intro text are kept; an empty field keeps its hint comment. The old file is first copied to
 * brand-voice.md.bak (one rolling backup). Nothing is written when nothing changed.
 */
export async function saveBrandVoice(
  org: string,
  fields: Partial<Record<BrandVoiceKey, string>>,
): Promise<ActionResult & { brandVoice?: BrandVoiceView }> {
  await requireFullAccess();
  try {
    if (typeof org !== 'string' || !getOrgs().includes(org)) return { success: false, error: 'Unknown org.' };
    const bvPath = getOrgBrandVoicePath(org);
    const old = readBrandVoiceFile(org);
    const next = { ...parseBrandVoice(old ?? '').values };
    for (const f of BRAND_VOICE_FIELDS) {
      const v = fields?.[f.key];
      if (typeof v === 'string') next[f.key] = cap(v.replace(/\r\n?/g, '\n'), BRAND_VOICE_MAX[f.key]);
    }
    const content = buildBrandVoice(next, old ?? '');
    if (content !== old) {
      if (old !== null) fs.copyFileSync(bvPath, `${bvPath}.bak`);
      writeFileAtomic(bvPath, content);
    }
    revalidatePath('/settings');
    return { success: true, brandVoice: brandVoiceView(content) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Allowed Roots — controls which directories the /api/media route can serve
// ---------------------------------------------------------------------------

interface AllowedRootsView {
  ctx_root: string;
  additional_roots: AllowedRootEntry[];
}

interface AllowedRootEntry {
  path: string;
  exists: boolean;
}

const SYSTEM_BLOCKLIST: string[] = [
  '/',
  'C:/',
  'D:/',
  'E:/',
  '/usr',
  '/etc',
  '/var',
  '/sys',
  '/proc',
  '/boot',
  '/dev',
  '/root',
  '/System',
  'C:/Windows',
  'C:/Program Files',
  'C:/Program Files (x86)',
];

function normalizeFsPath(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (n.length > 1 && n.endsWith('/') && !/^[A-Za-z]:\/$/.test(n)) {
    n = n.slice(0, -1);
  }
  return n;
}

export async function fetchAllowedRoots(): Promise<AllowedRootsView> {
  await requireFullAccess();
  const ctxRoot = normalizeFsPath(CTX_ROOT);
  const configPath = getAllowedRootsConfigPath();

  let additional: string[] = [];
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(parsed.additional_roots)) {
        additional = parsed.additional_roots
          .filter((r: unknown): r is string => typeof r === 'string')
          .map((r: string) => normalizeFsPath(r));
      }
    } catch { /* malformed file — treat as empty */ }
  }

  return {
    ctx_root: ctxRoot,
    additional_roots: additional.map((p) => ({
      path: p,
      exists: fs.existsSync(p),
    })),
  };
}

export async function addAllowedRoot(rawPath: string): Promise<ActionResult> {
  await requireFullAccess();
  const trimmed = rawPath.trim();
  if (!trimmed) return { success: false, error: 'Path is required' };
  if (!path.isAbsolute(trimmed)) {
    return { success: false, error: 'Path must be absolute (start with / or a drive letter)' };
  }

  const normalized = normalizeFsPath(trimmed);

  for (const blocked of SYSTEM_BLOCKLIST) {
    if (normalized === normalizeFsPath(blocked)) {
      return { success: false, error: `Cannot add system directory: ${normalized}. This path is on the security blocklist.` };
    }
  }

  if (!fs.existsSync(normalized)) {
    return { success: false, error: `Path does not exist: ${normalized}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalized);
  } catch {
    return { success: false, error: `Path is not readable: ${normalized}` };
  }
  if (!stat.isDirectory()) {
    return { success: false, error: `Path is not a directory: ${normalized}` };
  }

  const configPath = getAllowedRootsConfigPath();
  let current: { additional_roots: string[] } = { additional_roots: [] };
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(parsed.additional_roots)) {
        current.additional_roots = parsed.additional_roots
          .filter((r: unknown): r is string => typeof r === 'string')
          .map((r: string) => normalizeFsPath(r));
      }
    } catch { /* malformed — treat as empty */ }
  }

  if (current.additional_roots.includes(normalized)) {
    return { success: false, error: `Path is already in the allowed roots list: ${normalized}` };
  }

  const updated = { additional_roots: [...current.additional_roots, normalized] };
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
  fs.renameSync(tmpPath, configPath);

  revalidatePath('/settings');
  return { success: true };
}

export async function removeAllowedRoot(rawPath: string): Promise<ActionResult> {
  await requireFullAccess();
  const normalized = normalizeFsPath(rawPath.trim());
  const configPath = getAllowedRootsConfigPath();

  let current: { additional_roots: string[] } = { additional_roots: [] };
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (Array.isArray(parsed.additional_roots)) {
        current.additional_roots = parsed.additional_roots
          .filter((r: unknown): r is string => typeof r === 'string')
          .map((r: string) => normalizeFsPath(r));
      }
    } catch { /* malformed — treat as empty */ }
  }

  const updated = { additional_roots: current.additional_roots.filter((r) => r !== normalized) };
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2));
  fs.renameSync(tmpPath, configPath);

  revalidatePath('/settings');
  return { success: true };
}
