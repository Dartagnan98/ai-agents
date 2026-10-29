import 'server-only';
import { db } from '@/lib/db';
import { askJson, logChange } from './memory-layers';
import { getAgent, threadAgentId, threadHistory } from './store';

// Corrections become lessons (D, 2026-10-28: "beef the memory up, like the auto correction and lessons", memory v3 item 4).
// When a person corrects an agent, the agent writes one short rule for next time, used at once:
//   - a denied approval card (lib/ai/approvals.ts decide), with the change it asked for;
//   - a chat message that corrects the agent's last answer or how it worked (the after-turn learning pass, memory-layers.ts).
// A lesson is an agent note of kind 'lesson' (ai_memory): every prompt of that agent carries its active lessons (store.ts notebookPrompt),
// it shows in the Inbox, and dropping it (stale = 1) or Undo on its history row stops it.
export const LESSON_MAX = 40; // active lessons an agent carries; the oldest leave first

export function agentLessons(agentId: number): { id: number; content: string; created_at: string }[] {
  return db.prepare("SELECT id, content, created_at FROM ai_memory WHERE agent_id = ? AND kind = 'lesson' AND stale = 0 ORDER BY id DESC LIMIT ?").all(agentId, LESSON_MAX) as never;
}
/** Lessons of the last `days` (the Inbox), with their agent. */
export function recentLessons(days = 7): { id: number; agent_id: number; content: string; created_at: string; thread_id: number | null; stale: number }[] {
  return db.prepare(`SELECT id, agent_id, content, created_at, thread_id, stale FROM ai_memory WHERE kind = 'lesson' AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) ORDER BY id DESC LIMIT 100`)
    .all(`-${days} days`) as never;
}
export function dropLesson(id: number, by: string): boolean {
  const r = db.prepare("SELECT agent_id, content FROM ai_memory WHERE id = ? AND kind = 'lesson'").get(id) as { agent_id: number; content: string } | undefined;
  if (!r || db.prepare("UPDATE ai_memory SET stale = 1 WHERE id = ? AND kind = 'lesson'").run(id).changes === 0) return false;
  logChange({ layer: 'agent_note', targetId: id, agentId: r.agent_id, action: 'retire', before: r.content, by });
  return true;
}

/** Saves one lesson for the agent (skips one it already has, word for word). Returns its id or null. */
export function addLesson(agentId: number, userId: number, text: string, threadId: number | null, how: string): number | null {
  const content = text.replace(/—/g, ',').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (content.length < 12) return null;
  if (db.prepare("SELECT 1 FROM ai_memory WHERE agent_id = ? AND kind = 'lesson' AND stale = 0 AND lower(content) = lower(?)").get(agentId, content)) return null;
  const id = Number(db.prepare("INSERT INTO ai_memory (user_id, content, thread_id, agent_id, kind, day) VALUES (?, ?, ?, ?, 'lesson', '')").run(userId, content, threadId, agentId).lastInsertRowid);
  logChange({ layer: 'agent_note', targetId: id, agentId, userId, action: 'add', after: content, by: `correction (${how})`, threadId });
  // the oldest lessons past the cap stop being carried (kept, flagged stale)
  db.prepare(`UPDATE ai_memory SET stale = 1 WHERE agent_id = ? AND kind = 'lesson' AND stale = 0 AND id NOT IN
    (SELECT id FROM ai_memory WHERE agent_id = ? AND kind = 'lesson' AND stale = 0 ORDER BY id DESC LIMIT ?)`).run(agentId, agentId, LESSON_MAX);
  console.log(`[memory] lesson for agent ${agentId} (${how}): ${content.slice(0, 120)}`);
  return id;
}

/** A person turned down an agent's change: one rule for next time, from what it asked and the conversation around it. Never throws. */
export async function lessonFromDenial(a: { threadId: number; userId: number; tool: string; summary: string }): Promise<void> {
  try {
    const agent = getAgent(threadAgentId(a.threadId));
    if (!agent?.use_memory) return;
    const recent = threadHistory(a.threadId, 6).map((m) => `${m.role === 'user' ? 'Person' : agent.name}: ${m.text.slice(0, 1200)}`).join('\n\n');
    const out = await askJson<{ lesson?: string }>('You turn a correction into one rule an AI agent follows from now on. Answer with JSON only.', [
      `${agent.name} asked to make a change and the person said no. Write ONE short rule (one sentence, at most 30 words) so ${agent.name} does better next time, or {"lesson": ""} when the no says nothing lasting (a one-off, or the person just changed their mind).`,
      'Say what to do, not what happened. No names of tools. No em dashes. Answer {"lesson": "..."}.',
      `=== The change it asked for (${a.tool.replace(/^propose_/, '')}) ===\n${a.summary}`,
      `=== The conversation before it ===\n${recent || '(none)'}`,
    ].join('\n\n'), agent, 2 * 60_000);
    if (out?.lesson) addLesson(agent.id, a.userId, out.lesson, a.threadId, 'denied change');
  } catch (e) { console.warn(`[memory] lesson from denial: ${e instanceof Error ? e.message : String(e)}`); }
}
