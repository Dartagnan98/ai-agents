// Models an agent can run on (D, 2026-10-09), shaped like lib/agents/models.ts. Ids are provider-qualified
// ('claude-cli:claude-sonnet-5-5'): AI Agents will let an agency connect its AI as a connector (Claude subscription through the claude
// CLI today; ChatGPT or Grok plan sign-in and their own Anthropic / OpenAI / xAI keys later), each with its own runner in lib/ai/runners.
// Client-safe: no server imports. Which providers are connected is decided on the server (availableProviders in lib/ai/agents-server).

export type ModelProvider = 'claude-cli' | 'anthropic-api' | 'openai-api' | 'xai-api' | 'chatgpt-plan' | 'grok-plan';

export const MODEL_PROVIDERS: { id: ModelProvider; label: string }[] = [
  { id: 'claude-cli', label: 'Claude (subscription)' },
  { id: 'anthropic-api', label: 'Claude (API key)' },
  { id: 'openai-api', label: 'OpenAI (API key)' },
  { id: 'xai-api', label: 'Grok (API key)' },
  { id: 'chatgpt-plan', label: 'ChatGPT plan (experimental)' },
  { id: 'grok-plan', label: 'SuperGrok plan (experimental)' },
];

export interface AiModel {
  /** Provider-qualified id, stored on the agent. */
  id: string;
  label: string;
  sub: string;
  provider: ModelProvider;
  /** The id the provider's runner is given (claude --model <wire>, the API's model field). */
  wire: string;
}

const claudeLine = (provider: 'claude-cli' | 'anthropic-api', note: string): AiModel[] => [
  { id: `${provider}:claude-sonnet-5-5`, label: 'Sonnet 5.5', sub: `Fast and capable. The default.${note}`, provider, wire: 'claude-sonnet-5-5' },
  { id: `${provider}:claude-opus-5-5`, label: 'Opus 5.5', sub: `Most capable, for harder questions.${note}`, provider, wire: 'claude-opus-5-5' },
  { id: `${provider}:claude-haiku-5-5`, label: 'Haiku 5.5', sub: `Quickest, for simple lookups.${note}`, provider, wire: 'claude-haiku-5-5' },
];
// OpenAI and xAI ids as CTRL Flow lists them (its lib/agents/models.ts, checked 2026-10-07)
export const AI_MODELS: AiModel[] = [
  ...claudeLine('claude-cli', ''),
  ...claudeLine('anthropic-api', ' API key.'),
  { id: 'openai-api:gpt-6.1-sol', label: 'GPT-6.1 Sol', sub: 'OpenAI. Fast and capable. API key.', provider: 'openai-api', wire: 'gpt-6.1-sol' },
  { id: 'openai-api:gpt-6-astra', label: 'GPT-6 Astra', sub: 'OpenAI flagship. API key.', provider: 'openai-api', wire: 'gpt-6-astra' },
  { id: 'openai-api:gpt-6-luna', label: 'GPT-6 Luna', sub: 'OpenAI. Quickest and cheapest. API key.', provider: 'openai-api', wire: 'gpt-6-luna' },
  { id: 'xai-api:grok-4.7', label: 'Grok 4.7', sub: 'xAI. Most capable Grok. API key.', provider: 'xai-api', wire: 'grok-4.7' },
  { id: 'xai-api:grok-4.3', label: 'Grok 4.3', sub: 'xAI. Faster and cheaper. API key.', provider: 'xai-api', wire: 'grok-4.3' },
  { id: 'xai-api:grok-build-0.1', label: 'Grok Build', sub: 'xAI. Tuned for tool work. API key.', provider: 'xai-api', wire: 'grok-build-0.1' },
];

export const DEFAULT_MODEL = AI_MODELS[0].id;

const pretty = (slug: string) => slug.split('-').map((p, i) => (i === 0 && /^gpt$/i.test(p) ? 'GPT' : /^\d/.test(p) ? p : p[0].toUpperCase() + p.slice(1))).join(' ').replace(/^GPT (\d)/, 'GPT-$1');
/** A plan model id ('chatgpt-plan:gpt-5.6-terra'): the plan's own list decides which exist (Settings shows them). */
export function planModel(id: string): AiModel | null {
  const m = /^(chatgpt-plan|grok-plan):([a-z0-9][a-z0-9._-]{0,63})$/i.exec(id);
  if (!m) return null;
  const provider = m[1].toLowerCase() as 'chatgpt-plan' | 'grok-plan';
  return { id: `${provider}:${m[2]}`, label: pretty(m[2]), sub: provider === 'chatgpt-plan' ? 'Your ChatGPT plan.' : 'Your SuperGrok plan.', provider, wire: m[2] };
}

/** A model by id; an old bare id ('claude-opus-5-5') reads as the claude-cli one. Unknown = null. */
export function findModel(id: string | null | undefined): AiModel | null {
  const raw = String(id ?? '').trim();
  if (!raw) return null;
  const q = raw.includes(':') ? raw : `claude-cli:${raw}`;
  return AI_MODELS.find((m) => m.id === q) ?? planModel(q);
}

/** The model to run: the agent's own, else the default. */
export const modelOrDefault = (id: string | null | undefined): AiModel => findModel(id) ?? findModel(DEFAULT_MODEL)!;

/** The composer's "Auto" (D, 2026-10-09, CTRL Flow's): the agent's own model, moved up to Opus for long, heavy asks. */
export const AUTO_MODEL = { id: 'auto', label: 'Auto', sub: "The agent's model, or Opus for long, heavy asks." };
export function resolveModel(picked: string | null | undefined, agentModel: string | null | undefined, promptChars: number): AiModel {
  if (picked && picked !== 'auto') return findModel(picked) ?? modelOrDefault(agentModel);
  const base = modelOrDefault(agentModel);
  if (base.provider !== 'claude-cli' && base.provider !== 'anthropic-api') return base; // other providers stay on the model picked
  if (base.wire === 'claude-haiku-5-5' || base.wire === 'claude-opus-5-5') return base;
  return promptChars > 12_000 ? findModel(`${base.provider}:claude-opus-5-5`)! : base;
}
/** Context window the conversation is measured against; compaction starts past COMPACT_AT. Current Claude models have 1M (D, 2026-10-23:
 *  "it has 1 mil token"; at 200k a 125k-token chat read 63% full and got compacted). Other providers replay at most 40 turns, so stay well under. */
export const CONTEXT_WINDOW = 1_000_000;
export const COMPACT_AT = 800_000;
