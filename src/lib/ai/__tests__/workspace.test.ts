import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: {} }));

// Agent workspace (D, 2026-10-27): what each sandboxed command is allowed. The escapes themselves are tried on the box
// (scripts/fleet-work/selfcheck.sh); here the unit's settings and the path rules.
describe('agent workspace', () => {
  it('keeps paths inside the workspace', async () => {
    const { workPath } = await import('../workspace');
    expect(workPath('skills/x/run.py')).toBe('skills/x/run.py');
    expect(workPath('./out/a.csv')).toBe('out/a.csv');
    for (const bad of ['', '/etc/passwd', '../x', 'skills/../../root', 'a\nb', 'x'.repeat(301)]) expect(() => workPath(bad)).toThrow();
  });
  it('runs every command as the workspace user, walled in', async () => {
    const { unitArgs } = await import('../workspace');
    const a = unitArgs('/srv/fleet-work/agc1', 120, ['/bin/bash', '-c', 'ls']);
    const props = a.filter((_, i) => a[i - 1] === '-p');
    for (const p of ['User=fleetwork', 'ProtectHome=yes', 'ProtectSystem=strict', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'PrivateTmp=yes',
      'BindPaths=/srv/fleet-work/agc1:/work', 'InaccessiblePaths=/srv/fleet-work', 'WorkingDirectory=/work', 'IPAddressDeny=any',
      'MemoryMax=1G', 'RuntimeMaxSec=120', 'InaccessiblePaths=-/var/cache/ctrl-os-zoom', 'ProtectProc=invisible']) {
      expect(props).toContain(p);
    }
    expect(a.slice(a.indexOf('--') + 1)).toEqual(['/bin/bash', '-c', 'ls']);
    expect(a).toContain('--wait');
    expect(props.some((p) => p.startsWith('LoadCredential'))).toBe(false);
    // a script's Fleet key: a credential file, never on the command line
    const k = unitArgs('/srv/fleet-work/agc1', 60, ['python3', 'x.py'], 'fleetwork-abc', { keyFile: '/run/fleet-keys/fleetwork-abc', mcpUrl: 'http://127.0.0.1:3000/api/ai/mcp' });
    expect(k).toContain('LoadCredential=fleet_key:/run/fleet-keys/fleetwork-abc');
    expect(k).toContain('Environment=FLEET_MCP_URL=http://127.0.0.1:3000/api/ai/mcp');
    expect(k).toContain('--unit=fleetwork-abc');
    expect(k.join(' ')).not.toMatch(/fai_/);
  });
  it('one folder per agency, named safely', async () => {
    const { agencySlug } = await import('../workspace');
    expect(agencySlug('agc_JOh52FB1vdXuqJAsDjRS')).toBe('agc_JOh52FB1vdXuqJAsDjRS');
    expect(agencySlug('../../root')).toBe('root');
    expect(agencySlug(undefined)).toBe('default');
  });
  it('file helpers pass their arguments on stdin, never through a shell', async () => {
    const { writeArgs, editArgs, searchArgs, readArgs } = await import('../workspace');
    const w = writeArgs('out/a.csv', 'x,y\n$(rm -rf /)');
    expect(w.argv[0]).toBe('/usr/bin/python3');
    expect(JSON.parse(w.stdin)).toEqual({ path: 'out/a.csv', content: 'x,y\n$(rm -rf /)' });
    expect(JSON.parse(editArgs('a.py', 'old', 'new', false).stdin)).toEqual({ path: 'a.py', old: 'old', new: 'new', all: false });
    expect(searchArgs('alex; rm -rf /', '', '').argv).toEqual(['/usr/bin/grep', '-rnIiF', '--exclude-dir=__pycache__', '-m', '50', '--', 'alex; rm -rf /', '.']);
    expect(searchArgs('', 'skills/x', '*.py').argv).toEqual(['/usr/bin/find', 'skills/x', '-type', 'f', '-name', '*.py', '-not', '-path', '*/__pycache__/*']);
    expect(readArgs('a.txt').argv.slice(-2)).toEqual(['--', 'a.txt']);
    expect(() => readArgs('/root/.env')).toThrow();
  });
  it('long output keeps its start and end', async () => {
    const { clip } = await import('../workspace');
    expect(clip('short')).toBe('short');
    const c = clip(`START${'x'.repeat(50_000)}END`, 1000);
    expect(c.startsWith('START')).toBe(true);
    expect(c.endsWith('END')).toBe(true);
    expect(c.length).toBeLessThan(1100);
  });
});
