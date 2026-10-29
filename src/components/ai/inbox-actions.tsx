'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { clearInboxItem, dropInboxLesson, resolveInboxConflict } from '@/lib/actions/inbox';

// The inbox's buttons (components/ai/inbox-page.tsx): approve or deny an AI approve card (the same POST the chat card uses), and clear
// an update. Deal and rate requests and setter suggestions use their own buttons from components/sales/deal-request.tsx.
const BTN = 'h-9 rounded-xl px-4 text-[12.5px] font-semibold disabled:opacity-60';

export function ApprovalDecide({ id }: { id: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const go = (approve: boolean) => start(async () => {
    const r = await fetch('/api/ai/approvals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, approve }) });
    const j = await r.json().catch(() => ({})) as { error?: string; approval?: { status: string; result: string } };
    if (!r.ok) { setMsg(j.error ?? 'Could not decide it.'); return; }
    setMsg(j.approval?.status === 'failed' ? `It failed: ${j.approval.result}` : approve ? 'Approved and done.' : 'Denied.');
    router.refresh();
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button disabled={pending} onClick={() => go(true)} className={`${BTN} bg-primary text-primary-foreground`}>Approve</button>
      <button disabled={pending} onClick={() => go(false)} className={`${BTN} border border-border`}>Deny</button>
      {msg && <span className="text-[12.5px]">{msg}</span>}
    </div>
  );
}

export function ClearItem({ itemKey }: { itemKey: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button disabled={pending} onClick={() => start(async () => { await clearInboxItem({ key: itemKey }); router.refresh(); })}
      className={`${BTN} border border-border`}>{pending ? 'Clearing…' : 'Clear'}</button>
  );
}

export function LessonDecide({ id, itemKey }: { id: number; itemKey: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button disabled={pending} onClick={() => start(async () => { await clearInboxItem({ key: itemKey }); router.refresh(); })} className={`${BTN} bg-primary text-primary-foreground`}>Keep</button>
      <button disabled={pending} onClick={() => start(async () => { await dropInboxLesson({ id }); router.refresh(); })} className={`${BTN} border border-border`}>Drop</button>
    </div>
  );
}

export function ConflictDecide({ id }: { id: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const go = (keep: 'a' | 'b' | 'both') => start(async () => { await resolveInboxConflict({ id, keep }); router.refresh(); });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button disabled={pending} onClick={() => go('a')} className={`${BTN} bg-primary text-primary-foreground`}>First is right</button>
      <button disabled={pending} onClick={() => go('b')} className={`${BTN} bg-primary text-primary-foreground`}>Second is right</button>
      <button disabled={pending} onClick={() => go('both')} className={`${BTN} border border-border`}>Keep both</button>
    </div>
  );
}
