import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { docxText, officeKind, pptxText, xlsxText } from '../office';

// Excel, Word and PowerPoint in Fleet AI chats (D, 2026-10-23), read from files made by real writers (openpyxl, python-pptx, textutil).
const has = (cmd: string, args: string[]) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };
const py = has('python3', ['-c', 'import openpyxl, pptx']), mac = has('textutil', ['-help']) || process.platform === 'darwin';
const dir = mkdtempSync(path.join(os.tmpdir(), 'office-'));

describe('Office files as text', () => {
  it('names the kinds it reads', () => {
    expect(officeKind('Q3 report.XLSX')).toBe('xlsx');
    expect(officeKind('macro.xlsm')).toBe('xlsx');
    expect(officeKind('a.docx')).toBe('docx');
    expect(officeKind('deck.pptx')).toBe('pptx');
    expect(officeKind('old.xls')).toBeNull();
    expect(officeKind('a.pdf')).toBeNull();
  });

  it.skipIf(!py)('Excel: every sheet by name, shared and inline strings, gaps kept, commas quoted, numbers and booleans', () => {
    const f = path.join(dir, 'book.xlsx');
    execFileSync('python3', ['-c', `
import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Deals"
ws.append(["Rep", "Cash", "Note", None, "Won"])
ws.append(["Alex Kim", 10500, "Paid, in full", None, True])
ws["D3"] = "gap filled"; ws["A3"] = "Riley & Co"
s2 = wb.create_sheet("Setters"); s2.append(["Name", "Sets"]); s2.append(["Morgan", 121])
wb.save(${JSON.stringify(f)})`]);
    const t = xlsxText(readFileSync(f));
    expect(t).toContain('--- Sheet: Deals (3 rows, CSV) ---');
    expect(t).toContain('Rep,Cash,Note,,Won');
    expect(t).toContain('Alex Kim,10500,"Paid, in full",,TRUE');
    expect(t).toContain('Riley & Co,,,gap filled');
    expect(t).toContain('--- Sheet: Setters (2 rows, CSV) ---\nName,Sets\nMorgan,121');
  });

  it.skipIf(!py)('PowerPoint: each slide numbered, in order, every line', () => {
    const f = path.join(dir, 'deck.pptx');
    execFileSync('python3', ['-c', `
from pptx import Presentation
p = Presentation()
for i in range(1, 12):
    s = p.slides.add_slide(p.slide_layouts[1]); s.shapes.title.text = f"Slide title {i}"; s.placeholders[1].text = f"Point A {i}\\nPoint B {i}"
p.save(${JSON.stringify(f)})`]);
    const t = pptxText(readFileSync(f));
    expect(t.startsWith('--- Slide 1 ---\nSlide title 1\nPoint A 1\nPoint B 1')).toBe(true);
    expect(t.indexOf('--- Slide 2 ---')).toBeLessThan(t.indexOf('--- Slide 10 ---')); // 10 after 2, not after 1
    expect(t).toContain('--- Slide 11 ---\nSlide title 11');
  });

  it.skipIf(!mac)('Word: paragraphs in order, special characters back to plain text', () => {
    const src = path.join(dir, 'memo.txt'), f = path.join(dir, 'memo.docx');
    writeFileSync(src, 'the agency onboarding memo\nRule 1: clear "Bookings waiting" daily & on time.\nRule 2: 5 < 10 > 2');
    execFileSync('textutil', ['-convert', 'docx', src, '-output', f]);
    const t = docxText(readFileSync(f));
    expect(t).toBe('the agency onboarding memo\nRule 1: clear "Bookings waiting" daily & on time.\nRule 2: 5 < 10 > 2');
  });

  it('refuses a file that is not a zip', () => {
    expect(() => xlsxText(Buffer.from('not a spreadsheet at all, just text'))).toThrow();
  });
});
