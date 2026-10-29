import 'server-only';
import { db } from '@/lib/db';
import { schemaOnce } from '@/lib/schema-once';
import { askJson, logChange } from './memory-layers';
import { addAgentNote, agentNotes, listAgents, type Agent } from './store';

// Nightly memory cleanup (D, 2026-10-28: "night time clean up routines", memory-tidy). Part of the nightly memory pass
// (memory-nightly.ts), per agent with memory on, over its active notebook notes:
//   1. near copies (most words shared) are retired, the newest kept: no model call;
//   2. notes that say the same thing in different words are merged by the agent's model into one note (the originals retired);
//   3. two notes that disagree are never guessed at: the Inbox asks a person which one is right (table ai_memory_conflicts);
//   4. each agent keeps at most NOTE_CAP active notes: the oldest past it are retired.
// At most one model call per agent a night, only when step 2/3 found candidates. Every change is a memory log row AI › Memory can undo.
const NOTE_CAP = 150, NEAR = 0.85, SIMILAR = 0.45, MAX_PAIRS = 15;

const ready = schemaOnce();
function ensure() {
  if (ready.done()) return;
  db.exec(`CREATE TABLE IF NOT EXISTS ai_memory_conflicts (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, a_id INTEGER NOT NULL, b_id INTEGER NOT NULL,
    a_text TEXT NOT NULL, b_text TEXT NOT NULL, why TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), resolved TEXT NOT NULL DEFAULT '',
    UNIQUE (a_id, b_id));`);
  ready.mark();
}

const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9$%.\s-]/g, ' ').split(/\s+/).map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter((w) => w.length > 2));
/** Shared words over all words of the two (0 to 1). */
export function overlap(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const w of x) if (y.has(w)) n++;
  return n / (x.size + y.size - n);
}
function retire(agentId: number, id: number, content: string, why: string) {
  if (db.prepare("UPDATE ai_memory SET stale = 1 WHERE id = ? AND agent_id = ? AND kind = 'note' AND stale = 0").run(id, agentId).changes)
    logChange({ layer: 'agent_note', targetId: id, agentId, action: 'retire', before: content, by: `tidy: ${why}`.slice(0, 40) });
}

export async function tidyAgent(agent: Agent): Promise<string | null> {
  ensure();
  let notes = agentNotes(agent.id).slice(); // newest first
  let copies = 0, merged = 0, conflicts = 0, capped = 0;
  // 1. near copies: keep the newer one
  const gone = new Set<number>();
  for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) {
    if (gone.has(notes[i].id) || gone.has(notes[j].id)) continue;
    if (overlap(notes[i].content, notes[j].content) >= NEAR) { retire(agent.id, notes[j].id, notes[j].content, 'copy'); gone.add(notes[j].id); copies++; }
  }
  notes = notes.filter((n) => !gone.has(n.id));
  // 2 + 3. similar pairs: one model call merges the ones that agree and names the ones that disagree
  const pairs: [number, number][] = [];
  for (let i = 0; i < notes.length && pairs.length < MAX_PAIRS; i++) for (let j = i + 1; j < notes.length && pairs.length < MAX_PAIRS; j++)
    if (overlap(notes[i].content, notes[j].content) >= SIMILAR) pairs.push([notes[i].id, notes[j].id]);
  if (pairs.length) {
    const byId = new Map(notes.map((n) => [n.id, n.content]));
    const ids = [...new Set(pairs.flat())];
    const out = await askJson<{ merge?: { ids?: number[]; content?: string }[]; conflict?: { ids?: number[]; why?: string }[] }>(
      'You tidy an AI agent\'s notebook. Answer with JSON only.', [
        `These notes from ${agent.name}'s notebook look alike. For each group that says the SAME thing, write one merged note that keeps every fact (merge). For two notes that DISAGREE (different numbers, rules or people for the same thing), name them (conflict) and do not merge them. Leave notes that are only related alone.`,
        'Answer {"merge": [{"ids": [<id>, ...], "content": "<one note>"}], "conflict": [{"ids": [<id>, <id>], "why": "<what differs, short>"}]}. Use only the ids below. No em dashes. Never invent facts.',
        ids.map((id) => `${id}: ${byId.get(id)}`).join('\n'),
      ].join('\n\n'), agent, 3 * 60_000).catch(() => null);
    const live = new Set(ids);
    for (const m of out?.merge ?? []) {
      const group = (m.ids ?? []).map(Number).filter((id) => live.has(id));
      const content = String(m.content ?? '').replace(/—/g, ',').trim().slice(0, 1000);
      if (group.length < 2 || content.length < 12) continue;
      const nid = addAgentNote(agent.id, agent.created_by ?? 0, content, null);
      logChange({ layer: 'agent_note', targetId: nid, agentId: agent.id, action: 'add', after: content, by: 'tidy: merged' });
      for (const id of group) { retire(agent.id, id, byId.get(id) ?? '', 'merged'); live.delete(id); }
      merged++;
    }
    for (const c of out?.conflict ?? []) {
      const [a, b] = (c.ids ?? []).map(Number).sort((x, y) => x - y);
      if (!a || !b || !live.has(a) || !live.has(b)) continue;
      conflicts += db.prepare('INSERT OR IGNORE INTO ai_memory_conflicts (agent_id, a_id, b_id, a_text, b_text, why) VALUES (?, ?, ?, ?, ?, ?)')
        .run(agent.id, a, b, byId.get(a) ?? '', byId.get(b) ?? '', String(c.why ?? '').slice(0, 300)).changes;
    }
  }
  // 4. the cap: the oldest notes past it
  for (const n of agentNotes(agent.id).slice(NOTE_CAP)) { retire(agent.id, n.id, n.content, 'cap'); capped++; }
  const parts = [copies && `${copies} copies`, merged && `${merged} merged`, conflicts && `${conflicts} to check`, capped && `${capped} over the cap`].filter(Boolean);
  return parts.length ? `${agent.name} tidy: ${parts.join(', ')}` : null;
}

export async function tidyPass(): Promise<string | null> {
  const lines: string[] = [];
  for (const a of listAgents().filter((x) => x.use_memory)) {
    const r = await tidyAgent(a).catch((e: unknown) => `${a.name} tidy: ${e instanceof Error ? e.message : String(e)}`);
    if (r) lines.push(r);
  }
  return lines.join(' · ') || null;
}

/** Notes that disagree, still waiting for a person (the Inbox). */
export function openConflicts(): { id: number; agent_id: number; a_id: number; b_id: number; a_text: string; b_text: string; why: string; at: string }[] {
  ensure();
  return db.prepare("SELECT * FROM ai_memory_conflicts WHERE resolved = '' ORDER BY id DESC LIMIT 50").all() as never;
}
/** A person picked: 'a' or 'b' stays (the other is retired), or 'both' stay. */
export function resolveConflict(id: number, keep: 'a' | 'b' | 'both', by: string): boolean {
  ensure();
  const c = db.prepare("SELECT * FROM ai_memory_conflicts WHERE id = ? AND resolved = ''").get(id) as { agent_id: number; a_id: number; b_id: number; a_text: string; b_text: string } | undefined;
  if (!c) return false;
  if (keep === 'a') retire(c.agent_id, c.b_id, c.b_text, `conflict: ${by}`);
  if (keep === 'b') retire(c.agent_id, c.a_id, c.a_text, `conflict: ${by}`);
  db.prepare('UPDATE ai_memory_conflicts SET resolved = ? WHERE id = ?').run(keep, id);
  return true;
}
