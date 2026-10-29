import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

// Pages published by workspace scripts (lib/ai/published-pages.ts): who may open one, and names that cannot leave the folder.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
const grants: Record<number, { role: string; businesses: Record<string, string[]> }> = {
  1: { role: 'owner', businesses: {} }, 2: { role: 'user', businesses: { acme: ['home'] } }, 3: { role: 'user', businesses: {} },
};
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT); INSERT INTO users VALUES (1, 'o@x.io'), (2, 'Rep@X.io'), (3, 'gone@x.io');`);
  return { db };
});
vi.mock('@/lib/drive/service', () => ({ driveDir: () => path.join(root, 'drive') }));
vi.mock('@/lib/platform/db', () => ({ membershipByLocal: () => null, platformDb: () => null }));
vi.mock('@/lib/platform/mode', () => ({ isMultiTenant: () => false }));
vi.mock('@/lib/platform/tenant-db', () => ({ currentAgencySync: () => ({ id: 'a' }) }));
vi.mock('@/lib/user-access', () => ({ getGrant: (id: number) => grants[id] }));

const P = await import('../published-pages');

describe('published pages', () => {
  it('members pages open to owners and the named people only', () => {
    const m = P.savePage('acme-deal-ledger', '<title>ACME</title><p>x</p>', 'members', ['rep@x.io']);
    expect(m.title).toBe('ACME');
    expect(P.maySee(m, 1)).toBe(true);
    expect(P.maySee(m, 2)).toBe(true); // email matched case-blind
    expect(P.maySee({ ...m, emails: [] }, 2)).toBe(false);
    expect(P.readPage('acme-deal-ledger')?.html.toString()).toContain('<p>x</p>');
  });
  it('workspace pages need a login that has some access', () => {
    const m = P.savePage('board', '<p>y</p>', 'workspace', []);
    expect(P.maySee(m, 2)).toBe(true);
    expect(P.maySee(m, 3)).toBe(false);
  });
  it('names stay inside the folder', () => {
    expect(P.pageName('../../etc/Passwd')).toBe('etc-passwd');
    expect(() => P.savePage('../x', '<p/>', 'workspace', [])).toThrow();
    expect(P.readPage('../x')).toBeNull();
  });
});
