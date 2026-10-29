// A chat whose Claude session file was never written (compaction, a cut-off run) starts fresh instead of "No conversation found" (D, 2026-10-23).
import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: () => [] }));
vi.mock('@/lib/ai/claude-env', () => ({ claudeEnv: () => null }));
vi.mock('@/lib/ai/claude-login-alert', () => ({ noteClaudeFailure: () => {} }));
vi.mock('@/lib/ai/catalog', () => ({ allowedToolsArg: () => [] }));
const { sessionFile } = await import('../runners/claude-cli');

describe('session file', () => {
  it('is in the projects folder named after the working folder', () => {
    expect(sessionFile('abc', '/root')).toMatch(/^\/root\/\.claude\/projects\/-[^/]*fleet-ai\/abc\.jsonl$/);
  });
});
