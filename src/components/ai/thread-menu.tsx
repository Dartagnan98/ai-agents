'use client';

import { useState } from 'react';
import { IconDots, IconPencil, IconTrash } from '@tabler/icons-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { notifyThreads } from './use-ai';

// The conversation menu (D, 2026-10-09, ThreadMenu): Rename, Delete. On each conversation row of the AI
// page's list and in the conversation header.
export function ThreadMenu({ thread, onRenamed, onGone, className }: {
  thread: { id: number; title: string }; onRenamed?: (title: string) => void; onGone?: () => void; className?: string;
}) {
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const [name, setName] = useState(thread.title);
  const [busy, setBusy] = useState(false);
  const rename = async () => {
    const t = name.trim(); if (!t || t === thread.title) { setDialog(null); return; }
    setBusy(true);
    const r = await fetch(`/api/ai/chat?thread=${thread.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: t }) }).catch(() => null);
    setBusy(false);
    if (r?.ok) { notifyThreads(); onRenamed?.(t); setDialog(null); }
  };
  const remove = async () => {
    setBusy(true);
    const r = await fetch(`/api/ai/chat?thread=${thread.id}`, { method: 'DELETE' }).catch(() => null);
    setBusy(false);
    if (r?.ok) { notifyThreads(); setDialog(null); onGone?.(); }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={`More for ${thread.title}`} className={cn('grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-inset hover:text-foreground', className)}>
          <IconDots size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[200px]">
          <DropdownMenuItem onClick={() => { setName(thread.title); setDialog('rename'); }}><IconPencil size={15} stroke={1.8} />Rename</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDialog('delete')} className="text-weak"><IconTrash size={15} stroke={1.8} />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dialog !== null} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <DialogContent className="sm:max-w-[420px]">
          {dialog === 'rename' ? <>
            <DialogHeader><DialogTitle>Rename conversation</DialogTitle></DialogHeader>
            <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void rename(); }} aria-label="Conversation name" />
            <DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={busy || !name.trim()} onClick={() => void rename()}>Rename</Button></DialogFooter>
          </> : <>
            <DialogHeader><DialogTitle>Delete &ldquo;{thread.title || 'Untitled'}&rdquo;?</DialogTitle><DialogDescription>The messages are deleted for good.</DialogDescription></DialogHeader>
            <DialogFooter><Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>Delete</Button></DialogFooter>
          </>}
        </DialogContent>
      </Dialog>
    </>
  );
}
