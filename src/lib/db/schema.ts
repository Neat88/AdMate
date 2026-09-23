import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * SQLite is deliberate for the MVP: zero external services to stand up, a
 * single file to back up, and the same SQL that would move to Postgres later.
 * Every query in the app is scoped by `user_id` - see db/queries.ts.
 */

let instance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (instance) return instance;

  const dbPath = process.env.ADMATE_DB_PATH || path.join(process.cwd(), "data", "admate.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  instance = db;
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      currency   TEXT NOT NULL DEFAULT 'USD',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- One uploaded file. Raw rows live in report_rows; the file itself is not
    -- retained after parsing.
    CREATE TABLE IF NOT EXISTS reports (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename      TEXT NOT NULL,
      platform      TEXT NOT NULL,
      currency      TEXT NOT NULL,
      objective     TEXT,
      period_start  TEXT,
      period_end    TEXT,
      row_count     INTEGER NOT NULL,
      mapping_json  TEXT NOT NULL,
      issues_json   TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_workspace ON reports(workspace_id, created_at DESC);

    -- Normalized rows, stored once so an analysis can be re-run without
    -- asking the user to upload the file again.
    CREATE TABLE IF NOT EXISTS report_rows (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      row_json  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_rows_report ON report_rows(report_id);

    CREATE TABLE IF NOT EXISTS analyses (
      id              TEXT PRIMARY KEY,
      report_id       TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      engine          TEXT NOT NULL,
      fallback_reason TEXT,
      summary         TEXT NOT NULL,
      model_json      TEXT NOT NULL,
      created_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_analyses_report ON analyses(report_id, created_at DESC);

    -- A finding plus its narrated insight, with the status the user manages.
    CREATE TABLE IF NOT EXISTS recommendations (
      id            TEXT PRIMARY KEY,
      analysis_id   TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
      report_id     TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      finding_id    TEXT NOT NULL,
      code          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      priority      TEXT NOT NULL,
      severity      INTEGER NOT NULL,
      confidence    TEXT NOT NULL,
      entity_level  TEXT NOT NULL,
      entity_name   TEXT NOT NULL,
      title         TEXT NOT NULL,
      finding_json  TEXT NOT NULL,
      insight_json  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'new',
      note          TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recs_user ON recommendations(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_recs_analysis ON recommendations(analysis_id, severity DESC);

    CREATE TABLE IF NOT EXISTS alert_rules (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      metric        TEXT NOT NULL,
      comparator    TEXT NOT NULL,
      threshold     REAL NOT NULL,
      scope         TEXT NOT NULL,
      entity_filter TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rules_workspace ON alert_rules(workspace_id);

    CREATE TABLE IF NOT EXISTS alert_events (
      id           TEXT PRIMARY KEY,
      rule_id      TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
      analysis_id  TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
      report_id    TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      severity     TEXT NOT NULL,
      entity_name  TEXT NOT NULL,
      metric       TEXT NOT NULL,
      message      TEXT NOT NULL,
      acknowledged INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_user ON alert_events(user_id, created_at DESC);
  `);

  runVersionedMigrations(db);
}

/**
 * Schema changes after the initial release. `PRAGMA user_version` records how
 * many have been applied, so each runs exactly once on an existing database
 * and in order on a fresh one. Append only - never edit a shipped migration.
 */
const MIGRATIONS: ((db: Database.Database) => void)[] = [
  // 1: facts layer, decision tiers, and the report assistant.
  (db) => {
    const columns = (table: string) =>
      new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    const analyses = columns("analyses");
    if (!analyses.has("facts_json")) db.exec("ALTER TABLE analyses ADD COLUMN facts_json TEXT");
    if (!analyses.has("engine_version")) db.exec("ALTER TABLE analyses ADD COLUMN engine_version INTEGER");
    const recs = columns("recommendations");
    if (!recs.has("tier")) db.exec("ALTER TABLE recommendations ADD COLUMN tier TEXT");
    if (!recs.has("action_type")) db.exec("ALTER TABLE recommendations ADD COLUMN action_type TEXT");

    db.exec(`
      -- One assistant conversation per report per user.
      CREATE TABLE IF NOT EXISTS conversations (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        report_id   TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        summary     TEXT,
        focus_json  TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_report ON conversations(report_id, user_id);

      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content_json    TEXT NOT NULL,
        focus_json      TEXT,
        engine          TEXT,
        input_tokens    INTEGER,
        output_tokens   INTEGER,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);

      -- Per-user daily AI usage, for the quota.
      CREATE TABLE IF NOT EXISTS ai_usage (
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day           TEXT NOT NULL,
        requests      INTEGER NOT NULL DEFAULT 0,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day)
      );
    `);
  },
];

function runVersionedMigrations(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      MIGRATIONS[v](db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

export function resetDbForTests(): void {
  instance = null;
}
