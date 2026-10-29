import 'server-only';
import { auth } from '@/lib/auth';
import { sessionUserId, getGrant } from '@/lib/user-access';

// Who may use the AI (D, 2026-10-09): the owner and admins only (it sees money and commissions). Every AI route and page asks this.
export async function aiUser() {
  const session = await auth();
  const uid = sessionUserId(session);
  if (!uid) return null;
  const role = getGrant(uid).role;
  return role === 'owner' || role === 'admin' ? { uid, session, role } : null;
}

export const aiDenied = () => Response.json({ error: 'Owner or admin only' }, { status: 403 });

/** How much a login's AI may see (D, 2026-10-13): owner and admins everything; managers what their own pages show; clients their money
 *  figures only (no calls, no sales people, no links). lib/ai/tools.ts applies it to every tool; the chat route to the prompt. */
export type AiTier = 'full' | 'pages' | 'client';
export const aiTierOf = (role: string): AiTier => (role === 'owner' || role === 'admin' ? 'full' : role === 'client' ? 'client' : 'pages');

/** Who may chat: the owner, admins, managers and clients (reps do not get the AI). Agents, routines, skills and connections stay aiUser. */
export async function aiChatUser() {
  const session = await auth();
  const uid = sessionUserId(session);
  if (!uid) return null;
  const role = getGrant(uid).role;
  if (role !== 'owner' && role !== 'admin' && role !== 'manager' && role !== 'client') return null;
  return { uid, session, role, tier: aiTierOf(role) };
}
