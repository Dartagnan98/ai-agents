import { redirect } from 'next/navigation';
import { aiUser } from '@/lib/ai/access';
import { SkillsPage } from '@/components/ai/skills-page';

// one skill's page (D, 2026-10-27), ?file=<path> for one of its files; owner and admins only, like AI › Skills
export default async function Page({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<{ file?: string }> }) {
  if (!(await aiUser())) redirect('/ai');
  const [{ name }, { file }] = await Promise.all([params, searchParams]);
  return <SkillsPage selected={decodeURIComponent(name)} file={file || undefined} />;
}
export const dynamic = 'force-dynamic';
