import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// The front door is the AI chat (this app is the AI agents only).
export default function HomePage() { redirect('/ai'); }
