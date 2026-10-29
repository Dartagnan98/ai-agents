import { describe, expect, it } from 'vitest';
import { bestOf, composioKeyKind, filterCatalog, parseCatalog, parseConnections, parseLink, parseRemove } from '../connectors/composio';

// Real shapes captured from `composio` CLI 0.4.2 on a client box, 2026-09-29.
const CONNECTIONS = `\u001b[2mFetching\u001b[22m
{
  "square": [ { "status": "INITIALIZING", "word_id": "square_a" }, { "status": "EXPIRED", "word_id": "square_b", "permission_group": null } ],
  "googlesheets": [ { "status": "ACTIVE", "alias": null, "word_id": "gs_a" }, { "status": "EXPIRED", "word_id": "gs_b" } ],
  "gmail": [ { "status": "ACTIVE", "word_id": "gm_a" } ]
}`;
const LINK = `{
  "status": "pending",
  "message": "Complete authorization by opening the URL",
  "connected_account_id": "ca_w0dxg5ZoBbCT",
  "redirect_url": "https://connect.composio.dev/link/lk_abc123",
  "toolkit": "square",
  "project_type": "CONSUMER"
}`;
const CACHE = [
  { name: 'Square', slug: 'square', auth_schemes: ['OAUTH2'], meta: { description: 'Payments and POS', tools_count: 122 } },
  { name: 'Squarespace', slug: 'squarespace', auth_schemes: ['OAUTH2'], meta: { description: 'Websites', tools_count: 30 } },
  { name: 'QuickBooks', slug: 'quickbooks', auth_schemes: ['OAUTH2'], meta: { description: 'Accounting, invoices, payments', tools_count: 114 } },
  { name: 'Bad', slug: 'Not A Slug!' },
];
// `dev toolkits list` rows carry the fields flat.
const LIST = [{ name: 'Slack', slug: 'slack', description: 'Chat', tools_count: 159, connected: null }];

describe('composio key kinds', () => {
  it('tells a project key from a user key', () => {
    expect(composioKeyKind('  ak_exampleKeyValue0001 ')).toBe('project');
    expect(composioKeyKind('uak_b813ydmoEYdB_xBxGHeW')).toBe('user');
    expect(composioKeyKind('oak_b813ydmoEYdB_xBxGHeW')).toBe('org');
    expect(composioKeyKind('not a key')).toBe('invalid');
    expect(composioKeyKind('ak_short')).toBe('invalid');
  });
});

describe('composio CLI parsing', () => {
  it('reads connection statuses past the CLI decoration', () => {
    const c = parseConnections(CONNECTIONS);
    expect(Object.keys(c).sort()).toEqual(['gmail', 'googlesheets', 'square']);
    expect(bestOf(c.square)).toEqual({ status: 'INITIALIZING', alias: null });
    expect(bestOf(c.googlesheets).status).toBe('ACTIVE');
    expect(bestOf(c.nothere)).toEqual({ status: 'NONE', alias: null });
    expect(parseConnections('not json')).toEqual({});
  });
  it('accepts only composio.dev links', () => {
    expect(parseLink(LINK)).toEqual({ url: 'https://connect.composio.dev/link/lk_abc123', id: 'ca_w0dxg5ZoBbCT' });
    expect(parseLink(LINK.replace('connect.composio.dev', 'evil.example.com'))).toBeNull();
    expect(parseLink('')).toBeNull();
  });
  it('reads both catalog shapes and drops bad slugs', () => {
    const apps = parseCatalog(CACHE);
    expect(apps.map((a) => a.slug)).toEqual(['square', 'squarespace', 'quickbooks']);
    expect(apps[0]).toMatchObject({ name: 'Square', tools: 122, auth: ['OAUTH2'], description: 'Payments and POS' });
    expect(parseCatalog(LIST)[0]).toMatchObject({ slug: 'slack', tools: 159, description: 'Chat' });
    expect(parseCatalog('nope')).toEqual([]);
  });
  it('reads a removal and a miss', () => {
    expect(parseRemove('◇  Removed slack connection.')).toEqual({ ok: true });
    expect(parseRemove('No connection matched "gone".')).toEqual({ error: 'That connection is already gone.' });
    expect(parseRemove('Failed to remove slack connection.')).toEqual({ error: 'Composio could not remove that connection.' });
    expect(parseRemove('No connection removed.')).toEqual({ error: 'Composio left the connection in place.' });
    expect(parseRemove('')).toEqual({ error: 'Composio did not confirm the removal.' });
  });
  it('ranks name hits over description hits', () => {
    const apps = parseCatalog(CACHE);
    expect(filterCatalog(apps, 'square').map((a) => a.slug)).toEqual(['square', 'squarespace']);
    expect(filterCatalog(apps, 'payments').map((a) => a.slug)).toEqual(['square', 'quickbooks']);
    expect(filterCatalog(apps, '')).toEqual([]);
  });
});
