import { redirect } from 'next/navigation';
import { aiUser } from '@/lib/ai/access';
import { TasksPage } from '@/components/ai/tasks-page';

// owner and admins only, like Comms
export default async function Page() { if (!(await aiUser())) redirect('/ai'); return <TasksPage />; }
