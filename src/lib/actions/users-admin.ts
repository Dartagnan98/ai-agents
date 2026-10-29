'use server';

import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { aiAreas } from '@/lib/nav';
import { getGrant, ownerId, requireFullAccess, saveGrant } from '@/lib/user-access';
import { addUser, deleteUser } from '@/lib/actions/settings';
import { savedPassword } from '@/lib/login-user';
import type { AccessGrant } from '@/lib/access';

// Settings › Users: who can sign in and what they can do. Owner: everything. Admin: everything but other owners.
// Member: chats with the agents (their own notes and files only); no settings, agents or routines.
export type UserRole = 'owner' | 'admin' | 'member';
export interface UserRow { id: number; username: string; role: UserRole; created_at: string; isOwnerLogin: boolean }
type Result = { success: true } | { success: false; error: string };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// a member is stored as the access layer's 'manager' with no business pages: chat only (lib/ai/access.ts aiChatUser)
const toGrantRole = (r: UserRole): AccessGrant['role'] => (r === 'member' ? 'manager' : r);
const fromGrantRole = (r: string): UserRole => (r === 'owner' || r === 'admin' ? r : 'member');
const grantFor = (r: UserRole): AccessGrant => ({ role: toGrantRole(r), ai: r === 'admin' ? aiAreas().flatMap((a) => a.tabs.map((t) => t.href)) : [], businesses: {} });

export async function listUsers(): Promise<UserRow[] | null> {
  try { await requireFullAccess(); } catch { return null; }
  const owner = ownerId();
  return (db.prepare('SELECT id, username, created_at FROM users ORDER BY id').all() as { id: number; username: string; created_at: string }[])
    .map((u) => ({ ...u, role: fromGrantRole(getGrant(u.id).role), isOwnerLogin: u.id === owner }));
}

export async function createUser(username: string, password: string, role: UserRole): Promise<Result> {
  try {
    const me = await requireFullAccess();
    if (role === 'owner' && getGrant(me).role !== 'owner') return { success: false, error: 'Only an owner can make an owner.' };
    const r = await addUser(username, password);
    if (!r.success) return { success: false, error: r.error ?? 'Could not add the user.' };
    const row = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim()) as { id: number } | undefined;
    if (!row) return { success: false, error: 'The user was not saved.' };
    saveGrant(row.id, grantFor(role));
    revalidatePath('/settings', 'layout');
    return { success: true };
  } catch (e) { return { success: false, error: msg(e) }; }
}

export async function setUserRole(userId: number, role: UserRole): Promise<Result> {
  try {
    const me = await requireFullAccess();
    if (userId === ownerId()) return { success: false, error: 'The first owner stays an owner.' };
    if ((role === 'owner' || getGrant(userId).role === 'owner') && getGrant(me).role !== 'owner') return { success: false, error: 'Only an owner changes an owner.' };
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return { success: false, error: 'Unknown user.' };
    saveGrant(userId, grantFor(role));
    revalidatePath('/settings', 'layout');
    return { success: true };
  } catch (e) { return { success: false, error: msg(e) }; }
}

export async function removeUser(userId: number): Promise<Result> {
  try {
    const me = await requireFullAccess();
    if (getGrant(userId).role === 'owner' && getGrant(me).role !== 'owner') return { success: false, error: 'Only an owner removes an owner.' };
    const r = await deleteUser(userId);
    return r.success ? { success: true } : { success: false, error: r.error ?? 'Could not remove the user.' };
  } catch (e) { return { success: false, error: msg(e) }; }
}

/** A new password for someone. Only an owner changes an owner's password. Their current session keeps working until it ends. */
export async function setUserPassword(userId: number, password: string): Promise<Result> {
  try {
    const me = await requireFullAccess();
    if (getGrant(userId).role === 'owner' && getGrant(me).role !== 'owner') return { success: false, error: "Only an owner can change an owner's password." };
    if (!password || password.length < 8) return { success: false, error: 'Use at least 8 characters.' };
    if (password.length > 200) return { success: false, error: 'That password is too long.' };
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return { success: false, error: 'User not found.' };
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(savedPassword(password), 12), userId);
    return { success: true };
  } catch (e) { return { success: false, error: msg(e) }; }
}
