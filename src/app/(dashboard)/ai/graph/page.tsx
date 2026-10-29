import { MemoryMap } from '@/components/ai/memory-graph';

import { redirect } from 'next/navigation';
import { aiUser } from '@/lib/ai/access';

// owner and admins only, like Memory
export default async function Page() { if (!(await aiUser())) redirect('/ai'); return <MemoryMap />; }
