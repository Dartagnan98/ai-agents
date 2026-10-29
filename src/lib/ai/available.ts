import 'server-only';
import { AI_MODELS, MODEL_PROVIDERS, planModel, type AiModel, type ModelProvider } from '@/lib/ai/models';
import { listConnections } from '@/lib/ai/connections';
import { claudeCliAvailable } from '@/lib/ai/runners/claude-cli';

// What can run here right now (D, 2026-10-09: AI connections): the providers connected in Settings › AI connections (or the box's
// Claude login) and their models. The agent editor and the composer's model picker list only these.
export function availableProviders(): ModelProvider[] {
  const c = Object.fromEntries(listConnections().map((x) => [x.kind, x.connected && x.status !== 'error']));
  return MODEL_PROVIDERS.map((p) => p.id).filter((id) =>
    id === 'claude-cli' ? claudeCliAvailable() : id === 'anthropic-api' ? c['anthropic-key'] : id === 'openai-api' ? c['openai-key']
      : id === 'xai-api' ? c['xai-key'] : c[id]);
}
export function availableModels(): AiModel[] {
  const on = new Set(availableProviders());
  const plans = listConnections().filter((x) => (x.kind === 'chatgpt-plan' || x.kind === 'grok-plan') && on.has(x.kind))
    .flatMap((x) => x.models.map((m) => planModel(`${x.kind}:${m}`)).filter((m): m is AiModel => !!m));
  return [...AI_MODELS.filter((m) => on.has(m.provider)), ...plans];
}
