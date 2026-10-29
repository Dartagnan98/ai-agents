'use client';

import { useEffect, useState } from 'react';
import { IconChevronRight, IconFileText } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

export type TreeNode =
  | {
      kind: 'dir';
      name: string;
      relPath: string;
      children: TreeNode[];
    }
  | {
      kind: 'file';
      name: string;
      relPath: string;
      mtimeMs: number;
    };

interface FolderTreeProps {
  nodes: TreeNode[];
  selected: string | null;
  onSelectFile: (relPath: string) => void;
  /** sessionStorage key for persisting expanded state across reloads */
  storageKey?: string;
  /** show file names whole (AI › Skills: SKILL.md, references/x.md); the wiki drops .md */
  fullNames?: boolean;
  /** folders open on a first visit (the wiki: 00-inbox) */
  defaultOpen?: string[];
}

/** Amber folder (open = tinted fill), drawn to match the board. */
export function FolderGlyph({ open, size = 17 }: { open: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-chart-4" aria-hidden="true">
      {open ? (
        <path className="fill-watch-bg" d="M3 17V7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1 M3 17l2.4-5.6A2 2 0 0 1 7.2 10H20a1 1 0 0 1 .9 1.4L18.6 17a2 2 0 0 1-1.8 1.2H4.8A1.8 1.8 0 0 1 3 17z" />
      ) : (
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      )}
    </svg>
  );
}

export function FolderTree({
  nodes,
  selected,
  onSelectFile,
  storageKey = 'wiki:expanded',
  fullNames = false,
  defaultOpen = ['00-inbox'],
}: FolderTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set(defaultOpen);
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return new Set(defaultOpen);
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set(defaultOpen);
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch {
      /* sessionStorage unavailable: fall through silently */
    }
  }, [expanded, storageKey]);

  // When selecting a file, auto-expand its ancestor dirs so it's visible
  useEffect(() => {
    if (!selected) return;
    const parts = selected.split('/');
    if (parts.length <= 1) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc = acc ? `${acc}/${parts[i]}` : parts[i];
        next.add(acc);
      }
      return next;
    });
  }, [selected]);

  const toggle = (relPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  if (nodes.length === 0) {
    return (
      <div className="p-4 text-center text-[13px] text-muted-foreground">
        Empty vault.
      </div>
    );
  }

  return (
    <div role="tree" aria-label="Vault file tree" className="flex flex-col gap-px">
      {nodes.map((node) => (
        <TreeRow
          key={node.relPath}
          node={node}
          depth={0}
          expanded={expanded}
          selected={selected}
          onToggle={toggle}
          onSelectFile={onSelectFile}
          fullNames={fullNames}
        />
      ))}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  expanded,
  selected,
  onToggle,
  onSelectFile,
  fullNames = false,
}: {
  fullNames?: boolean;
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (relPath: string) => void;
  onSelectFile: (relPath: string) => void;
}) {
  // 14px per depth level keeps nested folders readable inside the 280-340px browser card.
  const padLeft = 6 + depth * 14;

  if (node.kind === 'dir') {
    const isOpen = expanded.has(node.relPath);
    return (
      <>
        <button
          type="button"
          onClick={() => onToggle(node.relPath)}
          role="treeitem"
          aria-expanded={isOpen}
          aria-level={depth + 1}
          className="flex h-[34px] w-full shrink-0 items-center gap-2 rounded-[10px] pr-2.5 text-left transition-colors hover:bg-[#F8F9FB] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:bg-inset"
          style={{ paddingLeft: padLeft }}
        >
          <IconChevronRight
            size={14}
            stroke={2}
            className={cn('shrink-0 text-label transition-transform', isOpen && 'rotate-90')}
            aria-hidden="true"
          />
          <FolderGlyph open={isOpen} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{node.name}</span>
          {node.children.length > 0 && (
            <span className="shrink-0 text-[11.5px] tabular-nums text-label">
              {node.children.length}
            </span>
          )}
        </button>
        {isOpen && (
          <div role="group" className="flex flex-col gap-px">
            {node.children.map((child) => (
              <TreeRow
                key={child.relPath}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelectFile={onSelectFile}
                fullNames={fullNames}
              />
            ))}
          </div>
        )}
      </>
    );
  }

  const isSelected = selected === node.relPath;
  const display = fullNames ? node.name : node.name.replace(/\.md$/, '');

  return (
    <button
      type="button"
      onClick={() => onSelectFile(node.relPath)}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isSelected}
      title={display}
      className={cn(
        'relative flex h-8 w-full shrink-0 items-center gap-2 rounded-[10px] pr-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        isSelected
          ? 'bg-accent font-semibold text-foreground'
          : 'text-muted-foreground hover:bg-[#F8F9FB] hover:text-foreground dark:hover:bg-inset',
      )}
      // Files line up under their folder's name (past the chevron + folder icon column).
      style={{ paddingLeft: padLeft + 18 }}
    >
      {isSelected && <span aria-hidden="true" className="absolute bottom-[7px] top-[7px] w-0.5 rounded-full bg-primary" style={{ left: padLeft + 8 }} />}
      <IconFileText size={14} stroke={1.7} className={cn('shrink-0', isSelected ? 'text-primary' : 'text-[#8A93A6]')} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{display}</span>
    </button>
  );
}
