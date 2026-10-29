import { aiUser, aiDenied } from '@/lib/ai/access';
import { systemJobs } from '@/lib/ai/system-jobs';

export const dynamic = 'force-dynamic';

// Operations › Automations: the box's timers, scheduled jobs (/etc/cron.d) and pm2 services, read only (owner and admins, like Routines).
export async function GET() {
  const me = await aiUser();
  if (!me) return aiDenied();
  return Response.json(await systemJobs());
}
