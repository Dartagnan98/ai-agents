import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/ai/turn', () => ({ runTurn: vi.fn() }));
vi.mock('@/lib/slack/app', () => ({ agencyIdNow: () => 'single' }));
const { cleanAdmins, cleanGroups } = await import('../wa/numbers');
const { adminOf, toWhatsApp } = await import('../wa/inbound');

describe('WhatsApp numbers (Settings › AI connections)', () => {
  it('admins keep their digits and who they are; bad lines drop', () => {
    expect(cleanAdmins({ '+1 (778) 555-1234': ' Sam, owner ', '123': 'too short', '16045550000': '' })).toEqual({ '17785551234': 'Sam, owner' });
  });
  it('groups are group JIDs only, once each', () => {
    expect(cleanGroups(['120363000000000000@g.us', ' 120363000000000000@g.us ', '17785551234@s.whatsapp.net', 'x@g.us'])).toEqual(['120363000000000000@g.us']);
  });
  it('only an admin wakes the agent, whatever device they send from', () => {
    const n = { admins: { '17785551234': 'Sam' } };
    expect(adminOf(n, '17785551234@s.whatsapp.net')).toBe('Sam');
    expect(adminOf(n, '17785551234:12@s.whatsapp.net')).toBe('Sam');
    expect(adminOf(n, '16045550000@s.whatsapp.net')).toBeNull();
  });
  it('markdown becomes WhatsApp text', () => {
    expect(toWhatsApp('## Done\n**3 calls** booked, see `ACME`')).toBe('Done\n*3 calls* booked, see ACME');
  });
});
