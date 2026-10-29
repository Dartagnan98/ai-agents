'use client';

import { useCallback, useEffect, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Pill, Section } from '@/components/shared/page-kit';
import { fetchAllowedRoots, addAllowedRoot, removeAllowedRoot } from '@/lib/actions/settings';

interface AllowedRootEntry {
  path: string;
  exists: boolean;
}

interface AllowedRootsView {
  ctx_root: string;
  additional_roots: AllowedRootEntry[];
}

/**
 * Allowed Roots tab: controls which directories the dashboard media API
 * is permitted to serve files from. CTX_ROOT is always implicitly allowed.
 * Users add additional directories so agents can reference files from
 * project trees outside the default runtime directory.
 */
export function AllowedRootsTab() {
  const [view, setView] = useState<AllowedRootsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const data = await fetchAllowedRoots();
    setView(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAdd() {
    setAdding(true);
    setError('');
    const result = await addAllowedRoot(newPath);
    if (result.success) {
      setNewPath('');
      await load();
    } else {
      setError(result.error ?? 'Failed to add allowed root');
    }
    setAdding(false);
  }

  async function handleDelete(path: string) {
    if (!window.confirm(`Remove ${path} from the allowed roots? The dashboard will stop serving files from it.`)) return;
    setError('');
    const result = await removeAllowedRoot(path);
    if (result.success) {
      await load();
    } else {
      setError(result.error ?? 'Failed to remove allowed root');
    }
  }

  if (loading || !view) {
    return <div className="h-48 animate-pulse rounded-[22px] bg-card shadow-[var(--card-shadow)]" />;
  }

  const isEmpty = view.additional_roots.length === 0;
  const total = view.additional_roots.length + 1;

  return (
    <div className="flex flex-col gap-6">
      <Section
        flush
        title="Allowed roots"
        description="Folders the dashboard may serve files from, so agents can attach files as references."
        actions={<span className="micro-label">{total} root{total === 1 ? '' : 's'}</span>}
      >
        <div className="flex flex-col gap-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6 md:pl-7">Path</TableHead>
                <TableHead className="w-36">Status</TableHead>
                <TableHead className="w-24 pr-6 text-right md:pr-7"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="pl-6 font-mono text-[12.5px] md:pl-7">{view.ctx_root}</TableCell>
                <TableCell><Pill tone="neutral" className="text-muted-foreground">system default</Pill></TableCell>
                <TableCell className="pr-6 md:pr-7" />
              </TableRow>
              {view.additional_roots.map((entry) => (
                <TableRow key={entry.path}>
                  <TableCell className="pl-6 font-mono text-[12.5px] md:pl-7">{entry.path}</TableCell>
                  <TableCell>
                    {entry.exists ? <Pill tone="healthy" dot>exists</Pill> : <Pill tone="watch" dot>missing</Pill>}
                  </TableCell>
                  <TableCell className="pr-6 text-right md:pr-7">
                    <Button
                      variant="destructive"
                      size="xs"
                      onClick={() => handleDelete(entry.path)}
                      aria-label={`Delete allowed root ${entry.path}`}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {isEmpty && (
            <p className="px-6 text-[12px] text-label md:px-7">
              No additional allowed roots configured. By default, the dashboard can only serve files from{' '}
              <span className="font-mono">{view.ctx_root}</span>. Add directories below to let agents attach files
              from project trees as references.
            </p>
          )}
        </div>
      </Section>

      <Section title="Add allowed root">
        <div className="flex max-w-xl flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="new-allowed-root" className="text-[12.5px] font-semibold text-muted-foreground">Absolute path</label>
            <Input
              id="new-allowed-root"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="/home/user/projects/my-project"
              className="font-mono md:text-[12.5px]"
            />
            <span className="text-[12px] text-label">
              Must be an absolute path to an existing directory. System directories
              (drive roots, /etc, /usr, C:/Windows, etc.) are blocked for security.
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleAdd} disabled={adding} className="h-10 px-[18px]">
              {adding ? 'Adding...' : 'Add root'}
            </Button>
            {error && <p className="text-[12.5px] text-destructive">{error}</p>}
          </div>
        </div>
      </Section>
    </div>
  );
}
