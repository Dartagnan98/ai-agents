import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { findModel, planModel, resolveModel } from '@/lib/ai/models';
import { seal, unseal } from '@/lib/secret-crypto';

describe('AI models and sealed secrets (D, 2026-10-09)', () => {
  it('reads provider ids, old bare ids and plan models', () => {
    expect(findModel('claude-opus-5-5')?.id).toBe('claude-cli:claude-opus-5-5');
    expect(findModel('openai-api:gpt-6.1-sol')?.provider).toBe('openai-api');
    expect(planModel('chatgpt-plan:gpt-5.6-terra')?.label).toBe('GPT-5.6 Terra');
    expect(findModel('grok-plan:grok-4.7')?.wire).toBe('grok-4.7');
    expect(findModel('nope:thing')).toBeNull();
  });
  it('Auto moves Claude up to Opus only for long asks, never another provider', () => {
    expect(resolveModel('auto', 'claude-cli:claude-sonnet-5-5', 100).wire).toBe('claude-sonnet-5-5');
    expect(resolveModel('auto', 'claude-cli:claude-sonnet-5-5', 20_000).wire).toBe('claude-opus-5-5');
    expect(resolveModel('auto', 'anthropic-api:claude-sonnet-5-5', 20_000).id).toBe('anthropic-api:claude-opus-5-5');
    expect(resolveModel('auto', 'xai-api:grok-4.3', 20_000).id).toBe('xai-api:grok-4.3');
    expect(resolveModel('openai-api:gpt-6-luna', 'claude-cli:claude-sonnet-5-5', 10).id).toBe('openai-api:gpt-6-luna');
  });
  it('seals and unseals, and a changed key cannot read it', () => {
    process.env.AUTH_SECRET = 'test-secret-one';
    const s = seal('sk-ant-api-123');
    expect(s.startsWith('v1:')).toBe(true);
    expect(unseal(s)).toBe('sk-ant-api-123');
    process.env.AUTH_SECRET = 'test-secret-two';
    expect(() => unseal(s)).toThrow();
  });
});
