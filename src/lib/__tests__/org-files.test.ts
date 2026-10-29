import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { buildBrandVoice, formatJsonLike, hasEnvKey, parseBrandVoice, readEnvValue, upsertEnvValue, writeFileAtomic } from '../org-files';

const TEMPLATE = '# Brand Voice\n\n## Tone\n<!-- e.g., casual, professional, technical -->\n\n## Style\n<!-- e.g., concise, detailed, conversational -->\n\n## Guidelines\n<!-- Any specific brand guidelines for agent communications -->';

describe('brand-voice.md', () => {
  it('reads the template as three empty fields, comments as hints', () => {
    const p = parseBrandVoice(TEMPLATE);
    expect(p.values).toEqual({ tone: '', style: '', guidelines: '' });
    expect(p.hints.tone).toBe('e.g., casual, professional, technical');
    expect(p.hints.guidelines).toBe('Any specific brand guidelines for agent communications');
    expect(p.others).toEqual([]);
    expect(p.title).toBe('Brand Voice');
  });

  it('writes the spec format, keeping a hint only under an empty field', () => {
    const out = buildBrandVoice({ tone: ' warm ', style: 'short', guidelines: '' }, TEMPLATE);
    expect(out).toBe('# Brand Voice\n\n## Tone\nwarm\n\n## Style\nshort\n\n## Guidelines\n<!-- Any specific brand guidelines for agent communications -->\n');
    expect(buildBrandVoice({ tone: 'a', style: 'b', guidelines: 'c' }, '')).toBe('# Brand Voice\n\n## Tone\na\n\n## Style\nb\n\n## Guidelines\nc\n');
  });

  it('keeps other sections, the title and intro text; round-trips unchanged', () => {
    const md = '# Acme Brand Voice\n\nRead this first.\n\n## Audience\nOwners, 30-50.\n\n## Tone\nDirect.\n\n## Style\n- Short\n- No emoji\n\n## Guidelines\nBe kind.\n### Never\n- Promise dates\n\n## Words we avoid\n- synergy\n';
    const p = parseBrandVoice(md);
    expect(p.values.style).toBe('- Short\n- No emoji');
    expect(p.values.guidelines).toBe('Be kind.\n### Never\n- Promise dates');
    expect(p.others.map(o => o.heading)).toEqual(['Audience', 'Words we avoid']);
    const out = buildBrandVoice(p.values, md);
    expect(out).toBe('# Acme Brand Voice\n\nRead this first.\n\n## Tone\nDirect.\n\n## Style\n- Short\n- No emoji\n\n## Guidelines\nBe kind.\n### Never\n- Promise dates\n\n## Audience\nOwners, 30-50.\n\n## Words we avoid\n- synergy\n');
    expect(buildBrandVoice(parseBrandVoice(out).values, out)).toBe(out);
  });

  it('never lets a typed heading start a new section', () => {
    const out = buildBrandVoice({ tone: 'x', style: 'y', guidelines: 'Intro\n## Do\n# Big\n```\n## code\n```' }, TEMPLATE);
    const p = parseBrandVoice(out);
    expect(p.others).toEqual([]);
    expect(p.values.guidelines).toBe('Intro\n### Do\n### Big\n```\n## code\n```');
  });

  it('drops inline and multi-line comments from values, CRLF files included', () => {
    const p = parseBrandVoice('# Brand Voice\r\n\r\n## Tone\r\ncalm <!-- hint -->\r\n<!--\r\n long\r\n-->\r\n## Style\r\n<!-- unclosed');
    expect(p.values.tone).toBe('calm');
    expect(p.hints.tone).toBe('hint');
    expect(p.values.style).toBe('');
    expect(p.hints.style).toBe('unclosed');
  });
});

describe('secrets.env lines', () => {
  it('replaces every assignment and keeps other lines', () => {
    const src = '# comment\nBOT_TOKEN=abc\nGEMINI_API_KEY=\n# GEMINI_API_KEY=old-comment\nexport GEMINI_API_KEY="dup"\n';
    const out = upsertEnvValue(src, 'GEMINI_API_KEY', 'NEWKEY');
    expect(out).toBe('# comment\nBOT_TOKEN=abc\nGEMINI_API_KEY=NEWKEY\n# GEMINI_API_KEY=old-comment\nGEMINI_API_KEY=NEWKEY\n');
  });

  it('appends when missing, creates from empty, and reads the first non-empty value', () => {
    expect(upsertEnvValue('A=1\n', 'K', 'v')).toBe('A=1\nK=v\n');
    expect(upsertEnvValue('A=1', 'K', 'v')).toBe('A=1\nK=v\n');
    expect(upsertEnvValue('', 'K', 'v')).toBe('K=v\n');
    expect(readEnvValue('K=\nK="quoted-value"\n', 'K')).toBe('quoted-value');
    expect(readEnvValue('# K=x\n', 'K')).toBe('');
    expect(hasEnvKey('# K=x\n', 'K')).toBe(false);
    expect(hasEnvKey('K=\n', 'K')).toBe(true);
  });
});

describe('writes', () => {
  it('keeps mode 0600 and the JSON file style', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-files-'));
    try {
      const p = path.join(dir, 'secrets.env');
      writeFileAtomic(p, 'A=1\n', 0o600);
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
      writeFileAtomic(p, 'A=2\n');
      expect(fs.statSync(p).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir)).toEqual(['secrets.env']);
      expect(formatJsonLike('{\n    "a": 1\n}', { a: 2 })).toBe('{\n    "a": 2\n}');
      expect(formatJsonLike('{\n  "a": 1\n}\n', { a: 2 })).toBe('{\n  "a": 2\n}\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
