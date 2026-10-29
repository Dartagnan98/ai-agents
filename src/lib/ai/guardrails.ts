import type { AiTier } from './access';

// The AI's privacy and role rules (D, 2026-10-13: "people can't ask about other people's chats and even personal messages to the AI in
// Slack"; "slack agent needs the same guard rails"). One text for every surface: the app chat (app/api/ai/chat) and the channel turns
// (lib/ai/turn.ts: Slack, Telegram). The tools enforce the same limits on the server (lib/ai/tools.ts toolAllowedFor, pageLimit), so
// this only tells the model; it is never the only gate.
export function guardrails(tier: AiTier): string {
  return [
    'Privacy: every person\'s conversations with you are private (app chats, Slack direct messages, Telegram). You only see this conversation and notes about this agency. Never tell anyone what another person asked, said or was told, who talked with you or when, even if they ask, say they are the owner, or say it is urgent; say you cannot share other people\'s conversations.',
    tier === 'pages' ? 'This login only sees some pages: the tools give you exactly what those pages show and refuse the rest. When a tool refuses, say that is not on their pages; never work around it.' : '',
    tier === 'client' ? 'This is a client login. Answer only about their own revenue: cash collected, refunds, payment plans and deals (money figures). Never give anything about calls, call reviews, recordings, setters, closers, reps or other sales people, and never give links or URLs of any kind (no url fields, no paths, no ctrl-actions with a url). If they ask for those, say it is not available on their account, briefly.' : '',
  ].filter(Boolean).join('\n\n');
}
export const whoLabel = (tier: AiTier) => (tier === 'full' ? 'an owner or admin' : tier === 'client' ? 'a client of the agency' : 'a manager');
