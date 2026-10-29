import zlib from 'zlib';

// Excel, Word and PowerPoint files for the agents chats (D, 2026-10-23: "pdf or xlsx or those things"), as text the model reads.
// .xlsx/.docx/.pptx are zip files of XML: the central directory lists the parts, each stored or deflated (zlib's inflateRaw).
// shortcut: no styles, formulas show their last saved value, dates stay Excel serial numbers; a real library if people need more.
const MAX_PART = 30 * 1024 * 1024;

/** The parts of a zip file by name (only the ones `want` keeps). Throws on anything that is not a zip. */
export function unzip(buf: Buffer, want: (name: string) => boolean): Map<string, Buffer> {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), full = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extra + comment;
    if (!want(name) || full > MAX_PART) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), raw = buf.subarray(start, start + size);
    out.set(name, method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: MAX_PART }) : Buffer.alloc(0));
  }
  return out;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()]);
/** The text runs of one XML block (<w:t>, <a:t>, <t>), joined. */
const runs = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => unescape(m[1])).join('');
const byNumber = (a: string, b: string) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

/** Column letters to a 0-based index (A = 0, AA = 26). */
const colOf = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function xlsxText(buf: Buffer): string {
  const parts = unzip(buf, (n) => n === 'xl/workbook.xml' || n === 'xl/sharedStrings.xml' || n === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...(parts.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1], 't'));
  // sheet names in workbook order, each to its worksheet part through the relationships
  const rels = new Map([...(parts.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '').matchAll(/<Relationship\b[^>]*>/g)]
    .map((m) => [/Id="([^"]+)"/.exec(m[0])?.[1] ?? '', /Target="([^"]+)"/.exec(m[0])?.[1] ?? ''] as const));
  const sheets = [...(parts.get('xl/workbook.xml')?.toString('utf8') ?? '').matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const target = rels.get(/r:id="([^"]+)"/.exec(m[0])?.[1] ?? '') ?? '';
    return { name: unescape(/name="([^"]*)"/.exec(m[0])?.[1] ?? 'Sheet'), part: target ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}` : '' };
  });
  const list = sheets.length ? sheets : [...parts.keys()].filter((k) => k.startsWith('xl/worksheets/')).sort(byNumber).map((part, i) => ({ name: `Sheet${i + 1}`, part }));
  return list.map(({ name, part }) => {
    const xml = parts.get(part)?.toString('utf8') ?? '';
    const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
      const vals: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] ?? '', t = /\bt="([^"]+)"/.exec(attrs)?.[1], ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        const text = t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? runs(body, 't') : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : unescape(v);
        const at = ref ? colOf(ref) : vals.length;
        while (vals.length < at) vals.push('');
        vals[at] = cell(text);
      }
      return vals.join(',');
    }).filter((line) => line.replace(/,/g, '').trim());
    return `--- Sheet: ${name} (${rows.length} rows, CSV) ---\n${rows.join('\n')}`;
  }).join('\n\n');
}

export function docxText(buf: Buffer): string {
  const xml = unzip(buf, (n) => n === 'word/document.xml').get('word/document.xml')?.toString('utf8') ?? '';
  return [...xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map((p) => runs((p[1] ?? '').replace(/<w:tab\/>/g, '<w:t>\t</w:t>'), 'w:t'))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function pptxText(buf: Buffer): string {
  const parts = unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  return [...parts.keys()].sort(byNumber).map((k, i) => {
    const xml = parts.get(k)!.toString('utf8');
    const lines = [...xml.matchAll(/<a:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/a:p>)/g)].map((p) => runs(p[1] ?? '', 'a:t')).filter((l) => l.trim());
    return `--- Slide ${i + 1} ---\n${lines.join('\n')}`;
  }).join('\n\n');
}

/** Which Office file this is, from its name; null = not one of these. */
export function officeKind(name: string): 'xlsx' | 'docx' | 'pptx' | null {
  const m = /\.(xlsx|xlsm|docx|pptx)$/i.exec(name)?.[1].toLowerCase();
  return m === 'xlsm' ? 'xlsx' : (m as 'xlsx' | 'docx' | 'pptx' | undefined) ?? null;
}
export function officeText(kind: 'xlsx' | 'docx' | 'pptx', buf: Buffer): string {
  return kind === 'xlsx' ? xlsxText(buf) : kind === 'docx' ? docxText(buf) : pptxText(buf);
}
