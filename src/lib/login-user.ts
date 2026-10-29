import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import type { User } from './types';

// Direction marks and zero-width characters: text copied out of a right-to-left (Arabic) chat often carries them along.
const MARKS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** What a phone keyboard or a copy from a chat may have done to typed text, undone: hidden direction marks and the spaces
 *  around it dropped, Arabic or Persian digits (١٢٣ / ۱۲۳) read as 0-9 (2026-10-02: Sam, signing in from a phone in
 *  Egypt, could not use the admin password that worked from Canada). */
export function plainTyped(typed: string): string {
  return typed.replace(MARKS, '').trim().replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) & 0xf));
}

/** The account for a typed username: an exact match, else the one account whose name matches ignoring case (phones
 *  capitalize the first letter, so "admin" arrived as "Admin" and failed). Two accounts that differ only by case match
 *  exactly or not at all. */
export function findLoginUser(db: Database.Database, typed: string): User | undefined {
  const name = plainTyped(typed);
  const exact = db.prepare('SELECT * FROM users WHERE username = ?').get(name) as User | undefined;
  if (exact) return exact;
  const loose = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').all(name) as User[];
  return loose.length === 1 ? loose[0] : undefined;
}

/** How a password is saved: in small letters, so capitals never stop a sign-in (D, 2026-10-02: "make sure caps doesn't stop
 *  sign in"). Every place that sets a password goes through this. */
export const savedPassword = (password: string) => password.toLowerCase();

const flip = (s: string) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
/** The forms a typed password is tried in, first match wins: as typed, as plainTyped reads it, in small letters (every password
 *  saved since 2026-10-02), and for older passwords saved with capitals the first letter flipped (a phone capitalized it)
 *  or every letter flipped (caps lock). */
export function passwordForms(typed: string): string[] {
  const plain = plainTyped(typed);
  return [...new Set([typed, plain, plain.toLowerCase(), plain && flip(plain[0]) + plain.slice(1), flip(plain)])].filter(Boolean);
}

export async function passwordMatches(typed: string, hash: string): Promise<boolean> {
  for (const form of passwordForms(typed)) if (await bcrypt.compare(form, hash)) return true;
  return false;
}
