import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

describe('a Claude sign-in replaces the box login', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlogin-'));
  const file = path.join(dir, 'scorer.env');
  beforeAll(() => {
    fs.writeFileSync(path.join(dir, 'key'), crypto.randomBytes(32).toString('base64'));
    process.env.FLEET_SECRETS_KEY_FILE = path.join(dir, 'key');
    process.env.CLAUDE_LOGIN_ENV_FILES = file;
  });
  it('swaps only the token line and keeps the file sealed', async () => {
    const { sealEnvText, unsealEnvText } = await import('@/lib/env-store');
    fs.writeFileSync(`${file}.enc`, sealEnvText('# scorer\nMODEL=sonnet\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-old\n'));
    const { replaceBoxLogin } = await import('../connections');
    replaceBoxLogin('sk-ant-oat01-new');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(`${file}.enc`, 'utf-8')).not.toContain('sk-ant');
    expect(unsealEnvText(fs.readFileSync(`${file}.enc`, 'utf-8'))).toBe('# scorer\nMODEL=sonnet\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-new\n');
  });
});
