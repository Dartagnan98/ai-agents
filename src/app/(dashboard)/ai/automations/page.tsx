import { AutomationsPage } from '@/components/ai/automations-page';

import { redirect } from 'next/navigation';
import { aiUser } from '@/lib/ai/access';

// owner and admins only, like Routines
export default async function Page() { if (!(await aiUser())) redirect('/ai'); return <AutomationsPage />; }
