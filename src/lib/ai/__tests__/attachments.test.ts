import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/drive/service', () => ({ driveAgencyId: () => 'local', driveDir: () => '/tmp/x/drive' }));

// Chat files (D, 2026-10-23): which files are taken, and how text files reach the model.
describe('chat attachments', () => {
  it('takes pictures, PDFs and text files only', async () => {
    const { kindOf } = await import('../attachments');
    expect(kindOf('image/png', 'a.png')).toBe('image');
    expect(kindOf('image/webp', 'a.webp')).toBe('image');
    expect(kindOf('application/pdf', 'deck')).toBe('pdf');
    expect(kindOf('', 'Deck.PDF')).toBe('pdf');
    expect(kindOf('text/csv', 'leads.csv')).toBe('text');
    expect(kindOf('application/octet-stream', 'notes.md')).toBe('text');
    expect(kindOf('application/zip', 'a.zip')).toBeNull();
    expect(kindOf('image/svg+xml', 'logo.svg')).toBeNull(); // not a picture the model takes, and scripts can hide in it
    expect(kindOf('application/x-msdownload', 'run.exe')).toBeNull();
  });
  it('folds text files into the prompt and leaves pictures to the runner', async () => {
    const { withTextFiles } = await import('../attachments');
    expect(withTextFiles('hi', [])).toBe('hi');
    const p = withTextFiles('Look at this', [{ kind: 'text', name: 'a.csv', text: 'x,y\n1,2' }, { kind: 'image', name: 'p.png', mediaType: 'image/png', data: 'AA==' }]);
    expect(p).toContain('=== Attached file: a.csv ===\nx,y\n1,2\n=== End of a.csv ===');
    expect(p).not.toContain('p.png');
  });
  // Big files (D, 2026-10-27): the start in the prompt, the rest through read_file / search_file
  it('pages a long file by line, capped at 40,000 characters a call', async () => {
    const { readFileLines } = await import('../attachments');
    const text = Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`).join('\n');
    expect(readFileLines(text, 1, 3)).toBe('Lines 1-3 of 1000 (next: from_line 4)\n1\trow 1\n2\trow 2\n3\trow 3');
    expect(readFileLines(text, 999, 400)).toBe('Lines 999-1000 of 1000 (end of file)\n999\trow 999\n1000\trow 1000');
    expect(readFileLines(text, 2000, 10)).toContain('past the end');
    const wide = Array.from({ length: 50 }, () => 'x'.repeat(5000)).join('\n');
    const out = readFileLines(wide, 1, 2000);
    expect(out.length).toBeLessThan(41_000);
    expect(out).toMatch(/^Lines 1-\d+ of 50 \(next: from_line \d+\)/);
  });
  it('finds lines holding every word of the query', async () => {
    const { searchFileLines } = await import('../attachments');
    const text = 'Skill: adpi_seq\nOwner: Alex Kim\nalex kim approves texts\nnothing here';
    expect(searchFileLines(text, 'alex KIM')).toBe('2 matching lines:\n2\tOwner: Alex Kim\n3\talex kim approves texts');
    expect(searchFileLines(text, 'alex', 1)).toBe('2 matching lines (first 1 shown):\n2\tOwner: Alex Kim');
    expect(searchFileLines(text, 'nobody')).toBe('No line contains "nobody".');
  });
});
