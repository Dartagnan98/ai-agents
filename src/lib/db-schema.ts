// AI Agents - the app SQLite's opening and schema, shared by the one install database (lib/db.ts) and each agency's own database in
// multi-agency mode (lib/platform/tenant-db.ts). Moved here unchanged from lib/db.ts (D, 2026-10-09).

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

/** Where the install's SQLite lives today (CTX_ROOT/dashboard or ./.data). the agency keeps this file in multi-agency mode too. */
export function legacyDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const instanceId = env.CTX_INSTANCE_ID ?? 'default';
  const ctxRoot = env.CTX_ROOT;
  return ctxRoot
    ? path.join(ctxRoot, 'dashboard', `cortextos-${instanceId}.db`)
    : path.join(process.cwd(), '.data', `cortextos-${instanceId}.db`);
}

export function createDatabase(DB_PATH: string): Database.Database {
  // Ensure .data directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(DB_PATH, { timeout: 10000 });

  // Set busy_timeout BEFORE attempting any schema or pragma changes that
  // require write locks (e.g. WAL switch, CREATE TABLE). Without this, parallel
  // processes (like Next.js build workers) hit SQLITE_BUSY immediately.
  db.pragma('busy_timeout = 10000');

  // Switch to WAL mode (requires exclusive lock on the DB file).
  // Guard against SQLITE_BUSY when multiple Next.js build workers open the DB
  // simultaneously: if the switch fails, check whether another worker already
  // succeeded. If so, continue; otherwise re-throw.
  try {
    db.pragma('journal_mode = WAL');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException & { code?: string }).code !== 'SQLITE_BUSY') throw err;
    const rows = db.pragma('journal_mode') as { journal_mode: string }[];
    if (rows[0]?.journal_mode !== 'wal') throw err;
    // Another worker already switched to WAL — we're fine.
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Run schema initialization
  initializeSchema(db);

  return db;
}

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'normal',
      assignee TEXT,
      org TEXT NOT NULL DEFAULT '',
      project TEXT,
      needs_approval INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      completed_at TEXT,
      notes TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      category TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      data TEXT,
      message TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS heartbeats (
      agent TEXT PRIMARY KEY,
      org TEXT NOT NULL DEFAULT '',
      status TEXT,
      current_task TEXT,
      mode TEXT,
      last_heartbeat TEXT,
      loop_interval INTEGER,
      uptime_seconds INTEGER
    );

    CREATE TABLE IF NOT EXISTS cost_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-user dashboard access. full=1 is a legacy "see everything" admin.
    -- role is owner | admin | user. businesses is { businessKey: pageId[] }.
    CREATE TABLE IF NOT EXISTS crm_accounts (
      business_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      location_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (business_key, provider)
    );

    CREATE TABLE IF NOT EXISTS crm_user_links (
      user_id INTEGER NOT NULL,
      business_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      crm_user_id TEXT NOT NULL,
      crm_user_name TEXT NOT NULL,
      crm_user_email TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (user_id, business_key, provider)
    );

    CREATE TABLE IF NOT EXISTS user_access (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      full INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'user',
      ai TEXT NOT NULL DEFAULT '[]',
      businesses TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      last_synced TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Rate limit table: persists across server restarts so limits survive hot-reloads
    -- and intentional restarts. reset_at is a Unix timestamp in milliseconds.
    CREATE TABLE IF NOT EXISTS rate_limits (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

    CREATE INDEX IF NOT EXISTS idx_approvals_org ON approvals(org);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent);

    CREATE INDEX IF NOT EXISTS idx_events_org ON events(org);
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);

    CREATE INDEX IF NOT EXISTS idx_cost_entries_timestamp ON cost_entries(timestamp);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_agent ON cost_entries(agent);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_org ON cost_entries(org);

    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(org);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  `);
  const cols = db.prepare('PRAGMA table_info(user_access)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'role')) {
    db.exec("ALTER TABLE user_access ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
}

