'use client';

import { useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  IconGripVertical,
  IconPencil,
  IconTrash,
  IconCheck,
} from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { Goal } from '@/lib/types';

interface GoalItemProps {
  goal: Goal;
  /** Position in the list (0-based), shown as 01, 02… */
  index?: number;
  onUpdate: (id: string, title: string, progress: number) => void;
  onDelete: (id: string) => void;
}

export function GoalItem({ goal, index, onUpdate, onDelete }: GoalItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(goal.title);
  const [editProgress, setEditProgress] = useState(goal.progress);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: goal.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleSave = () => {
    const trimmed = editTitle.trim();
    if (trimmed.length === 0) return;
    onUpdate(goal.id, trimmed, editProgress);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditTitle(goal.title);
    setEditProgress(goal.progress);
    setIsEditing(false);
  };

  const handleStartEdit = () => {
    setEditTitle(goal.title);
    setEditProgress(goal.progress);
    setIsEditing(true);
    setConfirmDelete(false);
  };

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete(goal.id);
  };

  const number = index !== undefined ? String(index + 1).padStart(2, '0') : null;

  if (isEditing) {
    return (
      <div
        ref={setNodeRef}
        style={style}
        className="-mx-3 my-1.5 flex flex-col gap-3 rounded-[14px] bg-[#F8F9FB] p-3 ring-[1.5px] ring-inset ring-[#C9D3FA] md:flex-row md:items-center md:gap-2.5 dark:bg-inset dark:ring-primary/40"
      >
        <span aria-hidden className="hidden w-[22px] shrink-0 justify-center text-[#C9D1E6] md:flex dark:text-border">
          <IconGripVertical size={15} />
        </span>
        {number && <span className="hidden w-[26px] shrink-0 font-mono text-[11px] text-label md:block">{number}</span>}
        <Input
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          placeholder="Goal title"
          aria-label="Goal title"
          className="h-[38px] min-w-0 flex-1 text-[14px] md:text-[14px]"
          maxLength={200}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
            if (e.key === 'Escape') handleCancel();
          }}
        />
        <div className="flex items-center gap-2.5">
          <input
            type="range"
            min={0}
            max={100}
            value={editProgress}
            onChange={(e) => setEditProgress(Number(e.target.value))}
            aria-label="Progress"
            className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary md:w-[180px] md:flex-none"
          />
          <span className="w-12 text-right font-mono text-[13px] font-semibold tabular-nums">
            {editProgress}%
          </span>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" onClick={handleCancel} variant="outline">
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} variant="default">
            <IconCheck size={13} stroke={2.2} />
            Save
          </Button>
        </div>
      </div>
    );
  }

  const done = goal.progress >= 100;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'flex min-h-[54px] items-center gap-2.5 border-b border-[#F1F3F7] py-2 last:border-b-0 dark:border-hairline',
        isDragging && 'relative z-10 rounded-xl border-transparent bg-card opacity-90 shadow-lg',
      )}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="flex h-[30px] w-[22px] shrink-0 cursor-grab items-center justify-center rounded-md text-[#8A93A6] transition-colors hover:text-foreground active:cursor-grabbing"
        aria-label={`Drag to reorder: ${goal.title}`}
      >
        <IconGripVertical size={15} />
      </button>

      {number && <span className="w-[26px] shrink-0 font-mono text-[11px] text-label">{number}</span>}

      {/* Goal content */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:flex-row md:items-center md:gap-2.5">
        <span className="min-w-0 truncate text-[14px] font-medium md:flex-1">{goal.title}</span>
        <span className="block h-2 w-full shrink-0 overflow-hidden rounded-full bg-secondary md:w-[180px]">
          <span
            className={cn('block h-full rounded-full transition-all duration-300', done ? 'bg-[#0B8F6A]' : 'bg-primary')}
            style={{ width: `${Math.max(0, Math.min(100, goal.progress))}%` }}
          />
        </span>
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-[13px] tabular-nums">
        {goal.progress}%
      </span>

      {/* Actions */}
      <div className="flex shrink-0 items-center justify-end gap-0.5">
        <button
          type="button"
          onClick={handleStartEdit}
          aria-label={`Edit: ${goal.title}`}
          className="flex size-[30px] items-center justify-center rounded-[9px] text-label transition-colors hover:bg-muted hover:text-foreground"
        >
          <IconPencil size={14} />
        </button>
        <button
          type="button"
          onClick={handleDelete}
          onBlur={() => setConfirmDelete(false)}
          aria-label={confirmDelete ? `Click again to delete: ${goal.title}` : `Delete: ${goal.title}`}
          className={cn(
            'flex h-[30px] items-center justify-center rounded-[9px] text-weak transition-colors',
            confirmDelete ? 'animate-pulse bg-weak-bg px-2.5 text-[12px] font-semibold' : 'w-[30px] hover:bg-weak-bg',
          )}
        >
          {confirmDelete ? 'Click again' : <IconTrash size={14} />}
        </button>
      </div>
    </div>
  );
}
