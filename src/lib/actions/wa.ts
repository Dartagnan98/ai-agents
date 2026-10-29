'use server';

import QRCode from 'qrcode';
import { auth } from '@/lib/auth';
import { getGrant, sessionUserId } from '@/lib/user-access';
import { listAgents } from '@/lib/ai/store';
import { addNumber, getNumber, listNumbers, numberStatus, removeNumber, updateNumber, type WaNumber } from '@/lib/wa/numbers';

// Settings › AI connections › WhatsApp (D, 2026-10-28): add a number (its agent, admins, groups), show the QR to link it, change it,
// remove it. Owners and admins only: a linked number lets its admins work the agent with the login that added it.
type Ok<T = object> = ({ success: true } & T) | { success: false; error: string };
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
async function me(): Promise<number> {
  const uid = sessionUserId(await auth());
  if (!uid) throw new Error('Sign in first.');
  const role = getGrant(uid).role;
  if (role !== 'owner' && role !== 'admin') throw new Error('Only an owner or admin can set up WhatsApp numbers.');
  return uid;
}

export interface WaView { numbers: (WaNumber & { agent: string; running: boolean; connected: boolean; qrSvg: string | null; log: string })[]; agents: { id: number; name: string }[] }
export async function loadWa(): Promise<Ok<{ view: WaView }>> {
  try {
    const uid = await me();
    const agents = listAgents(uid).map((a) => ({ id: a.id, name: a.name }));
    const numbers = await Promise.all(listNumbers().map(async (n) => {
      const s = await numberStatus(n.key);
      // the QR is a sign-in credential for the number: drawn here, shown only to an owner or admin, never stored by the page
      const qrSvg = s.qr ? await QRCode.toString(s.qr, { type: 'svg', margin: 1, width: 240 }) : null;
      return { ...n, agent: agents.find((a) => a.id === n.agent_id)?.name ?? 'missing agent', running: s.running, connected: s.connected, qrSvg, log: s.log };
    }));
    return { success: true, view: { numbers, agents } };
  } catch (e) { return { success: false, error: msg(e) }; }
}
const lines = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
/** admins: one per line, "17785551234 Sam Lee, the owner" (number first, then who it is). */
function parseAdmins(text: string): Record<string, string> {
  return Object.fromEntries(text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const m = l.match(/^\+?([0-9 ()-]{8,20})\s+(.+)$/); return m ? [m[1], m[2]] : [l, '']; }));
}
export async function addWa(f: { label: string; agentId: number; admins: string; groups: string; ambient: string }): Promise<Ok<{ key: string }>> {
  try {
    const uid = await me();
    if (!listAgents(uid).some((a) => a.id === Number(f.agentId))) throw new Error('Pick one of your agents.');
    const n = addNumber({ label: f.label, agentId: Number(f.agentId), admins: parseAdmins(f.admins), groups: lines(f.groups), ambient: lines(f.ambient), by: uid });
    return { success: true, key: n.key };
  } catch (e) { return { success: false, error: msg(e) }; }
}
export async function editWa(key: string, f: { label?: string; agentId?: number; admins?: string; groups?: string; ambient?: string; mode?: string }): Promise<Ok> {
  try {
    const uid = await me();
    if (!getNumber(key)) throw new Error('No such number.');
    if (f.agentId && !listAgents(uid).some((a) => a.id === Number(f.agentId))) throw new Error('Pick one of your agents.');
    updateNumber(key, { label: f.label, agentId: f.agentId ? Number(f.agentId) : undefined, admins: f.admins !== undefined ? parseAdmins(f.admins) : undefined,
      groups: f.groups !== undefined ? lines(f.groups) : undefined, ambient: f.ambient !== undefined ? lines(f.ambient) : undefined, mode: f.mode });
    return { success: true };
  } catch (e) { return { success: false, error: msg(e) }; }
}
export async function removeWa(key: string): Promise<Ok> {
  try { await me(); removeNumber(key); return { success: true }; } catch (e) { return { success: false, error: msg(e) }; }
}
