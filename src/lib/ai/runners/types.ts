// What every AI runner takes (D, 2026-10-09). One runner per provider sits next to this file (claude-cli.ts today; plan sign-in and API
// key runners later). The chat route builds the prompt and keeps the conversation; a runner only runs one turn and streams it back.
export interface RunInput {
  /** Appended system prompt (the agents + the agent's instructions + memory + metric guide). */
  system: string;
  /** The user's message as the model gets it (a /skill already expanded). */
  prompt: string;
  /** Pictures and PDFs sent with this message (lib/ai/attachments.ts), base64; text files are already in `prompt`. */
  media?: { kind: 'image' | 'pdf'; name: string; mediaType: string; data: string }[];
  /** Earlier turns, for runners without a session of their own (API keys, plans); the Claude CLI resumes its session instead. */
  history?: { role: 'user' | 'assistant'; text: string }[];
  /** The conversation's session: resume it, or start it with this id. */
  session: { id: string; resume: boolean };
  /** The provider's own model id (AiModel.wire). */
  model: string;
  /** Fleet tool names this turn may call (the agent's allow-list). */
  tools: string[];
  /** The Fleet tool server and this turn's run key. */
  mcp: { url: string; key: string };
  onText: (piece: string) => void;
  onToolStart: (id: string, name: string, input: Record<string, unknown>) => void;
  onToolEnd: (id: string, isError: boolean) => void;
  signal: AbortSignal;
}

/** Tokens one turn used, summed over its model calls (D, 2026-10-12: cost per message). cacheRead/cacheWrite are Anthropic's cache
 *  reads and writes; for OpenAI-style providers cacheRead = cached input tokens and cacheWrite stays 0. `input` excludes cached tokens. */
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
/** Resolves when the turn ends: `error` set when it stopped with one. */
/** `context` = tokens the conversation now fills (input incl. cache), when the provider reports it. */
export type Runner = (input: RunInput) => Promise<{ error?: string; context?: number; usage?: Usage }>;
