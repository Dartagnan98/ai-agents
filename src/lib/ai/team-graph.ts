import 'server-only';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { agencyIdNow } from '@/lib/slack/app';

// Team memory's graph: every memory piece is linked to the people (logins) and agents it names, by name: free, instant, the same every
// time. A question that names one pulls that entity's pieces into recall (team-memory.ts), and each person gets a profile (below).
// Matching: a full name anywhere (case-insensitive, whole words); a first name alone only when nobody else shares it and it has 5+ letters.
export interface Entity { id: number; kind: 'person' | 'agent'; name: string; key: string }
type Matcher = Entity & { re: RegExp };

let ready = false;
export function ensureGraph() {
  if (ready) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_mem_entities (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL, key TEXT NOT NULL DEFAULT '',
      patterns TEXT NOT NULL DEFAULT '[]', UNIQUE (kind, key));
    CREATE TABLE IF NOT EXISTS ai_mem_links (chunk_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, PRIMARY KEY (chunk_id, entity_id));
    CREATE INDEX IF NOT EXISTS idx_ai_mem_links_entity ON ai_mem_links (entity_id);
    CREATE TABLE IF NOT EXISTS ai_mem_profiles (entity_id INTEGER PRIMARY KEY, body TEXT NOT NULL, sources TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
    CREATE TABLE IF NOT EXISTS ai_mem_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, rel TEXT NOT NULL, to_id INTEGER NOT NULL,
      chunk_id INTEGER, day TEXT NOT NULL DEFAULT '', seen INTEGER NOT NULL DEFAULT 1, UNIQUE (from_id, rel, to_id));
    CREATE INDEX IF NOT EXISTS idx_ai_mem_edges_to ON ai_mem_edges (to_id);
    CREATE TABLE IF NOT EXISTS ai_mem_rel_read (chunk_id INTEGER PRIMARY KEY, hash TEXT NOT NULL)`);
  ready = true;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (s: string) => s.replace(/[.\-']/g, ' ').trim().split(/\s+/).filter(Boolean);

/** The entities: the team (every login) and the agents, with the patterns that find them by name. Exported for tests. */
export function entityDefs(): { kind: 'person' | 'agent'; key: string; name: string; patterns: string[] }[] {
  const people = (db.prepare('SELECT id, username FROM users').all() as { id: number; username: string }[])
    .map((u) => ({ key: `u${u.id}`, name: u.username.includes('@') ? u.username.split('@')[0].replace(/[._]+/g, ' ') : u.username })).filter((p) => p.name.trim());
  let agents: { id: number; name: string }[] = [];
  try { agents = (db.prepare('SELECT id, name FROM ai_agents').all() as { id: number; name: string }[]).filter((a) => a.name.trim()); } catch { /* no agents yet */ }
  const firsts = new Map<string, number>();
  for (const p of people) { const f = words(p.name)[0]?.toLowerCase(); if (f) firsts.set(f, (firsts.get(f) ?? 0) + 1); }
  const pats = (name: string, firstAlone: boolean) => {
    const w = words(name), out = [`(?<![\\w])${w.map(esc).join('[\\s.\\-]+')}(?![\\w])`];
    // a first name alone: 5+ letters and nobody else shares it
    if (firstAlone && w.length > 1 && w[0].length >= 5 && firsts.get(w[0].toLowerCase()) === 1) out.push(`(?<![\\w])${esc(w[0])}(?![\\w])`);
    return w.length === 1 && w[0].length < 4 ? [] : out; // a lone short name would match too much
  };
  return [
    ...people.map((p) => ({ kind: 'person' as const, key: p.key, name: p.name, patterns: pats(p.name, true) })),
    ...agents.map((a) => ({ kind: 'agent' as const, key: `a${a.id}`, name: a.name, patterns: pats(a.name, false) })),
  ].filter((e) => e.patterns.length);
}

let cache: { sig: string; list: Matcher[] } | null = null;
/** Syncs the entity table with the logins and agents. Returns true when the set changed (links must be rebuilt). */
export function refreshEntities(): boolean {
  ensureGraph();
  const defs = entityDefs(), sig = crypto.createHash('sha1').update(JSON.stringify(defs)).digest('hex');
  const prev = (db.prepare("SELECT value FROM ai_mem_state WHERE key = 'entities_sig'").get() as { value: string } | undefined)?.value ?? '';
  if (prev === sig) return false;
  const keep = new Set<number>();
  for (const d of defs) {
    db.prepare(`INSERT INTO ai_mem_entities (kind, name, key, patterns) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET name = excluded.name, patterns = excluded.patterns`).run(d.kind, d.name, d.key, JSON.stringify(d.patterns));
    keep.add((db.prepare('SELECT id FROM ai_mem_entities WHERE kind = ? AND key = ?').get(d.kind, d.key) as { id: number }).id);
  }
  for (const e of db.prepare('SELECT id FROM ai_mem_entities').all() as { id: number }[]) if (!keep.has(e.id)) {
    db.prepare('DELETE FROM ai_mem_entities WHERE id = ?').run(e.id); db.prepare('DELETE FROM ai_mem_links WHERE entity_id = ?').run(e.id); db.prepare('DELETE FROM ai_mem_profiles WHERE entity_id = ?').run(e.id);
  }
  db.prepare("INSERT INTO ai_mem_state (key, value) VALUES ('entities_sig', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(sig);
  cache = null;
  return true;
}

function matchers(): Matcher[] {
  ensureGraph();
  const rows = db.prepare('SELECT id, kind, name, key, patterns FROM ai_mem_entities').all() as (Entity & { patterns: string })[];
  const sig = rows.map((r) => `${r.id}:${r.patterns}`).join('|');
  if (cache?.sig === sig) return cache.list;
  const list: Matcher[] = [];
  for (const r of rows) {
    const pats = JSON.parse(r.patterns) as string[];
    if (!pats.length) continue;
    // (?-i:...) marks a case-sensitive part (contract keys): JS has no inline flags, so those patterns compile on their own
    const sensitive = pats.filter((p) => p.startsWith('(?-i:')).map((p) => p.slice(5, -1)), loose = pats.filter((p) => !p.startsWith('(?-i:'));
    const parts = [...(loose.length ? [`(?:${loose.join('|')})`] : [])];
    try {
      list.push({ id: r.id, kind: r.kind, name: r.name, key: r.key, re: new RegExp(parts.join('|') || '(?!)', 'i') });
      if (sensitive.length) list.push({ id: r.id, kind: r.kind, name: r.name, key: r.key, re: new RegExp(sensitive.join('|')) });
    } catch { /* a name that makes a bad pattern: skipped */ }
  }
  cache = { sig, list };
  return list;
}

/** The entities a text names (ids, unique). */
export function entitiesIn(text: string): Entity[] {
  const seen = new Map<number, Entity>();
  for (const m of matchers()) if (!seen.has(m.id) && m.re.test(text)) seen.set(m.id, { id: m.id, kind: m.kind, name: m.name, key: m.key });
  return [...seen.values()];
}

/** Links one piece to the entities it names (replaces its links). */
export function linkChunk(chunkId: number, text: string) {
  ensureGraph();
  db.prepare('DELETE FROM ai_mem_links WHERE chunk_id = ?').run(chunkId);
  for (const e of entitiesIn(text)) db.prepare('INSERT OR IGNORE INTO ai_mem_links (chunk_id, entity_id) VALUES (?, ?)').run(chunkId, e.id);
}

/** Every piece's links again (after the logins or agents changed). */
export function relinkAll(): number {
  ensureGraph();
  const rows = db.prepare('SELECT id, title, body FROM ai_mem_chunks').all() as { id: number; title: string; body: string }[];
  db.exec('DELETE FROM ai_mem_links');
  const tx = db.transaction(() => { for (const r of rows) linkChunk(r.id, `${r.title}\n${r.body}`); });
  tx();
  return rows.length;
}

/** The newest pieces linked to these entities (by date, then id). */
export function linkedChunks(entityIds: number[], limit = 20): number[] {
  if (!entityIds.length) return [];
  ensureGraph();
  return (db.prepare(`SELECT c.id FROM ai_mem_links l JOIN ai_mem_chunks c ON c.id = l.chunk_id WHERE l.entity_id IN (${entityIds.map(() => '?').join(',')})
    GROUP BY c.id ORDER BY count(*) DESC, c.at DESC, c.id DESC LIMIT ?`).all(...entityIds, limit) as { id: number }[]).map((r) => r.id);
}

/** For the Memory page: each entity, how many pieces name it, and whether it has a profile. */
export function entityStats(): { id: number; kind: string; name: string; pieces: number; profile: string | null; profiled: string | null; edges: Edge[] }[] {
  ensureGraph();
  return (db.prepare(`SELECT e.id, e.kind, e.name, count(l.chunk_id) pieces, p.body profile, p.updated_at profiled FROM ai_mem_entities e
    LEFT JOIN ai_mem_links l ON l.entity_id = e.id LEFT JOIN ai_mem_profiles p ON p.entity_id = e.id GROUP BY e.id HAVING pieces > 0 ORDER BY e.kind = 'person', pieces DESC, e.name`).all() as { id: number }[])
    .map((e) => ({ ...e, edges: edgesFor([e.id], 12) })) as never;
}

// ─── profiles ───

export function getProfile(entityId: number): { body: string; updated_at: string } | undefined {
  ensureGraph();
  return db.prepare('SELECT body, updated_at FROM ai_mem_profiles WHERE entity_id = ?').get(entityId) as never;
}
export function saveProfile(entityId: number, body: string, sources: string) {
  ensureGraph();
  db.prepare(`INSERT INTO ai_mem_profiles (entity_id, body, sources) VALUES (?, ?, ?)
    ON CONFLICT(entity_id) DO UPDATE SET body = excluded.body, sources = excluded.sources, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(entityId, body.slice(0, 3000), sources);
}
/** Reps whose linked pieces changed since their profile (or who have none yet) and have at least `min` pieces: the nightly profile list. */
export function profilesDue(min = 3, limit = 8): { entity: Entity; chunkIds: number[]; sources: string }[] {
  ensureGraph();
  const out: { entity: Entity; chunkIds: number[]; sources: string }[] = [];
  // reps without a profile first, then the oldest: newest pieces change nearly every night, so id order rewrote the same 8 forever
  for (const e of db.prepare(`SELECT e.id, e.kind, e.name, e.key FROM ai_mem_entities e LEFT JOIN ai_mem_profiles p ON p.entity_id = e.id
    WHERE e.kind = 'person' ORDER BY p.updated_at IS NOT NULL, p.updated_at, e.id`).all() as Entity[]) {
    const ids = linkedChunks([e.id], 25);
    if (ids.length < min) continue;
    const hashes = (db.prepare(`SELECT hash FROM ai_mem_chunks WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as { hash: string }[]).map((h) => h.hash).join(',');
    const sources = crypto.createHash('sha1').update(hashes).digest('hex');
    if (getProfile(e.id) && (db.prepare('SELECT sources FROM ai_mem_profiles WHERE entity_id = ?').get(e.id) as { sources: string }).sources === sources) continue;
    out.push({ entity: e, chunkIds: ids, sources });
    if (out.length >= limit) break;
  }
  return out;
}

// ─── relationships (D, 2026-10-23: "AI-drawn relationships between entities"): the nightly pass reads pieces that name two or more
// entities and writes how they relate ("team lead of", "set calls for", "client of"), each with the piece it came from and its day. Only
// between entities already known (names checked here), so a model never invents a person. Recall shows a named entity's relationships and
// pulls in pieces about the entities it is related to. ───

export interface Edge { id: number; from: string; rel: string; to: string; day: string; seen: number; chunk_id: number | null }
/** Pieces that name 2+ entities and changed since they were read (newest first): the nightly relationship work list. */
export function relationsDue(limit = 150): { id: number; title: string; body: string; at: string; hash: string; names: string[] }[] {
  ensureGraph();
  const rows = db.prepare(`SELECT c.id, c.title, c.body, c.at, c.hash FROM ai_mem_chunks c JOIN ai_mem_links l ON l.chunk_id = c.id
    LEFT JOIN ai_mem_rel_read r ON r.chunk_id = c.id WHERE c.kind <> 'team_past' AND (r.hash IS NULL OR r.hash <> c.hash)
    GROUP BY c.id HAVING count(*) >= 2 ORDER BY c.at DESC, c.id DESC LIMIT ?`).all(limit) as { id: number; title: string; body: string; at: string; hash: string }[];
  return rows.map((r) => ({ ...r, names: (db.prepare('SELECT e.name FROM ai_mem_links l JOIN ai_mem_entities e ON e.id = l.entity_id WHERE l.chunk_id = ?').all(r.id) as { name: string }[]).map((x) => x.name) }));
}
export function markRelationsRead(chunks: { id: number; hash: string }[]) {
  ensureGraph();
  for (const c of chunks) db.prepare('INSERT INTO ai_mem_rel_read (chunk_id, hash) VALUES (?, ?) ON CONFLICT(chunk_id) DO UPDATE SET hash = excluded.hash').run(c.id, c.hash);
}
/** Saves one relationship between two known entities (by exact name, any case). False when a name is not a known entity. */
export function saveEdge(from: string, rel: string, to: string, chunkId: number | null, day: string): boolean {
  ensureGraph();
  const find = (n: string) => db.prepare('SELECT id FROM ai_mem_entities WHERE lower(name) = lower(?)').get(n.trim()) as { id: number } | undefined;
  const a = find(from), b = find(to), r = rel.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
  if (!a || !b || a.id === b.id || r.length < 2) return false;
  db.prepare(`INSERT INTO ai_mem_edges (from_id, rel, to_id, chunk_id, day) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(from_id, rel, to_id) DO UPDATE SET seen = seen + 1, chunk_id = excluded.chunk_id, day = max(day, excluded.day)`).run(a.id, r, b.id, chunkId, day);
  return true;
}
/** The relationships of these entities (both directions), most seen and newest first. */
export function edgesFor(entityIds: number[], limit = 8): Edge[] {
  if (!entityIds.length) return [];
  ensureGraph();
  const q = entityIds.map(() => '?').join(',');
  return db.prepare(`SELECT x.id, a.name "from", x.rel, b.name "to", x.day, x.seen, x.chunk_id FROM ai_mem_edges x
    JOIN ai_mem_entities a ON a.id = x.from_id JOIN ai_mem_entities b ON b.id = x.to_id
    WHERE x.from_id IN (${q}) OR x.to_id IN (${q}) ORDER BY x.seen DESC, x.day DESC LIMIT ?`).all(...entityIds, ...entityIds, limit) as Edge[];
}
/** The entities these are related to (one hop). */
export function neighbours(entityIds: number[], limit = 6): number[] {
  if (!entityIds.length) return [];
  ensureGraph();
  const q = entityIds.map(() => '?').join(',');
  return (db.prepare(`SELECT CASE WHEN from_id IN (${q}) THEN to_id ELSE from_id END n, sum(seen) w FROM ai_mem_edges WHERE from_id IN (${q}) OR to_id IN (${q})
    GROUP BY n ORDER BY w DESC LIMIT ?`).all(...entityIds, ...entityIds, ...entityIds, limit) as { n: number }[]).map((r) => r.n).filter((n) => !entityIds.includes(n));
}
/** The Memory page's graph view (D, 2026-10-23: "where are the graphs"): people and agents as nodes, links = the AI-drawn relationships
 *  plus "named together" (pieces naming both, 3 or more; the strongest 400 pairs). */
export function entityGraph(): { nodes: { id: number; kind: string; name: string; pieces: number }[]; links: { a: number; b: number; w: number; rel?: string }[] } {
  ensureGraph();
  const nodes = db.prepare(`SELECT e.id, e.kind, e.name, count(l.chunk_id) pieces FROM ai_mem_entities e JOIN ai_mem_links l ON l.entity_id = e.id GROUP BY e.id`).all() as { id: number; kind: string; name: string; pieces: number }[];
  const together = db.prepare(`SELECT x.entity_id a, y.entity_id b, count(*) w FROM ai_mem_links x JOIN ai_mem_links y ON y.chunk_id = x.chunk_id AND y.entity_id > x.entity_id
    GROUP BY 1, 2 HAVING w >= 3 ORDER BY w DESC LIMIT 400`).all() as { a: number; b: number; w: number }[];
  const rels = (db.prepare('SELECT from_id a, to_id b, seen w, rel FROM ai_mem_edges ORDER BY seen DESC LIMIT 300').all() as { a: number; b: number; w: number; rel: string }[]);
  return { nodes, links: [...rels, ...together] };
}
// ─── the memory map (D, 2026-10-23: "its own page ... like CTRL Flow, zoom in, find what it is and connections"): people and agents,
// plus the Slack channels, Knowledge documents and team decisions that name them, as one graph. Node ids: e:<entity>, ch:<channel>,
// doc:<kb doc>, dec:<team item>. Calls and AI chats are not nodes (thousands); they show as a node's memory in the side panel. ───
export interface MapNode { id: string; kind: 'person' | 'agent' | 'channel' | 'doc' | 'decision'; name: string; weight: number }
export interface MapLink { a: string; b: string; w: number; rel?: string }
const sourceOf = (kind: string, ref: string, title: string, body: string): { id: string; kind: MapNode['kind']; name: string } | null => {
  const m = /^(slack|kb|team):([^:#]+)/.exec(ref);
  if (!m) return null;
  if (kind === 'slack') return { id: `ch:${m[2]}`, kind: 'channel', name: /^Slack (#\S+)/.exec(title)?.[1] ?? `#${m[2]}` };
  if (kind === 'kb') return { id: `doc:${m[2]}`, kind: 'doc', name: title.replace(/^(Knowledge|Wiki): /, '').replace(/^.* \/ /, '').slice(0, 80) || `Document ${m[2]}` };
  return { id: `dec:${m[2]}`, kind: 'decision', name: body.replace(/\s+/g, ' ').slice(0, 80) };
};
export function memoryMap(maxSources = 160): { nodes: MapNode[]; links: MapLink[] } {
  const g = entityGraph();
  const nodes = new Map<string, MapNode>(g.nodes.map((n) => [`e:${n.id}`, { id: `e:${n.id}`, kind: n.kind === 'person' ? 'person' : 'agent', name: n.name, weight: n.pieces }]));
  const links: MapLink[] = g.links.map((l) => ({ a: `e:${l.a}`, b: `e:${l.b}`, w: l.w, rel: l.rel }));
  // sources: how many of their pieces name each entity
  const rows = db.prepare(`SELECT c.kind, c.ref, c.title, substr(c.body, 1, 200) body, l.entity_id e FROM ai_mem_links l JOIN ai_mem_chunks c ON c.id = l.chunk_id
    WHERE c.kind IN ('slack', 'kb', 'team')`).all() as { kind: string; ref: string; title: string; body: string; e: number }[];
  const src = new Map<string, { n: { id: string; kind: MapNode['kind']; name: string }; to: Map<number, number> }>();
  for (const r of rows) {
    const n = sourceOf(r.kind, r.ref, r.title, r.body);
    if (!n) continue;
    const x = src.get(n.id) ?? src.set(n.id, { n, to: new Map() }).get(n.id)!;
    x.to.set(r.e, (x.to.get(r.e) ?? 0) + 1);
  }
  const keep = [...src.values()].map((x) => ({ ...x, total: [...x.to.values()].reduce((a, b) => a + b, 0) }))
    .filter((x) => x.n.kind === 'decision' || x.total >= 2).sort((a, b) => b.total - a.total).slice(0, maxSources);
  for (const x of keep) {
    nodes.set(x.n.id, { ...x.n, weight: x.total });
    for (const [e, w] of x.to) if (nodes.has(`e:${e}`)) links.push({ a: x.n.id, b: `e:${e}`, w });
  }
  return { nodes: [...nodes.values()], links };
}
/** One map node for the side panel: what it is, its profile (reps), its relationships, and the newest memory that names it or comes from it. */
export function mapNodeDetail(id: string): { id: string; profile: string | null; profiled: string | null; edges: Edge[]; pieces: { kind: string; title: string; at: string; body: string }[] } | null {
  ensureGraph();
  const m = /^(e|ch|doc|dec):(.+)$/.exec(id);
  if (!m) return null;
  const take = (ids: number[]) => ids.length ? (db.prepare(`SELECT kind, title, at, substr(body, 1, 400) body FROM ai_mem_chunks WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY at DESC, id DESC`).all(...ids) as { kind: string; title: string; at: string; body: string }[]) : [];
  if (m[1] === 'e') {
    const eid = Number(m[2]), p = getProfile(eid);
    return { id, profile: p?.body ?? null, profiled: p?.updated_at ?? null, edges: edgesFor([eid], 20), pieces: take(linkedChunks([eid], 25)) };
  }
  const prefix = m[1] === 'ch' ? `slack:${m[2]}:` : m[1] === 'doc' ? `kb:${m[2]}#` : `team:${m[2]}#`;
  const ids = (db.prepare("SELECT id FROM ai_mem_chunks WHERE substr(ref, 1, length(?)) = ? ORDER BY at DESC, id DESC LIMIT 25").all(prefix, prefix) as { id: number }[]).map((r) => r.id);
  return { id, profile: null, profiled: null, edges: [], pieces: take(ids) };
}
export function deleteEdge(id: number): boolean { ensureGraph(); return db.prepare('DELETE FROM ai_mem_edges WHERE id = ?').run(id).changes > 0; }

// ─── the memory_graph tool and graph cards (D 2026-10-28) ───
const KIND: Record<string, string> = { rep: 'person (rep or staff)', contract: 'client contract' };
/** One thing in the graph by name (exact, then contains): what it is, its profile, relationships, what it is most linked with, and the
 *  newest pieces about it. */
/** `agentId`: the asking agent; another agent's private pieces never show (private memory, team-memory.ts). */
export function graphLookup(name: string, agentId: number | null = null): string {
  ensureGraph();
  const q = name.trim();
  if (q.length < 2) return 'Name a rep or a contract.';
  const rows = db.prepare(`SELECT e.id, e.kind, e.name, count(l.chunk_id) n FROM ai_mem_entities e LEFT JOIN ai_mem_links l ON l.entity_id = e.id
    WHERE lower(e.name) = lower(?) OR lower(e.name) LIKE lower(?) GROUP BY e.id ORDER BY lower(e.name) = lower(?) DESC, n DESC LIMIT 6`).all(q, `%${q}%`, q) as { id: number; kind: string; name: string; n: number }[];
  if (!rows.length) return `Nothing in the memory graph called "${q}". Try search_memory, or a shorter name.`;
  const e = rows[0];
  const out = [`${e.name}: ${KIND[e.kind] ?? e.kind}, named in ${e.n} memory pieces.`];
  const prof = getProfile(e.id);
  if (prof) out.push(`Profile: ${prof.body}`);
  const rels = edgesFor([e.id], 25);
  if (rels.length) out.push(`Relationships:\n${rels.map((r) => `- ${r.from} ${r.rel} ${r.to}${r.day ? ` (${r.day})` : ''}`).join('\n')}`);
  const near = db.prepare(`SELECT o.name, o.kind, count(DISTINCT a.chunk_id) w FROM ai_mem_links a JOIN ai_mem_links b ON b.chunk_id = a.chunk_id AND b.entity_id <> a.entity_id
    JOIN ai_mem_entities o ON o.id = b.entity_id WHERE a.entity_id = ? AND lower(o.name) <> lower(?) GROUP BY lower(o.name) ORDER BY w DESC LIMIT 15`).all(e.id, e.name) as { name: string; kind: string; w: number }[];
  if (near.length) out.push(`Most often mentioned with: ${near.map((x) => `${x.name} (${KIND[x.kind] ?? x.kind}, ${x.w})`).join(', ')}`);
  const pieces = db.prepare(`SELECT c.title, c.at, substr(c.body, 1, 300) body FROM ai_mem_links l JOIN ai_mem_chunks c ON c.id = l.chunk_id
    WHERE l.entity_id = ? AND (c.agent_id IS NULL OR c.agent_id = ?) ORDER BY c.at DESC LIMIT 6`).all(e.id, agentId ?? 0) as { title: string; at: string; body: string }[];
  if (pieces.length) out.push(`Newest memory about it:\n${pieces.map((x) => `- ${x.title}: ${x.body.replace(/\s+/g, ' ')}`).join('\n')}`);
  if (rows.length > 1) out.push(`Also matching: ${rows.slice(1).map((x) => `${x.name} (${KIND[x.kind] ?? x.kind})`).join(', ')}`);
  return out.join('\n\n');
}
/** What the graph knows, by kind (rep, contract), most named first. */
export function graphList(kind: string | undefined, limit = 60): string {
  ensureGraph();
  const rows = db.prepare(`SELECT e.name, e.kind, count(*) n FROM ai_mem_entities e JOIN ai_mem_links l ON l.entity_id = e.id
    ${kind ? 'WHERE e.kind = ?' : ''} GROUP BY e.id ORDER BY n DESC LIMIT ?`).all(...(kind ? [kind] : []), limit) as { name: string; kind: string; n: number }[];
  return rows.length ? rows.map((r) => `${r.name} (${KIND[r.kind] ?? r.kind}, ${r.n})`).join('\n') : 'Nothing in the graph for that yet.';
}

// names that are in a large share of all pieces (the agency itself, a big contract) say nothing about one message: left out of the
// automatic cards and their "often with" lists (shortcut: a fixed 8% of pieces, cached 10 min per agency; tune when memory grows a lot)
const hubCache = new Map<string, { at: number; ids: Set<number> }>();
export function hubIds(): Set<number> {
  ensureGraph();
  const key = agencyIdNow(), hit = hubCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.ids;
  const total = (db.prepare('SELECT count(*) n FROM ai_mem_chunks').get() as { n: number }).n || 1;
  const ids = new Set((db.prepare('SELECT entity_id e FROM ai_mem_links GROUP BY entity_id HAVING count(*) > ?').all(Math.max(150, Math.round(total * 0.08))) as { e: number }[]).map((r) => r.e));
  hubCache.set(key, { at: Date.now(), ids });
  return ids;
}
/** Short graph cards for the people and agents a message names, for the automatic recall before each turn: their relationships and who
 *  they are mentioned with most. At most `max`. */
export function graphCards(text: string, max = 4): string {
  ensureGraph();
  const seen = new Set<string>(), cards: string[] = [];
  const hubs = hubIds(), hubNames = new Set((db.prepare(`SELECT lower(name) n FROM ai_mem_entities WHERE id IN (${[...hubs].join(',') || 0})`).all() as { n: string }[]).map((r) => r.n));
  for (const e of entitiesIn(text)) {
    const k = e.name.toLowerCase();
    if (seen.has(k) || cards.length >= max || hubs.has(e.id) || hubNames.has(k)) continue;
    seen.add(k);
    const near = (db.prepare(`SELECT o.name, count(DISTINCT a.chunk_id) w FROM ai_mem_links a JOIN ai_mem_links b ON b.chunk_id = a.chunk_id AND b.entity_id <> a.entity_id
      JOIN ai_mem_entities o ON o.id = b.entity_id WHERE a.entity_id = ? AND lower(o.name) <> lower(?) GROUP BY lower(o.name) ORDER BY w DESC LIMIT 15`).all(e.id, e.name) as { name: string }[])
      .map((x) => x.name).filter((n) => !hubNames.has(n.toLowerCase())).slice(0, 5);
    if (!near.length) continue;
    cards.push(`- [Graph: ${e.name}, ${e.kind}] Often mentioned with: ${near.join(', ')}.`);
  }
  return cards.join('\n');
}
