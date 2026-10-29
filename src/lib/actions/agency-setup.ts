'use server';

import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { savedPassword } from '@/lib/login-user';
import { setInstallValue, setupState, setupTokenOk, usersCount } from '@/lib/agency-setup';

// First run (app/setup): the first login is the owner. Only while the install has no users.
type Ok = { success: true } | { success: false; error: string };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function createOwner(token: string, username: string, password: string): Promise<Ok> {
  try {
    if (setupState() !== 'pending' || usersCount() > 0) return { success: false, error: 'This install already has an owner. Sign in instead.' };
    if (!setupTokenOk(token)) return { success: false, error: 'That setup code is not right (FLEET_SETUP_TOKEN in .env.local).' };
    const u = String(username ?? '').trim();
    if (!/^[A-Za-z0-9._@-]{3,50}$/.test(u)) return { success: false, error: 'Use 3 to 50 letters, digits, dots, dashes, underscores or @ for the username.' };
    const p = String(password ?? '');
    if (p.length < 10) return { success: false, error: 'Use at least 10 characters for the owner password.' };
    if (p.length > 200) return { success: false, error: 'That password is too long.' };
    const hash = await bcrypt.hash(savedPassword(p), 12);
    // one transaction, re-checked inside it: two people pressing at once cannot both become the owner
    const made = db.transaction(() => {
      if ((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0) return false;
      db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(u, hash);
      return true;
    })();
    if (!made) return { success: false, error: 'Someone made the owner a moment ago. Sign in instead.' };
    setInstallValue('owner_created', new Date().toISOString().slice(0, 19) + 'Z', u);
    return { success: true };
  } catch (e) { return { success: false, error: msg(e) }; }
}
