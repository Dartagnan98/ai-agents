// Org file helpers for Settings (2026-09-29): brand-voice.md sections, .env lines, and writes
// that never leave half a file behind. Server-only (fs); the parse/build functions are pure.

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Replace a file through a temp file + rename in the same folder, so a crash never leaves half a
 * file. Follows a symlink to the real file, keeps the old mode and owner, and uses `mode` when
 * given (the temp file is created with it, so a secret is never readable by others).
 */
export function writeFileAtomic(filePath: string, content: string, mode?: number): void {
  let target = filePath;
  try { target = fs.realpathSync(filePath); } catch { /* new file */ }
  let old: fs.Stats | null = null;
  try { old = fs.statSync(target); } catch { /* new file */ }
  const fileMode = mode ?? (old ? old.mode & 0o777 : 0o644);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode: fileMode });
    fs.chmodSync(tmp, fileMode);
    if (old) {
      try { fs.chownSync(tmp, old.uid, old.gid); } catch { /* only root can hand files to others */ }
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/** Read a JSON file that may start with a BOM. Throws on bad JSON. */
export function readJsonFile(filePath: string): { data: unknown; raw: string } {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return { data: JSON.parse(raw.replace(/^﻿/, '')), raw };
}

/** JSON text in the file's own indentation (2 spaces when unknown), keeping its trailing newline. */
export function formatJsonLike(raw: string, data: unknown): string {
  const indent = raw.match(/^([ \t]+)"/m)?.[1] ?? 2;
  return JSON.stringify(data, null, indent) + (raw.endsWith('\n') ? '\n' : '');
}

// ---------------------------------------------------------------------------
// .env files (orgs/<org>/secrets.env)
// ---------------------------------------------------------------------------

const envKeyLine = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);

/** True when the text has an assignment line for `key` (commented lines don't count). */
export function hasEnvKey(content: string, key: string): boolean {
  const re = envKeyLine(key);
  return content.split(/\r?\n/).some((line) => re.test(line));
}

/**
 * Value of `key`: the first non-empty assignment (what the Knowledge search reads), with one pair
 * of surrounding quotes removed. '' when the key is missing or empty.
 */
export function readEnvValue(content: string, key: string): string {
  const re = envKeyLine(key);
  for (const line of content.split(/\r?\n/)) {
    if (!re.test(line)) continue;
    let v = line.slice(line.indexOf('=') + 1).trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1).trim();
    }
    if (v) return v;
  }
  return '';
}

/**
 * Set `key=value`. Every existing assignment of the key is rewritten (so readers that take the
 * first line and readers that take the last agree), or one line is appended. Every other line
 * stays as it was; the text always ends with a newline.
 */
export function upsertEnvValue(content: string, key: string, value: string): string {
  const re = envKeyLine(key);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.length ? content.split(/\r?\n/) : [];
  let found = false;
  const out = lines.map((line) => {
    if (!re.test(line)) return line;
    found = true;
    return `${key}=${value}`;
  });
  if (!found) {
    if (out.length && out[out.length - 1] === '') out.splice(out.length - 1, 0, `${key}=${value}`);
    else out.push(`${key}=${value}`);
  }
  const text = out.join(eol);
  return text.endsWith(eol) ? text : text + eol;
}

// ---------------------------------------------------------------------------
// brand-voice.md
// ---------------------------------------------------------------------------

export type BrandVoiceKey = 'tone' | 'style' | 'guidelines';

/** The three sections Settings edits, with the template's hint for each. */
export const BRAND_VOICE_FIELDS: ReadonlyArray<{ key: BrandVoiceKey; heading: string; hint: string }> = [
  { key: 'tone', heading: 'Tone', hint: 'e.g., casual, professional, technical' },
  { key: 'style', heading: 'Style', hint: 'e.g., concise, detailed, conversational' },
  { key: 'guidelines', heading: 'Guidelines', hint: 'Any specific brand guidelines for agent communications' },
];

export interface ParsedBrandVoice {
  /** The H1 text, '' when the file has none. */
  title: string;
  /** Anything between the title and the first ## heading, kept as written. */
  preamble: string;
  /** Section text with the HTML comments taken out. */
  values: Record<BrandVoiceKey, string>;
  /** The comment under each heading (the template's hint when there is none). */
  hints: Record<BrandVoiceKey, string>;
  /** Every other ## section, verbatim (heading line included), in file order. */
  others: Array<{ heading: string; raw: string }>;
}

// ATX headings; a closing run of #s only counts after a space ("# Learn C#" keeps its #).
const H1 = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const H2 = /^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^[ \t]{0,3}(```|~~~)/;

/** Trim a value: single lines fully, multi-line text keeps the first line's indent. */
function tidy(value: string): string {
  const v = value.replace(/\r\n?/g, '\n');
  return v.includes('\n') ? v.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '') : v.trim();
}

/**
 * Take HTML comments out of a section (whole-line comments go with their line; an unclosed one
 * runs to the end). The first comment's text is the section's hint.
 */
function stripComments(text: string): { text: string; hint: string } {
  const first = text.match(/<!--([\s\S]*?)(?:-->|$)/);
  const hint = first ? first[1].replace(/\s+/g, ' ').trim() : '';
  let out = text.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\n|$)/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  const open = out.indexOf('<!--');
  if (open !== -1) out = out.slice(0, open);
  return { text: out, hint };
}

const headingKey = (heading: string) => heading.replace(/:$/, '').trim().toLowerCase();

export function parseBrandVoice(md: string): ParsedBrandVoice {
  const lines = md.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  let title = '';
  const pre: string[] = [];
  const sections: Array<{ heading: string; headingLine: string; body: string[] }> = [];
  let fence = false;

  for (const line of lines) {
    if (!fence) {
      const h2 = line.match(H2);
      if (h2) { sections.push({ heading: h2[1].trim(), headingLine: line, body: [] }); continue; }
      const h1 = !title && sections.length === 0 ? line.match(H1) : null;
      if (h1) { title = h1[1].trim(); continue; }
    }
    if (FENCE.test(line)) fence = !fence;
    (sections.length ? sections[sections.length - 1].body : pre).push(line);
  }

  const values: Record<BrandVoiceKey, string> = { tone: '', style: '', guidelines: '' };
  const hints = Object.fromEntries(BRAND_VOICE_FIELDS.map((f) => [f.key, f.hint])) as Record<BrandVoiceKey, string>;
  const taken = new Set<BrandVoiceKey>();
  const others: ParsedBrandVoice['others'] = [];

  for (const s of sections) {
    const field = BRAND_VOICE_FIELDS.find((f) => f.heading.toLowerCase() === headingKey(s.heading) && !taken.has(f.key));
    if (!field) {
      others.push({ heading: s.heading, raw: [s.headingLine, ...s.body].join('\n').replace(/\s+$/, '') });
      continue;
    }
    taken.add(field.key);
    const { text, hint } = stripComments(s.body.join('\n'));
    values[field.key] = tidy(text);
    if (hint) hints[field.key] = hint;
  }

  return { title, preamble: tidy(pre.join('\n')), values, hints, others };
}

/** Headings typed inside a value would start a new section: demote them to ###. */
function keepInSection(value: string): string {
  let fence = false;
  return value
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) { fence = !fence; return line; }
      return fence ? line : line.replace(/^(#{1,2})(?=[ \t])/, '###');
    })
    .join('\n');
}

/**
 * The new brand-voice.md: title, then Tone, Style and Guidelines (an empty field keeps its hint
 * comment), then every other ## section from the old file, unchanged. The old title and any text
 * above the first section are kept too.
 */
export function buildBrandVoice(next: Record<BrandVoiceKey, string>, oldMd = ''): string {
  const old = parseBrandVoice(oldMd);
  const out: string[] = [`# ${old.title || 'Brand Voice'}`, ''];
  if (old.preamble) out.push(old.preamble, '');
  for (const f of BRAND_VOICE_FIELDS) {
    const value = keepInSection(tidy(next[f.key] ?? ''));
    out.push(`## ${f.heading}`, value || `<!-- ${old.hints[f.key]} -->`, '');
  }
  for (const s of old.others) out.push(s.raw, '');
  return out.join('\n');
}
