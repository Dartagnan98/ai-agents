import { beforeAll, describe, expect, it, vi } from 'vitest';

// Team memory (D, 2026-10-22): ingest of owner/admin chats, Knowledge and team decisions into pieces, word + meaning search, recall only
// for the owner and admins. Against an in-memory SQLite with a fake embedder (no model download in tests).
vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
    INSERT INTO users (id, username) VALUES (1, 'Sam'), (2, 'Sam'), (3, 'Rep Ryan'), (4, 'Jordan Blake'), (5, 'Joe Vance'), (6, 'Joe K.'),
      (7, 'Jay'), (8, 'alex.kim@example.com'), (9, 'Robin Shaw');
    CREATE TABLE ai_agents (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO ai_agents (id, name) VALUES (1, 'Research Bot');
    CREATE TABLE ai_threads (id INTEGER PRIMARY KEY, user_id INTEGER, title TEXT, updated_at TEXT, agent_id INTEGER);
    CREATE TABLE ai_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER, role TEXT, text TEXT);
    CREATE TABLE kb_docs (id INTEGER PRIMARY KEY, space TEXT, folder TEXT, title TEXT, body TEXT, updated_at TEXT);
    CREATE TABLE ai_leases (name TEXT PRIMARY KEY, holder TEXT, until INTEGER);
    INSERT INTO ai_threads VALUES (10, 1, 'Refund rule', '2026-10-21T10:00:00Z', NULL), (11, 3, 'My commission', '2026-10-21T11:00:00Z', NULL);
    INSERT INTO ai_messages (thread_id, role, text) VALUES (10, 'user', 'From now on refunds count in the month they happen, not the month of the sale.'),
      (10, 'assistant', 'Got it.'), (11, 'user', 'Secret rep question about my commission split with Alex');
    INSERT INTO kb_docs VALUES (5, 'knowledge', 'SOPs', 'Closer onboarding', 'New closers shadow three calls before taking their own calendar.', '2026-10-01T00:00:00Z');`);
  return { db };
});
vi.mock('@/lib/user-access', () => ({ getGrant: (id: number) => ({ role: id === 1 ? 'owner' : id === 2 ? 'admin' : 'user' }) }));
vi.mock('@/lib/slack/app', () => ({ botToken: () => null }));
vi.mock('@/lib/agency-secrets', () => ({ agencySecretValues: () => ({ OPENAI_API_KEY: 'sk-supersecretvalue123' }) }));
vi.mock('../routines', () => ({ acquireLease: () => true, releaseLease: () => {} }));

// a tiny bag-of-words embedder: shared words = similar
const VOCAB = ['refund', 'month', 'sale', 'closer', 'shadow', 'call', 'commission', 'onboarding', 'leaderboard'];
const fake = async (texts: string[]) => texts.map((t) => {
  const v = VOCAB.map((w) => (t.toLowerCase().includes(w) ? 1 : 0)); const n = Math.hypot(...v) || 1; return v.map((x) => x / n);
});

// a fake cross-encoder: how many of the question's words the candidate has (null = not loaded, to test the fallback)
let rerankScore = (q: string, d: string) => q.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && d.toLowerCase().includes(w)).length;
let T: typeof import('../team-memory');
beforeAll(async () => {
  const E = await import('../embed-local');
  E.setEmbedderForTest(fake);
  E.setRerankerForTest(async (q, docs) => docs.map((d) => rerankScore(q, d)));
  T = await import('../team-memory');
});

describe('pieces and word queries', () => {
  it('cuts long text into overlapping pieces of at most 1,500 characters', () => {
    const text = Array.from({ length: 80 }, (_, i) => `Line ${i} says something about the board and the ledger.`).join('\n');
    const p = T.pieces(text);
    expect(p.length).toBeGreaterThan(2);
    expect(p.every((x) => x.length <= 1500)).toBe(true);
    expect(T.pieces('short')).toEqual(['short']);
  });
  it('turns a question into a safe OR query without stop words or punctuation', () => {
    expect(T.ftsQuery('What did we decide about refunds? (Oct)')).toBe('"decide" OR "refunds" OR "oct"');
    expect(T.ftsQuery('the and of')).toBe('');
  });
});

describe('ingest, search, recall', () => {
  it('ingests owner/admin chats (never a rep\'s), Knowledge and team decisions; scrubs secrets; searches by words and meaning', async () => {
    T.addTeamItem({ kind: 'decision', content: 'the agency reps are the active Slack members; deactivated people are turned off on the box.', who: 'Sam', day: '2026-10-21', threadId: 10 });
    expect(T.addTeamItem({ kind: 'decision', content: 'the agency reps are the active Slack members; deactivated people are turned off on the box.', who: 'D', day: '2026-10-21' })).toBeNull(); // once
    const summary = await T.ingestNow();
    expect(summary).toMatch(/chat 1 \(1 changed\)/); // thread 11 belongs to a rep: not ingested
    const all = await T.searchMemory('commission split', 10);
    expect(all.some((h) => h.title.includes('My commission'))).toBe(false);
    const refunds = await T.searchMemory('when do refunds count', 5);
    expect(refunds[0].title).toContain('AI chat with Sam: Refund rule');
    const shadow = await T.searchMemory('how many calls does a new closer shadow', 5);
    expect(shadow[0].title).toBe('Knowledge: SOPs / Closer onboarding');
    expect((await T.searchMemory('slack members deactivated', 5))[0].kind).toBe('team');
    // one hit per source, however many of its pieces match
    const { db } = await import('@/lib/db');
    db.prepare("INSERT INTO kb_docs VALUES (7, 'knowledge', '', 'Long refund guide', ?, '2026-10-03T00:00:00Z')").run(Array.from({ length: 60 }, (_, i) => `Refund rule ${i}: a refund counts in the month it happens.`).join('\n'));
    await T.ingestNow();
    const many = await T.searchMemory('refund month', 8);
    expect(many.filter((h) => h.title === 'Knowledge: Long refund guide')).toHaveLength(1);
    db.prepare('DELETE FROM kb_docs WHERE id = 7').run();
    await T.ingestNow();
    // a second pass changes nothing
    expect(await T.ingestNow()).toMatch(/chat 1 \(0 changed\)/);
  });
  it('recall is for the owner and admins only, and never shows a secret', async () => {
    const { db } = await import('@/lib/db');
    db.prepare("INSERT INTO kb_docs VALUES (6, 'knowledge', '', 'Keys', 'The refund webhook key is sk-supersecretvalue123 for the month.', '2026-10-02T00:00:00Z')").run();
    await T.ingestNow();
    const owner = await T.recallFor(1, 'refund month rule');
    expect(owner).toMatch(/^=== Team memory/);
    expect(owner).toContain('Refund rule');
    expect(owner).not.toContain('sk-supersecretvalue123');
    expect(await T.recallFor(2, 'refund month rule')).not.toBe('');
    expect(await T.recallFor(3, 'refund month rule')).toBe('');
  });
});

describe('rerank', () => {
  it('reorders the pool by the cross-encoder, and keeps the merge order when it has no answer', async () => {
    const E = await import('../embed-local');
    // 'closer refund' finds two sources (the Knowledge doc and the refund chat); the fake cross-encoder says the Knowledge doc wins
    rerankScore = (_q, d) => (d.includes('Closer onboarding') ? 100 : 0);
    expect((await T.searchMemory('closer refund', 1))[0].title).toBe('Knowledge: SOPs / Closer onboarding');
    rerankScore = (_q, d) => (d.includes('Refund rule') ? 100 : 0);
    expect((await T.searchMemory('closer refund', 1))[0].title).toBe('AI chat with Sam: Refund rule');
    // no answer from the cross-encoder: the same as with rerank off
    process.env.TEAM_RERANK = 'off';
    const plain = (await T.searchMemory('closer refund', 1))[0].title;
    delete process.env.TEAM_RERANK;
    E.setRerankerForTest(async () => { throw new Error('no model'); });
    expect((await T.searchMemory('closer refund', 1))[0].title).toBe(plain);
    E.setRerankerForTest(async (q, docs) => docs.map((d) => rerankScore(q, d)));
  });
});

describe('Memory page edits', () => {
  it('retire takes a decision out of search at once, keep brings it back, edit changes what search finds, delete removes it', async () => {
    const id = T.addTeamItem({ kind: 'decision', content: 'Leaderboard posts go out at 3 AM ET every day.', who: 'Sam', day: '2026-10-22' })!;
    T.syncTeam();
    const has = async (q: string) => (await T.searchMemory(q, 8)).some((h) => h.kind === 'team' && h.body.includes('Leaderboard'));
    expect(await has('leaderboard posts')).toBe(true);
    expect(T.setTeamStatus(id, 'stale')).toBe(true);
    expect(await has('leaderboard posts')).toBe(false);
    expect(T.allTeamItems().find((t) => t.id === id)?.status).toBe('stale');
    expect(T.setTeamStatus(id, 'active')).toBe(true);
    expect(await has('leaderboard posts')).toBe(true);
    expect(T.editTeamItem(id, 'Leaderboard posts go out at 4 AM ET, after the ledger.')).toBe(true);
    expect((await T.searchMemory('leaderboard posts', 8)).find((h) => h.kind === 'team')?.body).toContain('4 AM');
    expect(T.deleteTeamItem(id)).toBe(true);
    expect(await has('leaderboard posts')).toBe(false);
  });
});

describe('graph: people and agents by name', () => {
  it('matches full names, unique 5+ letter first names and agents; never short or shared first names', async () => {
    const G = await import('../team-graph');
    G.refreshEntities();
    const names = (t: string) => G.entitiesIn(t).map((e) => e.name).sort();
    expect(names('Jordan sent the report')).toEqual(['Jordan Blake']); // unique first name, 6 letters
    expect(names('Sam posted the list')).toEqual([]); // a lone short name matches nothing
    expect(names('Robin Shaw had 9 calls')).toEqual(['Robin Shaw']);
    expect(names('Joe said hi to Jay')).toEqual([]); // "Joe" is shared, "Jay" is too short
    expect(names('Joe Vance and Joe K. asked Research Bot')).toEqual(['Joe K.', 'Joe Vance', 'Research Bot']);
    expect(names('alex kim closed one')).toEqual(['alex kim']); // an email login reads as its name
  });
  it('a question that names a person pulls in their pieces, and their profile leads recall', async () => {
    const { db } = await import('@/lib/db');
    db.prepare("INSERT INTO kb_docs VALUES (20, 'knowledge', '', 'Weekly notes', 'alex kim moved to team lead on ACME calls this week.', '2026-10-20T00:00:00Z')").run();
    db.prepare("INSERT INTO kb_docs VALUES (21, 'knowledge', '', 'Setter notes', 'Joe Vance booked 4 sets on Tuesday.', '2026-10-20T00:00:00Z')").run();
    await T.ingestNow();
    const G = await import('../team-graph');
    const alex = G.entitiesIn('alex kim')[0];
    expect(G.linkedChunks([alex.id]).length).toBeGreaterThan(0);
    expect((await T.searchMemory('how is alex kim doing', 5)).some((h) => h.title === 'Knowledge: Weekly notes')).toBe(true);
    expect(G.profilesDue(1, 8).map((d) => d.entity.name)).toContain('alex kim');
    G.saveProfile(alex.id, 'Alex is the ACME team lead since Oct 20.', 'x');
    expect(await T.recallFor(1, 'how is alex kim doing')).toContain('[Profile of alex kim');
    expect(await T.recallFor(3, 'how is alex kim doing')).toBe(''); // a member never gets team memory
    // a person with a profile goes behind everyone still without one (the nightly cap never starves the rest)
    const order = G.profilesDue(1, 99).map((d) => d.entity.name);
    expect(order.length).toBeGreaterThan(1);
    expect(order.at(-1)).toBe('alex kim');
  });
});

describe('commitments', () => {
  it('open ones are searchable; done ones leave search; the same promise is kept once', async () => {
    const id = T.addCommitment({ who: 'Sam', what: 'Send the client the September invoice with the refund lines.', due: '2026-10-25', day: '2026-10-22' })!;
    expect(T.addCommitment({ who: 'D', what: 'Send the client the September invoice with the refund lines.', day: '2026-10-22' })).toBeNull();
    T.syncCommitments();
    const found = async () => (await T.searchMemory('invoice for the client', 8)).some((h) => h.kind === 'commitment');
    expect(await found()).toBe(true);
    expect(T.listCommitments()[0]).toMatchObject({ id, due: '2026-10-25', status: 'open' });
    expect(T.setCommitment(id, 'done')).toBe(true);
    expect(await found()).toBe(false);
    expect(T.listCommitments().find((c) => c.id === id)?.status).toBe('done');
  });
});

describe('timeline: "as of" questions', () => {
  it('an edited decision: "as of" finds the old wording with its days, a plain question only the new one; a retired one only in its own time', async () => {
    const id = T.addTeamItem({ kind: 'decision', content: 'Chargebacks come off the closer of the original sale.', who: 'Sam', day: '2026-09-01' })!;
    T.syncTeam();
    expect(T.editTeamItem(id, 'Chargebacks come off the original closer if active, else off the agency\'s own invoice.')).toBe(true);
    const plain = await T.searchMemory('who pays for chargebacks', 8);
    expect(plain.some((h) => h.body.includes("else off the agency's own invoice"))).toBe(true);
    expect(plain.some((h) => h.kind === 'team_past')).toBe(false);
    const asOf = await T.searchMemory('who paid for chargebacks as of 2026-09-15', 8);
    const old = asOf.find((h) => h.kind === 'team_past');
    expect(old?.body).toBe('Chargebacks come off the closer of the original sale.');
    expect(old?.title).toMatch(/true 2026-09-01 to \d{4}-\d{2}-\d{2}/);
    expect(asOf.some((h) => h.body.includes("else off the agency's own invoice"))).toBe(false); // not true yet on Sept 15
    // retired: gone from plain questions, still there for its own time
    const r = T.addTeamItem({ kind: 'decision', content: 'Setter bonuses are paid weekly on Fridays.', who: 'Sam', day: '2026-08-01' })!;
    T.syncTeam();
    expect(T.setTeamStatus(r, 'stale')).toBe(true);
    expect((await T.searchMemory('when are setter bonuses paid', 8)).some((h) => h.body.includes('weekly on Fridays'))).toBe(false);
    expect((await T.searchMemory('when were setter bonuses paid in August', 8)).some((h) => h.kind === 'team_past' && h.body.includes('weekly on Fridays'))).toBe(true);
    // recall says which time it answered for
    expect(await T.recallFor(1, 'who paid for chargebacks as of 2026-09-15')).toMatch(/asks about as of 2026-09-15 \(up to 2026-09-15\)/);
  });
});

describe('relationships (AI-drawn, between known entities only)', () => {
  it('saves only known names, counts repeats, shows them in recall, and pulls in pieces about related people', async () => {
    const G = await import('../team-graph');
    G.refreshEntities();
    expect(G.saveEdge('alex kim', 'Team lead of', 'Jordan Blake', null, '2026-10-20')).toBe(true);
    expect(G.saveEdge('ALEX KIM', 'team lead of', 'jordan blake', null, '2026-10-21')).toBe(true); // same one again: seen twice
    expect(G.saveEdge('alex kim', 'manages', 'Someone Invented', null, '2026-10-21')).toBe(false); // a model never adds a person
    expect(G.saveEdge('alex kim', 'coaches', 'alex kim', null, '2026-10-21')).toBe(false);
    const alex = G.entitiesIn('alex kim')[0], mo = G.entitiesIn('Jordan Blake')[0];
    expect(G.edgesFor([alex.id]).map((e) => [e.from, e.rel, e.to, e.seen, e.day])).toEqual([['alex kim', 'team lead of', 'Jordan Blake', 2, '2026-10-21']]);
    expect(G.neighbours([alex.id])).toEqual([mo.id]);
    // a piece only about Jordan joins a question about Alex (one hop)
    const { db } = await import('@/lib/db');
    db.prepare("INSERT INTO kb_docs VALUES (30, 'knowledge', '', 'Setter notes', 'Jordan Blake booked 5 sets on Saturday, best of the week.', '2026-10-18T00:00:00Z')").run();
    await T.ingestNow();
    expect((await T.searchMemory('how is alex kim team doing', 8)).some((h) => h.title === 'Knowledge: Setter notes')).toBe(true);
    expect(await T.recallFor(1, 'how is alex kim doing')).toContain('[Relationship, 2026-10-21] alex kim team lead of Jordan Blake');
    expect(G.deleteEdge(G.edgesFor([alex.id])[0].id)).toBe(true);
    expect(G.edgesFor([alex.id])).toEqual([]);
  });
  it('lists pieces naming 2+ entities until they are read', async () => {
    const G = await import('../team-graph');
    const { db } = await import('@/lib/db');
    db.prepare("INSERT INTO kb_docs VALUES (31, 'knowledge', '', 'Coaching', 'alex kim coaches Jordan Blake on BETA calls every Monday.', '2026-10-19T00:00:00Z')").run();
    await T.ingestNow();
    const due = G.relationsDue(50);
    expect(due.length).toBeGreaterThan(0);
    expect(due.every((d) => d.names.length >= 2)).toBe(true);
    G.markRelationsRead(due);
    expect(G.relationsDue(50)).toEqual([]);
  });
});
