'use server';

import { revalidatePath } from 'next/cache';
import { aiUser } from '@/lib/ai/access';
import { markDone } from '@/lib/ai/inbox';
import { dropLesson } from '@/lib/ai/lessons';
import { resolveConflict } from '@/lib/ai/memory-tidy';

/** Clear one update from the signed-in owner's or admin's inbox (lib/ai/inbox.ts). */
export async function clearInboxItem(input: { key: string }): Promise<{ ok: boolean }> {
  const me = await aiUser();
  const key = String(input.key ?? '');
  if (!me || !/^[a-z]+:[A-Za-z0-9_:.-]{1,160}$/.test(key)) return { ok: false };
  markDone(me.uid, key);
  revalidatePath('/ai/inbox');
  return { ok: true };
}

/** Drop a lesson an agent wrote (lib/ai/lessons.ts): it stops following it; the Memory page's history can undo it. */
export async function dropInboxLesson(input: { id: number }): Promise<{ ok: boolean }> {
  const me = await aiUser();
  if (!me) return { ok: false };
  const ok = dropLesson(Number(input.id), `person ${me.uid}`);
  markDone(me.uid, `lesson:${Number(input.id)}`);
  revalidatePath('/ai/inbox');
  return { ok };
}

/** Two notes disagree (lib/ai/memory-tidy.ts): keep the first, the second, or both. */
export async function resolveInboxConflict(input: { id: number; keep: 'a' | 'b' | 'both' }): Promise<{ ok: boolean }> {
  const me = await aiUser();
  if (!me || !['a', 'b', 'both'].includes(input.keep)) return { ok: false };
  const ok = resolveConflict(Number(input.id), input.keep, `person ${me.uid}`);
  revalidatePath('/ai/inbox');
  return { ok };
}
