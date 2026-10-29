import { redirect } from 'next/navigation';

// The Users sheet lives in Settings › Users (D, 2026-10-02).
export default function UsersPage() {
  redirect('/settings?tab=users');
}
