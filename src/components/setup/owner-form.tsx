'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createOwner } from '@/lib/actions/agency-setup';

// Step 1 of a new install (app/setup/page.tsx): the owner login. Then the normal sign-in page, which comes back to the setup.
export function OwnerForm({ needsToken }: { needsToken: boolean }) {
  const [d, setD] = useState({ token: '', username: '', password: '', again: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const put = (x: Partial<typeof d>) => setD((o) => ({ ...o, ...x }));
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (d.password !== d.again) { setError('The two passwords are not the same.'); return; }
    setBusy(true); setError('');
    const r = await createOwner(d.token, d.username, d.password).catch((err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (!r.success) { setBusy(false); setError(r.error); return; }
    window.location.href = '/login?callbackUrl=%2Fsetup&made=owner';
  }
  const L = 'text-[12.5px] font-semibold text-muted-foreground';
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {needsToken && (
        <label className="flex flex-col gap-1.5"><span className={L}>Setup code</span>
          <Input value={d.token} onChange={(e) => put({ token: e.target.value })} autoComplete="off" className="font-mono" required />
          <span className="text-[11.5px] text-label">Printed at the end of the install, and saved on the server as FLEET_SETUP_TOKEN in the env file.</span></label>
      )}
      <label className="flex flex-col gap-1.5"><span className={L}>Owner username</span><Input value={d.username} onChange={(e) => put({ username: e.target.value })} autoComplete="username" required minLength={3} maxLength={50} /></label>
      <label className="flex flex-col gap-1.5"><span className={L}>Password</span><Input type="password" value={d.password} onChange={(e) => put({ password: e.target.value })} autoComplete="new-password" required minLength={10} /><span className="text-[11.5px] text-label">At least 10 characters.</span></label>
      <label className="flex flex-col gap-1.5"><span className={L}>Password again</span><Input type="password" value={d.again} onChange={(e) => put({ again: e.target.value })} autoComplete="new-password" required /></label>
      {error && <p role="alert" className="text-[12.5px] font-semibold text-weak">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? 'Making the owner' : 'Make the owner'}</Button>
    </form>
  );
}
