import 'server-only';
import { run as runClaudeCli } from './claude-cli';
import { runAnthropicApi, responsesRunner } from './api';
import type { Runner } from './types';

// Every runner by provider (D, 2026-10-09): the chat and routines run through this one list.
export const RUNNERS: Record<string, Runner> = {
  'claude-cli': runClaudeCli, 'anthropic-api': runAnthropicApi,
  'openai-api': responsesRunner('openai-api'), 'xai-api': responsesRunner('xai-api'),
  'chatgpt-plan': responsesRunner('chatgpt-plan'), 'grok-plan': responsesRunner('grok-plan'),
};
