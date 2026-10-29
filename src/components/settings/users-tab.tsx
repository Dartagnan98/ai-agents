'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { Section } from '@/components/shared/page-kit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createUser, listUsers, removeUser, setUserPassword, setUserRole, type UserRole, type UserRow } from '@/lib/actions/users-admin';

// Settings › Users: every login, its role, a new password, remove. Owners and admins only (the actions check again).
const ROLES: { id: UserRole; label: string; about: string }[] = [
  { id: 'owner', label: 'Owner', about: 'Everything, including other owners' },
  { id: 'admin', label: 'Admin', about: 'Everything except changing owners' },
  { id: 'member', label: 'Member', about: 'Chats with the agents only' },
];
const SEL = 'h-8 rounded-lg border border-border bg-card px-2 text-[13px]';

export function UsersTab() {
  const [users, setUsers] = useState<UserRow[] | null | undefined>(undefined);
  const [error, setError] = useState(''), [pending, start] = useTransition();
  const [name, setName] = useState(''), [pw, setPw] = useState(''), [role, setRole] = useState<UserRole>('member');
  const load = useCallback(() => { listUsers().then(setUsers).catch(() => setUsers(null)); }, []);
  useEffect(() => { load(); }, [load]);
  const run = (fn: () => Promise<{ success: boolean; error?: string }>, after?: () => void) => start(async () => {
    const r = await fn();
    setError(r.success ? '' : r.error ?? 'That did not work.');
    if (r.success) { after?.(); load(); }
  });

  if (users === undefined) return <div className="h-48 animate-pulse rounded-[22px] bg-card" />;
  if (users === null) return <p className="text-[13.5px] text-muted-foreground">Only owners and admins manage users.</p>;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Section title="Add a login" description="They sign in with this name and password, then can change the password under their account.">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); run(() => createUser(name, pw, role), () => { setName(''); setPw(''); }); }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name or email" aria-label="Login name" className="h-8 w-56" />
          <Input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="Password (8+ characters)" aria-label="Password" className="h-8 w-56" />
          <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} aria-label="Role" className={SEL}>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <Button type="submit" size="sm" disabled={pending || name.trim().length < 3 || pw.length < 8}>Add</Button>
        </form>
        <p className="mt-2 text-[12.5px] text-muted-foreground">{ROLES.map((r) => `${r.label}: ${r.about}`).join('. ')}.</p>
      </Section>

      {error && <p role="alert" className="text-[13px] text-weak">{error}</p>}

      <Section title={`Logins (${users.length})`}>
        <ul className="flex flex-col divide-y divide-border/60">
          {users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{u.username}</span>
              <select value={u.role} disabled={pending || u.isOwnerLogin} aria-label={`Role of ${u.username}`} className={SEL}
                onChange={(e) => run(() => setUserRole(u.id, e.target.value as UserRole))}>
                {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => {
                const p = window.prompt(`New password for ${u.username} (8+ characters)`);
                if (p) run(() => setUserPassword(u.id, p));
              }}>Password</Button>
              {!u.isOwnerLogin && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => { if (window.confirm(`Remove ${u.username}? They can no longer sign in.`)) run(() => removeUser(u.id)); }}>Remove</Button>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
