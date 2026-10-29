import { Suspense } from 'react';
import { AiHome } from '@/components/ai/ai-home';

// AI home: the full-page conversation (?thread=<id>, ?agent=<id> for a new one with that agent).
export default function AiPage() {
  return <Suspense><AiHome /></Suspense>;
}
