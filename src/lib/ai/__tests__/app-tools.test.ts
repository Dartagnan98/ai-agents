import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/connectors/composio', () => ({ composioConnections: async () => ({}), composioExecute: async () => ({ data: {} }) }));
import { appOfTool, isReadTool } from '@/lib/ai/app-tools';
import { agentTools } from '@/lib/ai/catalog';

describe('connected apps for agents (D, 2026-10-09)', () => {
  it('reads run at once, sends and changes do not', () => {
    expect(isReadTool('SLACK_FIND_CHANNELS')).toBe(true);
    expect(isReadTool('GMAIL_LIST_THREADS')).toBe(true);
    expect(isReadTool('SLACK_SEND_MESSAGE')).toBe(false);
    expect(isReadTool('GOOGLESHEETS_BATCH_UPDATE')).toBe(false);
  });
  it('a tool must belong to one of the agent apps', () => {
    expect(appOfTool('SLACK_SEND_MESSAGE', ['slack', 'gmail'])).toBe('slack');
    expect(appOfTool('GITHUB_CREATE_ISSUE', ['slack'])).toBeNull();
  });
  it('app tools only for agents with apps', () => {
    expect(agentTools({ tools: [], use_memory: true, apps: [] })).not.toContain('app_run');
    expect(agentTools({ tools: [], use_memory: true, apps: ['slack'] })).toContain('app_run');
  });
});
