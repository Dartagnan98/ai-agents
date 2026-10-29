import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { encodedForms, guardToolOutput, HIDDEN, isSecret, redactSecrets, secretNeedles } from '@/lib/ai/tool-guard';

// Fleet AI tool output guard (D, 2026-10-10, docs/SECRETS_ENCRYPTION.md "Agents use keys without seeing them").
const GHL = 'pit' + '-1b2c3d4e-0000-4111-8222-333344445555';
const STRIPE = 'sk_' + 'live_51AbCdEfGhIjKlMnOpQrStUv';
const PGPW = 's3cr3t-Pg-pass-778899';
const PGURL = `postgresql://fleet_ro:${PGPW}@127.0.0.1:5432/fleet`;
const WHOOP = 'whopKeyValue_abcdef0123456789';
const NAMED = {
  GHL_ADPI_TOKEN: GHL, CONN_ADPI_STRIPE_KEY: STRIPE, FLEET_PG_RO_URL: PGURL, CONN_PBS_WHOP_KEY: WHOOP,
  CONN_ADPI_GHL_LOCATION: 'LocAbCdEf0123456789', CONN_ADPI_WHOP_COMPANY: 'biz_AbCdEf123456', CONN_SWA_GHLPAY_ON: '1', CHAT_ID: '7767109346',
};

describe('tool output guard', () => {
  const needles = secretNeedles(NAMED);
  it('names: keys are secrets, settings (locations, biz_ ids, switches, chat ids) are not', () => {
    expect(isSecret('GHL_ADPI_TOKEN', GHL)).toBe(true);
    expect(isSecret('FLEET_PG_RO_URL', PGURL)).toBe(true);
    expect(isSecret('CONN_ADPI_GHL_LOCATION', 'LocAbCdEf0123456789')).toBe(false);
    expect(isSecret('CONN_ADPI_WHOP_COMPANY', 'biz_AbCdEf123456')).toBe(false);
    expect(isSecret('AUTH_URL', 'https://app.example.com')).toBe(false);
    expect(isSecret('SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/T1/B2/abc123')).toBe(true);
    expect(isSecret('APP_URL', 'https://app.example.com')).toBe(false); // links to chart images and pages must reach scripts

    expect(isSecret('CONN_SWA_GHLPAY_ON', '1')).toBe(false);
    expect(isSecret('CHAT_ID', '7767109346')).toBe(false);
  });

  it('hides exact values and their encoded forms, keeps ids', () => {
    const b64 = Buffer.from(`xx${WHOOP}yy`).toString('base64');
    const text = [`token ${GHL}`, `stripe ${STRIPE}`, `url ${PGURL}`, `enc ${encodeURIComponent(PGURL)}`, `b64 ${b64}`,
      `json ${JSON.stringify({ k: WHOOP })}`, 'biz_AbCdEf123456', 'LocAbCdEf0123456789', 'pk_live_publishable123'].join('\n');
    const { text: out, count } = redactSecrets(text, needles);
    for (const s of [GHL, STRIPE, PGPW, WHOOP, b64]) expect(out).not.toContain(s);
    expect(out).toContain('biz_AbCdEf123456');
    expect(out).toContain('LocAbCdEf0123456789');
    expect(out).toContain('pk_live_publishable123');
    expect(count).toBeGreaterThanOrEqual(6);
  });

  it('base64 of a secret inside a longer stream, every alignment', () => {
    for (let pad = 0; pad < 6; pad++) {
      const blob = Buffer.concat([Buffer.alloc(pad, 7), Buffer.from(WHOOP), Buffer.alloc(5, 9)]).toString('base64');
      expect(redactSecrets(`data:${blob}`, needles).text).toContain(HIDDEN);
    }
  });

  it('hides key-shaped strings that are in no store', () => {
    const text = 'Authorization: Bearer abcDEF123456789 and postgres://u:' + 'otherpw123@h/db, xoxb-1234567890-abcdefghij, '
      + 'sk_test_ABCDEFGHIJ12, whsec_abcdefghij, eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.abcdefghijklmnop, '
      + 'pit' + '-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const out = redactSecrets(text, []).text;
    expect(out).toContain(`Bearer ${HIDDEN}`);
    expect(out).toContain(`postgres://u:${HIDDEN}@h/db`);
    for (const s of ['abcDEF123456789', 'otherpw123', 'xoxb-1234567890', 'sk_test_ABCDEFGHIJ12', 'whsec_abcdefghij', 'eyJyb2xlIjoic2VydmljZSJ9', 'pit-aaaaaaaa']) {
      expect(out).not.toContain(s);
    }
  });

  it('encodedForms includes the Postgres password alone', () => {
    expect(encodedForms(PGURL)).toContain(PGPW);
  });

  it('guards a tool result and a tool error', async () => {
    const collect = () => NAMED;
    await expect(guardToolOutput(async () => `the key is ${STRIPE} for biz_AbCdEf123456`, collect)).resolves.toBe(`the key is ${HIDDEN} for biz_AbCdEf123456`);
    await expect(guardToolOutput(async () => { throw new Error(`HTTP 401 with ${GHL}`); }, collect)).rejects.toThrow(`HTTP 401 with ${HIDDEN}`);
    // a failing collector never breaks the tool: patterns still apply
    await expect(guardToolOutput(async () => `x ${STRIPE}`, () => { throw new Error('no key file'); })).resolves.toBe(`x ${HIDDEN}`);
  });

  it('every Fleet AI tool call goes through the guard (lib/ai/tools.ts callTool)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'tools.ts'), 'utf8');
    const call = src.slice(src.indexOf('export async function callTool'), src.indexOf('async function callToolNow'));
    expect(call).toContain('guardToolOutput(() => callToolNow(run, name, args), agencySecretsForGuard)');
    expect(call).not.toMatch(/return callToolNow\(/);
    // the MCP route reaches tools only through callTool
    const route = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'app', 'api', 'ai', 'mcp', 'route.ts'), 'utf8');
    expect(route).toContain('await callTool(run, name, args)');
    expect(route).not.toContain('callToolNow');
  });
});
