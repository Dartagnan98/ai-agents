'use client';

import { useState, useCallback, useEffect } from 'react';
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { IconPlus, IconTarget, IconInfoCircle } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/shared/page-kit';
import { GoalItem } from './goal-item';
import type { Goal } from '@/lib/types';

type Result = Promise<{ success: boolean; error?: string }>;
/** Where the list saves: Operations › Strategy's own goals. */
export interface GoalsApi {
  updateGoals: (goals: Goal[]) => Result;
  addGoal: (title: string) => Result;
  deleteGoal: (id: string) => Result;
  reorderGoals: (ids: string[]) => Result;
}

interface GoalsListProps {
  goals: Goal[];
  org: string;
  onRefresh: () => void;
  api: GoalsApi;
}

export function GoalsList({ goals: initialGoals, org, onRefresh, api }: GoalsListProps) {
  const store = api;
  const [goals, setGoals] = useState<Goal[]>(
    [...initialGoals].sort((a, b) => a.order - b.order),
  );
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Sync when props change
  useEffect(() => {
    setGoals([...initialGoals].sort((a, b) => a.order - b.order));
  }, [initialGoals]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = goals.findIndex((g) => g.id === active.id);
      const newIndex = goals.findIndex((g) => g.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;

      const reordered = arrayMove(goals, oldIndex, newIndex);
      setGoals(reordered);

      await store.reorderGoals(reordered.map((g) => g.id));
      onRefresh();
    },
    [goals, store, onRefresh],
  );

  const handleUpdate = useCallback(
    async (id: string, title: string, progress: number) => {
      setIsSaving(true);
      const updated = goals.map((g) =>
        g.id === id ? { ...g, title, progress } : g,
      );
      setGoals(updated);
      await store.updateGoals(updated);
      setIsSaving(false);
      onRefresh();
    },
    [goals, store, onRefresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setGoals((prev) => prev.filter((g) => g.id !== id));
      await store.deleteGoal(id);
      onRefresh();
    },
    [store, onRefresh],
  );

  const handleAdd = useCallback(async () => {
    const trimmed = newTitle.trim();
    if (trimmed.length === 0) return;

    setIsSaving(true);
    const result = await store.addGoal(trimmed);
    if (result.success) {
      setNewTitle('');
      setIsAdding(false);
      onRefresh();
    }
    setIsSaving(false);
  }, [newTitle, store, onRefresh]);

  const average = goals.length ? Math.round(goals.reduce((s, g) => s + g.progress, 0) / goals.length) : 0;

  return (
    <Section
      title={
        <span className="flex items-center gap-2.5">
          Goals
          {isSaving && (
            <span className="animate-pulse text-[12px] font-normal text-label">
              Saving...
            </span>
          )}
        </span>
      }
      description={goals.length > 0 ? `In priority order. Progress is set by hand; average ${average}%.` : 'In priority order. Progress is set by hand.'}
      actions={goals.length > 0 && !isAdding ? (
        <Button variant="outline" onClick={() => setIsAdding(true)}>
          <IconPlus size={15} stroke={2} />
          Add goal
        </Button>
      ) : undefined}
    >
      {goals.length === 0 && !isAdding ? (
        <div className="flex flex-col items-center gap-3 rounded-[18px] bg-foreground/[0.04] px-6 py-8 text-center">
          <IconTarget size={30} stroke={1.6} className="text-[#8A93A6]" />
          <p className="text-[14px] font-semibold">No goals yet</p>
          <Button onClick={() => setIsAdding(true)} variant="outline">
            <IconPlus size={15} stroke={2} />
            Add your first goal
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3.5">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={goals.map((g) => g.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col">
                {goals.map((goal, i) => (
                  <GoalItem
                    key={goal.id}
                    goal={goal}
                    index={i}
                    onUpdate={handleUpdate}
                    onDelete={handleDelete}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {/* Add goal inline form */}
          {isAdding && (
            <div className="-mx-3 flex flex-col gap-3 rounded-[14px] bg-foreground/[0.04] p-3 ring-[1.5px] ring-inset ring-primary/40 sm:flex-row sm:items-center">
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="New goal title"
                aria-label="New goal title"
                className="h-[38px] min-w-0 flex-1 text-[14px] md:text-[14px]"
                maxLength={200}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAdd();
                  if (e.key === 'Escape') {
                    setIsAdding(false);
                    setNewTitle('');
                  }
                }}
              />
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setIsAdding(false);
                    setNewTitle('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleAdd}
                  disabled={isSaving || newTitle.trim().length === 0}
                >
                  <IconPlus size={13} stroke={2} />
                  Add goal
                </Button>
              </div>
            </div>
          )}

          {goals.length > 0 && (
            <p className="flex items-start gap-2 text-[12px] leading-relaxed text-label">
              <IconInfoCircle size={14} stroke={1.8} className="mt-px shrink-0 text-[#8A93A6]" aria-hidden />
              Drag a handle to reorder, or focus it, press Space and use the arrow keys. Enter saves an edit, Esc cancels. Delete asks you to click twice.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
