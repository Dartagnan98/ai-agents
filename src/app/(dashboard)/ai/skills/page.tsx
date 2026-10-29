import { SkillsPage } from '@/components/ai/skills-page';

import { redirect } from 'next/navigation';
import { aiUser } from '@/lib/ai/access';

// owner and admins only (managers and clients have the chat itself, D 2026-10-13)
export default async function Page() { if (!(await aiUser())) redirect('/ai'); return <SkillsPage />; }
