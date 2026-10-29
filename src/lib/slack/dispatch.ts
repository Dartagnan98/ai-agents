import 'server-only';
import { handleEvent, type EventEnvelope } from './events';
import { runSoonForChannel } from '@/lib/ai/routines';

// The Events route's background half: real dependencies for handleEvent.
async function aiTurn(input: { userId: number; threadId: number | null; text: string }) {
  const { runTurn } = await import('@/lib/ai/turn');
  return runTurn({ ...input, agentId: null, channel: 'Slack', title: `Slack: ${input.text.slice(0, 60)}` });
}

/** Fire and forget: the route has already answered Slack. */
export function dispatchSlackEvent(env: Record<string, unknown>): void {
  void handleEvent(env as EventEnvelope, { aiTurn, channelPost: (c) => { runSoonForChannel(c, 20_000); } })
    .catch((e) => console.warn(`[slack] event: ${String((e as Error)?.message ?? e)}`));
}
