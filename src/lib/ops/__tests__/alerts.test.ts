import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Error alerts (P5, D 2026-10-09): same kind+message at most once per 30 minutes, in memory and in SQLite (shared by copies).
vi.mock('../context', async () => {
  const { default: Database } = await import('better-sqlite3');
  const mem = new Database(':memory:');
  return { opsDb: () => mem, currentTenantId: () => 'default' };
});

const A = await import('../alerts');
const { opsDb } = await import('../context');

describe('alert de-dup', () => {
  beforeEach(() => {
    A._resetAlertsForTests();
    opsDb().exec('DROP TABLE IF EXISTS ops_alerts');
    vi.stubEnv('OPS_TELEGRAM_BOT_TOKEN', 'test-token');
    vi.stubEnv('OPS_TELEGRAM_CHAT_ID', '42');
    vi.stubEnv('OPS_ALERT_EMAIL', '');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('claims once per window, then again after 30 minutes', () => {
    const t = 1_800_000_000_000;
    expect(A.claimAlert('server-error', 'boom', undefined, t)).toBe(true);
    expect(A.claimAlert('server-error', 'boom', undefined, t + 60_000)).toBe(false);
    expect(A.claimAlert('server-error', 'other', undefined, t + 60_000)).toBe(true); // different message
    expect(A.claimAlert('postgres-down', 'boom', undefined, t + 60_000)).toBe(true); // different kind
    expect(A.claimAlert('server-error', 'boom', undefined, t + A.ALERT_WINDOW_MS + 1)).toBe(true);
    const row = opsDb().prepare("SELECT count FROM ops_alerts WHERE key = ?").get('server-error\nboom') as { count: number };
    expect(row.count).toBe(3);
  });

  it('respects a send recorded by another app copy (SQLite, not memory)', () => {
    const t = 1_800_000_000_000;
    expect(A.claimAlert('k', 'm', undefined, t)).toBe(true);
    A._resetAlertsForTests(); // a fresh copy: empty memory, same database
    expect(A.claimAlert('k', 'm', undefined, t + 1000)).toBe(false);
  });

  it('sends to Telegram once and reports the duplicate', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await A.alert('server-error', 'GET /x: broke', { path: '/x' });
    expect(first).toMatchObject({ sent: true, deduped: false, channels: ['telegram'] });
    const second = await A.alert('server-error', 'GET /x: broke');
    expect(second).toMatchObject({ sent: false, deduped: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('api.telegram.org/bottest-token/sendMessage');
    expect(JSON.parse(String(init.body))).toMatchObject({ chat_id: '42' });
  });

  it('never throws when delivery fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const r = await A.alert('k2', 'm2');
    expect(r.sent).toBe(false);
    expect(r.errors[0]).toContain('telegram');
  });

  it('logs only when no channel is set', async () => {
    vi.stubEnv('OPS_TELEGRAM_BOT_TOKEN', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await A.alert('k3', 'm3');
    expect(r).toMatchObject({ sent: false, deduped: false, channels: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
