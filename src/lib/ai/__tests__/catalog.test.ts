import { describe, expect, it } from 'vitest';
import { agentTools, allowedToolsArg, expandSkill, filterTools, TOOL_NAMES, WRITE_TOOLS } from '../catalog';

describe('agent tool allow-list', () => {
  it('an empty list means every tool; memory tools only with memory on', () => {
    // app tools come only with connected apps; change tools (propose_*) are part of "every tool" and always ask first
    expect(agentTools({ tools: [], use_memory: 1, apps: ['slack'] })).toEqual(TOOL_NAMES.filter((n) => !WRITE_TOOLS.includes(n))); // write tools only when listed
    expect(agentTools({ tools: ['ledger_save', 'metrics'], use_memory: 0 })).toEqual(['memory_graph', 'read_file', 'search_file', 'list_secrets', 'save_key', 'http_request', 'send_file', 'create_task', 'list_tasks', 'update_task', 'list_goals', 'set_goal', 'read_goals', 'list_skills', 'read_skill', 'agents_list', 'ask_agent', 'message_agent', 'hand_off', 'inbox', 'propose_strategy']); // skills, the team and the Strategy page always (2026-10-23, 2026-10-28)
    expect(agentTools({ tools: null, use_memory: 0 })).toEqual(['slack_read', 'memory_graph', 'search_memory', 'read_file', 'search_file', 'workspace_run', 'workspace_read', 'workspace_write', 'workspace_edit', 'workspace_search', 'slack_history', 'ai_json', 'publish_page', 'publish_image', 'list_secrets', 'save_key', 'http_request', 'send_file', 'create_task', 'list_tasks', 'update_task', 'list_goals', 'set_goal', 'slack_people', 'search_knowledge', 'read_goals', 'propose_skill', 'list_skills', 'read_skill', 'agents_list', 'ask_agent', 'message_agent', 'hand_off', 'list_routines', 'inbox', 'save_routine', 'run_routine', 'propose_strategy', 'propose_slack_post']);
  });
  it('keeps only picked, known tools, in catalog order', () => {
    expect(agentTools({ tools: ['remember', 'metrics', 'shell'], use_memory: true })).toEqual(['memory_graph', 'read_file', 'search_file', 'list_secrets', 'save_key', 'http_request', 'send_file', 'create_task', 'list_tasks', 'update_task', 'list_goals', 'set_goal', 'read_goals', 'remember', 'note_for_agent', 'forget_agent_note', 'core_memory_append', 'core_memory_replace', 'list_skills', 'read_skill', 'agents_list', 'ask_agent', 'message_agent', 'hand_off', 'inbox', 'propose_strategy']); // the notebook comes with memory, the metric guide always (2026-10-12)
    expect(agentTools({ tools: ['remember', 'metrics'], use_memory: false })).toEqual(['memory_graph', 'read_file', 'search_file', 'list_secrets', 'save_key', 'http_request', 'send_file', 'create_task', 'list_tasks', 'update_task', 'list_goals', 'set_goal', 'read_goals', 'list_skills', 'read_skill', 'agents_list', 'ask_agent', 'message_agent', 'hand_off', 'inbox', 'propose_strategy']);
  });
  it('builds the claude allow-list and filters the MCP tools list', () => {
    expect(allowedToolsArg(['metrics', 'recall_memory'])).toEqual(['mcp__fleet__metrics', 'mcp__fleet__recall_memory']);
    const list = [{ name: 'metrics' }, { name: 'contract_settings' }, { name: 'remember' }];
    expect(filterTools(list, ['metrics', 'remember']).map((t) => t.name)).toEqual(['metrics', 'remember']);
    expect(filterTools(list, [])).toEqual([]);
  });
});

describe('skill expansion', () => {
  const skills = [{ name: 'weekly-recap', body: 'Pull last week for every contract.' }];
  it('expands a known /slug with the rest of the message', () => {
    const out = expandSkill('/weekly-recap only ACME', skills);
    expect(out.skill).toBe('weekly-recap');
    expect(out.prompt).toContain('Pull last week for every contract.');
    expect(out.prompt.endsWith('only ACME')).toBe(true);
  });
  it('runs the skill alone when nothing follows', () => {
    expect(expandSkill('/Weekly-Recap', skills).prompt).toContain('Run the skill now.');
  });
  it('leaves plain text and unknown slugs alone', () => {
    expect(expandSkill('how did ACME do?', skills)).toEqual({ prompt: 'how did ACME do?', skill: null });
    expect(expandSkill('/nope hi', skills)).toEqual({ prompt: '/nope hi', skill: null });
  });
});
