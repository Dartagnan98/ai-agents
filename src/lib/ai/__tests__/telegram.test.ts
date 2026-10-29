import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
const h = vi.hoisted(() => ({ mem: null as unknown as import('better-sqlite3').Database, runTurn: null as unknown as ReturnType<typeof import('vitest').vi.fn> }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ get db() { return h.mem; } }));
vi.mock('../store', () => ({ listAgents: () => [{ id: 7, name: 'Analyst' }] }));
vi.mock('../turn', () => ({ runTurn: (...a: unknown[]) => (h.runTurn as unknown as (...x: unknown[]) => unknown)(...a) }));
h.mem = new Database(':memory:');
const mem = h.mem;
const runTurn = vi.fn(async () => ({ reply: 'ACME made $1,000.', threadId: 42 }));
h.runTurn = runTurn;
process.env.AUTH_SECRET = 'test-secret';
import { connectTelegram, handleUpdate, linkCode } from '@/lib/ai/telegram';

const sent: string[] = [];
beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? '{}');
    if (url.endsWith('/getMe')) return new Response(JSON.stringify({ ok: true, result: { username: 'ctrlos_bot' } }));
    if (url.endsWith('/sendMessage')) sent.push(body.text);
    return new Response(JSON.stringify({ ok: true }));
  }));
});

describe('Fleet AI on Telegram (D, 2026-10-09)', () => {
  it('only answers with the right secrets, links with a code, then runs turns as that login', async () => {
    delete process.env.APP_URL; delete process.env.AUTH_URL;
    expect((await connectTelegram('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh', 'default')).ok).toBe(true);
    const secret = (mem.prepare('SELECT secret FROM ai_telegram_bot').get() as { secret: string }).secret;
    const msg = (text: string) => ({ message: { chat: { id: 555, type: 'private' }, text } });
    expect(await handleUpdate('0'.repeat(48), secret, msg('hi'))).toBe(false); // wrong path secret
    expect(await handleUpdate(secret, 'nope', msg('hi'))).toBe(false); // wrong header
    await handleUpdate(secret, secret, msg('how did ACME do?'));
    expect(sent.pop()).toMatch(/not linked/);
    expect(runTurn).not.toHaveBeenCalled();
    const code = linkCode(3);
    await handleUpdate(secret, secret, msg(`/link ${code}`));
    expect(sent.pop()).toMatch(/^Linked/);
    await handleUpdate(secret, secret, msg(`/link ${code}`)); // single use
    await handleUpdate(secret, secret, msg('how did ACME do?'));
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ userId: 3, text: 'how did ACME do?', threadId: null }));
    expect(sent.pop()).toBe('ACME made $1,000.');
    await handleUpdate(secret, secret, msg('and GAMMA?'));
    expect(runTurn).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 42 })); // same conversation continues
    await handleUpdate(secret, secret, { message: { chat: { id: 9, type: 'group' }, text: 'hi' } });
    expect(runTurn).toHaveBeenCalledTimes(2); // groups are ignored
  });
});
