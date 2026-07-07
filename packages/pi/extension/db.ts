/**
 * SQLite ledger for Costlens.
 *
 * Single-file DB at `~/.pi/costlens/ledger.db`. WAL mode for concurrent
 * reads (the Bun server reads while the extension writes).
 *
 * Uses Node's built-in `node:sqlite` (Node 22+) — no native compile, no
 * C++ toolchain, smaller install. Schema versioning via a `schema_version`
 * table; migrations run on init.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// `COSTLENS_HOME` lets tests point the ledger at a temp directory. In
// normal use it is undefined and we use `~/.pi/costlens/`.
const COSTLENS_DIR = process.env.COSTLENS_HOME
  ? join(process.env.COSTLENS_HOME, "costlens")
  : join(homedir(), ".pi", "costlens");
export const DB_PATH = join(COSTLENS_DIR, "ledger.db");

let _db: DatabaseSync | null = null;

/** Initialise (or return the already-open) DB. Idempotent. */
export function initDb(): DatabaseSync {
  if (_db) return _db;
  mkdirSync(COSTLENS_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  // WAL allows the Bun server to read while the extension writes.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  _db = db;
  return db;
}

export function getDb(): DatabaseSync {
  if (!_db) {
    throw new Error("Costlens: DB not initialised. Call initDb() first (e.g. from session_start).");
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// Schema is versioned monotonically. Each version's block is wrapped
// in a "CREATE ... IF NOT EXISTS" / "ALTER ... " pair that's safe to
// re-run against an already-migrated DB. The block stamps its version
// into `schema_version` only after the work is done.
const SCHEMA_VERSION = 2;

function migrate(db: DatabaseSync): void {
  // v1: original schema. All v1 objects are created here, idempotently.
  // The CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS guards
  // mean this block is a no-op on a v1+ DB that already has them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS features (
      id                TEXT    PRIMARY KEY,
      name              TEXT    NOT NULL,
      branch            TEXT,
      status            TEXT    NOT NULL CHECK (status IN ('open','done','abandoned','merged')),
      cap_usd           REAL,
      started_at        TEXT    NOT NULL,
      closed_at         TEXT,
      pricing_conf      TEXT    NOT NULL CHECK (pricing_conf IN ('complete','partial','unknown')),
      total_cost_usd    REAL    NOT NULL DEFAULT 0,
      total_input       INTEGER NOT NULL DEFAULT 0,
      total_output      INTEGER NOT NULL DEFAULT 0,
      total_cache_read  INTEGER NOT NULL DEFAULT 0,
      total_cache_write INTEGER NOT NULL DEFAULT 0,
      turn_count        INTEGER NOT NULL DEFAULT 0,
      first_activity_at TEXT,
      last_activity_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT    PRIMARY KEY,
      feature_id      TEXT    NOT NULL REFERENCES features(id),
      session_id      TEXT    NOT NULL,
      model           TEXT    NOT NULL,
      provider        TEXT    NOT NULL,
      input_tokens    INTEGER NOT NULL,
      output_tokens   INTEGER NOT NULL,
      cache_read      INTEGER NOT NULL,
      cache_write     INTEGER NOT NULL,
      cost_usd        REAL    NOT NULL,
      cost_input      REAL    NOT NULL,
      cost_output     REAL    NOT NULL,
      cost_cache_read REAL    NOT NULL,
      cost_cache_write REAL   NOT NULL,
      cost_unknown    INTEGER NOT NULL,
      timestamp       TEXT    NOT NULL,
      branch_path     TEXT
    );

    CREATE TABLE IF NOT EXISTS tags (
      feature_id TEXT NOT NULL REFERENCES features(id),
      tag        TEXT NOT NULL,
      PRIMARY KEY (feature_id, tag)
    );

    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id TEXT    NOT NULL REFERENCES features(id),
      body       TEXT    NOT NULL,
      created_at TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES features(id),
      cwd        TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_seen  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_feature    ON messages(feature_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp  ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_features_status     ON features(status);
  `);

  // v2: sub-agent + per-tool cost attribution (Phase 7).
  //  - features.subagent_cost_usd: pre-computed sum of sub-agent costs,
  //    so the dashboard and `/feature status` can read it without a JOIN
  //    + GROUP BY. Matches the existing pattern of pre-computed totals.
  //  - subagent_runs: one row per sub-agent invocation result. For
  //    "parallel" and "chain" modes, there are N rows per parent
  //    toolResult (linked by parent_message_id).
  //  - tool_calls: one row per non-Agent toolResult. Used for usage
  //    analytics (e.g. "how many Read calls per feature"). No cost
  //    because non-Agent tools don't burn LLM tokens.
  // All changes are guarded with `column_exists` / `IF NOT EXISTS` so
  // they're safe to re-run.
  const cols = db
    .prepare(`PRAGMA table_info(features)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "subagent_cost_usd")) {
    db.exec(
      `ALTER TABLE features ADD COLUMN subagent_cost_usd REAL NOT NULL DEFAULT 0`
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_runs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id        TEXT    NOT NULL REFERENCES features(id),
      parent_message_id TEXT    NOT NULL,
      agent             TEXT    NOT NULL,
      agent_source      TEXT    NOT NULL,
      model             TEXT,
      task              TEXT    NOT NULL,
      input_tokens      INTEGER NOT NULL,
      output_tokens     INTEGER NOT NULL,
      cache_read        INTEGER NOT NULL,
      cache_write       INTEGER NOT NULL,
      cost_usd          REAL    NOT NULL,
      turns             INTEGER NOT NULL,
      step              INTEGER,
      exit_code         INTEGER NOT NULL,
      stop_reason       TEXT,
      timestamp         TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id  TEXT    NOT NULL REFERENCES features(id),
      message_id  TEXT    NOT NULL,
      tool_name   TEXT    NOT NULL,
      args_size   INTEGER,
      timestamp   TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_subagent_feature  ON subagent_runs(feature_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_unique   ON subagent_runs(feature_id, parent_message_id, agent, COALESCE(step, -1));
    CREATE INDEX IF NOT EXISTS idx_subagent_agent    ON subagent_runs(agent);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_feature_name ON tool_calls(feature_id, tool_name);
  `);

  // Stamp schema version (idempotent — INSERT OR IGNORE on PK).
  db.prepare(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version    INTEGER PRIMARY KEY,
       applied_at TEXT    NOT NULL
     )`
  ).run();
  db.prepare(
    `INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))`
  ).run(SCHEMA_VERSION);
}
