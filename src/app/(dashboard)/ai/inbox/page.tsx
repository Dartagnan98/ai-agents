import { redirect } from 'next/navigation';
import { aiUser } from '@/lib/ai/access';
import { inboxFor, markRead } from '@/lib/ai/inbox';
import { InboxPage } from '@/components/ai/inbox-page';
import { viewingAs } from '@/lib/user-access';

// The notification centre (D, 2026-10-28): owner and admins. ?item=<key> opens one; opening it marks it read.
export default async function Page({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const me = await aiUser();
  if (!me) redirect('/ai');
  const sp = await searchParams;
  const items = await inboxFor(me.uid);
  const show = sp.show === 'all' ? 'all' : 'needs';
  const list = show === 'all' ? items : items.filter((x) => x.needsYou);
  const want = typeof sp.item === 'string' ? sp.item : '';
  const open = list.find((x) => x.key === want) ?? (want ? items.find((x) => x.key === want) : undefined) ?? list[0] ?? null;
  if (open && !open.read && !(await viewingAs())) markRead(me.uid, open.key); // View as is read-only
  return <InboxPage items={list} counts={{ needs: items.filter((x) => x.needsYou).length, all: items.length }} show={show} open={open} picked={!!want} />;
}
