/**
 * SQLite access layer for @costlens/core.
 *
 * Owns the schema, the migration logic, and all read/write queries.
 * Tool-agnostic: the same SQL runs against `node:sqlite.DatabaseSync`
 * (the extension) and `bun:sqlite.Database` (the dashboard server).
 * Both drivers expose the same surface we need (`prepare` / `exec`),
 * captured by the structural `CoreDatabase` / `CoreStatement` types
 * in `./types.ts`.
 *
 * Each process has its own connection. WAL mode (set at the adapter
 * layer) serialises writes between the extension and the server so
 * they never corrupt each other.
 *
 * Public API:
 *   - `setCoreDb(db)` / `getCoreDb()` / `closeCoreDb()` for the
 *     adapter to manage the process-local singleton.
 *   - `applySchema(db)` to bring a fresh DB up to the current schema
 *     version (idempotent).
 *   - Query functions: `getFeature`, `listFeatures`, `getAllFeatures`,
 *     `getNotes`, `getTags`, `getAllTags`, `getMessages`,
 *     `getRecentModels`, `getSubagentRuns`, `getSubagentSummary`,
 *     `getTopSubagents`, `getToolCalls`, `getToolCallCounts`,
 *     `searchFeatures`, `getOverview`, `exportLedger`, `exportLedgerCsv`.
 *   - Session mapping: `getSessionFeatureId`.
 *
 * The lifecycle state-mutation functions (close / cancel / merge /
 * reopen / setCap / addTag / removeTag / attachNote / insertSubagentRun /
 * insertToolCall / updateFeatureSubagentCost / etc.) live in
 * `lifecycle.ts`. This module is read-focused, with the exception of
 * session-mapping and the export helpers.
 */

import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  CoreDatabase,
  Feature,
  Message,
  Note,
  SubagentRun,
  SubagentSummary,
  ToolCall,
  ToolCallSummary,
  Overview,
} from "./types.js";

// ---------------------------------------------------------------------------
// Process-local DB singleton
// ---------------------------------------------------------------------------

let _db: CoreDatabase | null = null;

/**
 * Register the process-local DB. Each adapter (extension, server)
 * creates its own connection and calls this once at startup. After
 * that, every read/write function in core uses `getCoreDb()` to get
 * the same handle.
 */
export function setCoreDb(db: CoreDatabase): void {
  _db = db;
}

export function getCoreDb(): CoreDatabase {
  if (!_db) {
    throw new Error(
      "Costlens core: DB not initialised. Call setCoreDb() at startup (extension: initDb; server: openDb)."
    );
  }
  return _db;
}

export function closeCoreDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // best-effort
    }
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Costlens home + DB path
// ---------------------------------------------------------------------------

/**
 * Where the SQLite ledger lives. `COSTLENS_HOME` lets tests point the
 * ledger at a temp directory. In normal use it's undefined and we
 * use `~/.costlens/`.
 *
 * Phase 9 step 3 (MULTI-TOOL.md §6) will add lazy-on-read migration
 * from the old `~/.pi/costlens/` path.
 */
export const COSTLENS_DIR = process.env.COSTLENS_HOME
  ? join(process.env.COSTLENS_HOME, "costlens")
  : join(homedir(), ".costlens");

export const DB_PATH = join(COSTLENS_DIR, "ledger.db");

/**
 * Legacy path used by every pre-phase-9 user. Step 3 will rename it
 * on first read of the new path; until then, both paths coexist.
 */
export const LEGACY_DB_DIR = process.env.COSTLENS_HOME
  ? join(process.env.COSTLENS_HOME, "costlens")
  : join(homedir(), ".pi", "costlens");

export function getCostlensHome(): string {
  return COSTLENS_DIR;
}

export function getLegacyHome(): string {
  return LEGACY_DB_DIR;
}

export function getDbPath(): string {
  return DB_PATH;
}

/**
 * Make sure the directory exists. Called by the extension's `initDb`
 * before opening the DB; the server assumes the extension has run at
 * least once and does not auto-create.
 */
export function ensureCostlensHome(): void {
  mkdirSync(COSTLENS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Schema + migrations
// ---------------------------------------------------------------------------

/**
 * Schema version. Monotonically increasing.
 *
 *   v1: original features / messages / tags / notes / sessions
 *   v2: sub-agent + per-tool cost attribution (Phase 7)
 *
 * Phase 9 step 4 (MULTI-TOOL.md §7) bumps this to v3 to add
 * `messages.source` (the tool that produced each row).
 */
export const SCHEMA_VERSION = 2;

/**
 * Bring a SQLite database up to the current schema. Idempotent:
 * every block is guarded with `IF NOT EXISTS` or a column-existence
 * check, so re-running against an already-migrated DB is a no-op.
 *
 * Callers: the extension's `initDb()` (after WAL + foreign keys are
 * set); also exported for tests.
 */
export function applySchema(db: CoreDatabase): void {
  // v1: original schema. All v1 objects are created here, idempotently.
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

  // Stamp schema version (idempotent).
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version    INTEGER PRIMARY KEY,
       applied_at TEXT    NOT NULL
     )`
  );
  db.prepare(
    `INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, datetime('now'))`
  ).run(SCHEMA_VERSION);
}

// ---------------------------------------------------------------------------
// Feature reads
// ---------------------------------------------------------------------------

export function getFeature(id: string): Feature | undefined {
  const row = getCoreDb()
    .prepare(`SELECT * FROM features WHERE id = ?`)
    .get(id) as Feature | undefined;
  return row;
}

export function listFeatures(filter?: { status?: Feature["status"] }): Feature[] {
  const db = getCoreDb();
  if (filter?.status) {
    return db
      .prepare(
        `SELECT * FROM features WHERE status = ?
         ORDER BY COALESCE(last_activity_at, started_at) DESC`
      )
      .all(filter.status) as Feature[];
  }
  return db
    .prepare(
      `SELECT * FROM features
       ORDER BY COALESCE(last_activity_at, started_at) DESC`
    )
    .all() as Feature[];
}

export function getAllFeatures(): Feature[] {
  return getCoreDb()
    .prepare(
      `SELECT * FROM features
       ORDER BY COALESCE(last_activity_at, started_at) DESC`
    )
    .all() as Feature[];
}

/**
 * Map a session file to its feature id. Returns null if the session
 * has never been registered. The extension calls this on every
 * `message_end` to figure out which feature to book the cost to.
 */
export function getSessionFeatureId(sessionFile: string | undefined): string | null {
  if (!sessionFile) return null;
  const row = getCoreDb()
    .prepare(`SELECT feature_id FROM sessions WHERE id = ?`)
    .get(sessionFile) as { feature_id: string } | undefined;
  return row?.feature_id ?? null;
}

// ---------------------------------------------------------------------------
// Tag reads
// ---------------------------------------------------------------------------

export function getTags(featureId: string): string[] {
  return (
    getCoreDb()
      .prepare(`SELECT tag FROM tags WHERE feature_id = ? ORDER BY tag`)
      .all(featureId) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

export function getAllTags(): Array<{ tag: string; count: number }> {
  return getCoreDb()
    .prepare(
      `SELECT tag, COUNT(*) AS count
       FROM tags
       GROUP BY tag
       ORDER BY tag`
    )
    .all() as Array<{ tag: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Note reads
// ---------------------------------------------------------------------------

export function getNotes(featureId: string): Note[] {
  return getCoreDb()
    .prepare(
      `SELECT id, feature_id, body, created_at FROM notes
       WHERE feature_id = ? ORDER BY created_at ASC`
    )
    .all(featureId) as Note[];
}

// ---------------------------------------------------------------------------
// Message reads
// ---------------------------------------------------------------------------

export function getMessages(
  featureId: string,
  opts: { since?: string; limit?: number } = {}
): Message[] {
  const limit = opts.limit ?? 100;
  if (opts.since) {
    return getCoreDb()
      .prepare(
        `SELECT * FROM messages
         WHERE feature_id = ? AND timestamp > ?
         ORDER BY timestamp ASC LIMIT ?`
      )
      .all(featureId, opts.since, limit) as Message[];
  }
  return getCoreDb()
    .prepare(
      `SELECT * FROM messages
       WHERE feature_id = ?
       ORDER BY timestamp ASC LIMIT ?`
    )
    .all(featureId, limit) as Message[];
}

export function getRecentModels(featureId: string, limit = 3): string[] {
  return (
    getCoreDb()
      .prepare(
        `SELECT model FROM messages
         WHERE feature_id = ?
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(featureId, limit) as Array<{ model: string }>
  ).map((r) => r.model);
}

// ---------------------------------------------------------------------------
// Sub-agent reads
// ---------------------------------------------------------------------------

export function getSubagentRuns(featureId: string): SubagentRun[] {
  return getCoreDb()
    .prepare(
      `SELECT * FROM subagent_runs
       WHERE feature_id = ?
       ORDER BY timestamp ASC, id ASC`
    )
    .all(featureId) as SubagentRun[];
}

export function getSubagentSummary(featureId: string): SubagentSummary[] {
  return getCoreDb()
    .prepare(
      `SELECT
         agent,
         COUNT(*)             AS runs,
         SUM(cost_usd)        AS cost,
         SUM(turns)           AS turns,
         SUM(input_tokens)    AS input_tokens,
         SUM(output_tokens)   AS output_tokens
       FROM subagent_runs
       WHERE feature_id = ?
       GROUP BY agent
       ORDER BY cost DESC, runs DESC`
    )
    .all(featureId) as SubagentSummary[];
}

export function getTopSubagents(limit = 10): SubagentSummary[] {
  return getCoreDb()
    .prepare(
      `SELECT
         agent,
         COUNT(*)             AS runs,
         SUM(cost_usd)        AS cost,
         SUM(turns)           AS turns,
         SUM(input_tokens)    AS input_tokens,
         SUM(output_tokens)   AS output_tokens
       FROM subagent_runs
       WHERE feature_id != 'unassigned'
       GROUP BY agent
       ORDER BY cost DESC, runs DESC
       LIMIT ?`
    )
    .all(limit) as SubagentSummary[];
}

// ---------------------------------------------------------------------------
// Tool-call reads
// ---------------------------------------------------------------------------

export function getToolCalls(featureId: string): ToolCall[] {
  return getCoreDb()
    .prepare(
      `SELECT * FROM tool_calls
       WHERE feature_id = ?
       ORDER BY timestamp ASC, id ASC`
    )
    .all(featureId) as ToolCall[];
}

export function getToolCallCounts(featureId: string): ToolCallSummary[] {
  return getCoreDb()
    .prepare(
      `SELECT tool_name, COUNT(*) AS calls
       FROM tool_calls
       WHERE feature_id = ?
       GROUP BY tool_name
       ORDER BY calls DESC, tool_name ASC`
    )
    .all(featureId) as ToolCallSummary[];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Case-insensitive substring match on `id` and `name`. Uses `instr()`
 * so the query string is treated literally (no LIKE wildcards).
 */
export function searchFeatures(query: string): Feature[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return getCoreDb()
    .prepare(
      `SELECT * FROM features
       WHERE instr(LOWER(id), ?) > 0
          OR instr(LOWER(name), ?) > 0
       ORDER BY COALESCE(last_activity_at, started_at) DESC`
    )
    .all(q, q) as Feature[];
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export type LedgerExport = {
  exportedAt: string;
  features: Feature[];
  messages: Array<Record<string, unknown>>;
  notes: Array<{ id: number; feature_id: string; body: string; created_at: string }>;
  tags: Array<{ feature_id: string; tag: string }>;
  sessions: Array<{
    id: string;
    feature_id: string;
    cwd: string;
    started_at: string;
    last_seen: string;
  }>;
  subagent_runs: Array<Record<string, unknown>>;
  tool_calls: Array<Record<string, unknown>>;
};

/**
 * Dumps the full ledger as a plain object. Used by `/api/export.json`
 * and the extension's `/feature export json` command.
 */
export function exportLedger(): LedgerExport {
  const db = getCoreDb();
  return {
    exportedAt: new Date().toISOString(),
    features: db.prepare(`SELECT * FROM features ORDER BY id`).all() as Feature[],
    messages: db
      .prepare(
        `SELECT id, feature_id, session_id, model, provider,
                input_tokens, output_tokens, cache_read, cache_write,
                cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write,
                cost_unknown, timestamp, branch_path
         FROM messages ORDER BY feature_id, timestamp`
      )
      .all() as Array<Record<string, unknown>>,
    notes: db
      .prepare(`SELECT id, feature_id, body, created_at FROM notes ORDER BY id`)
      .all() as Array<{ id: number; feature_id: string; body: string; created_at: string }>,
    tags: db
      .prepare(`SELECT feature_id, tag FROM tags ORDER BY feature_id, tag`)
      .all() as Array<{ feature_id: string; tag: string }>,
    sessions: db
      .prepare(
        `SELECT id, feature_id, cwd, started_at, last_seen FROM sessions ORDER BY id`
      )
      .all() as Array<{ id: string; feature_id: string; cwd: string; started_at: string; last_seen: string }>,
    subagent_runs: db
      .prepare(
        `SELECT id, feature_id, parent_message_id, agent, agent_source, model, task,
                input_tokens, output_tokens, cache_read, cache_write, cost_usd,
                turns, step, exit_code, stop_reason, timestamp
         FROM subagent_runs ORDER BY feature_id, timestamp, id`
      )
      .all() as Array<Record<string, unknown>>,
    tool_calls: db
      .prepare(
        `SELECT id, feature_id, message_id, tool_name, args_size, timestamp
         FROM tool_calls ORDER BY feature_id, timestamp, id`
      )
      .all() as Array<Record<string, unknown>>,
  };
}

/**
 * Render the ledger as CSV. One section per table, separated by blank
 * lines, with a single comment line naming the table (e.g. `# features`).
 * Most CSV tools either ignore `#` lines or accept them as a row; for
 * full pipe-friendly output we keep the structure simple.
 */
export function exportLedgerCsv(): string {
  const data = exportLedger();
  const sections: string[] = [];
  sections.push(
    csvSection(
      "features",
      [
        "id", "name", "branch", "status", "cap_usd", "started_at", "closed_at",
        "pricing_conf", "total_cost_usd", "subagent_cost_usd", "total_input",
        "total_output", "total_cache_read", "total_cache_write", "turn_count",
        "first_activity_at", "last_activity_at",
      ],
      data.features as unknown as Array<Record<string, unknown>>
    )
  );
  sections.push(
    csvSection(
      "messages",
      [
        "id", "feature_id", "session_id", "model", "provider", "input_tokens",
        "output_tokens", "cache_read", "cache_write", "cost_usd", "cost_input",
        "cost_output", "cost_cache_read", "cost_cache_write", "cost_unknown",
        "timestamp", "branch_path",
      ],
      data.messages
    )
  );
  sections.push(csvSection("notes", ["id", "feature_id", "body", "created_at"], data.notes));
  sections.push(csvSection("tags", ["feature_id", "tag"], data.tags));
  sections.push(
    csvSection(
      "sessions",
      ["id", "feature_id", "cwd", "started_at", "last_seen"],
      data.sessions
    )
  );
  sections.push(
    csvSection(
      "subagent_runs",
      [
        "id", "feature_id", "parent_message_id", "agent", "agent_source", "model",
        "task", "input_tokens", "output_tokens", "cache_read", "cache_write",
        "cost_usd", "turns", "step", "exit_code", "stop_reason", "timestamp",
      ],
      data.subagent_runs
    )
  );
  sections.push(
    csvSection(
      "tool_calls",
      ["id", "feature_id", "message_id", "tool_name", "args_size", "timestamp"],
      data.tool_calls
    )
  );
  return sections.join("\n");
}

function csvSection(
  name: string,
  columns: string[],
  rows: Array<Record<string, unknown>>
): string {
  const lines: string[] = [`# ${name}`, columns.join(",")];
  for (const r of rows) {
    lines.push(columns.map((c) => csvCell(r[c])).join(","));
  }
  return lines.join("\n");
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  // Quote if the value contains a comma, quote, or newline. Escape
  // embedded quotes by doubling them (RFC 4180).
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/**
 * Aggregates the dashboard's overview payload. Excludes the
 * unassigned pool from `totalCost` / `totalTurns` / `topFeatures` /
 * `topSubagents` so the "what have I spent on real features" number
 * is clean. Unassigned still surfaces in `byStatus.unassigned`.
 */
export function getOverview(): Overview {
  const db = getCoreDb();

  const totalRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(total_cost_usd), 0) AS cost,
         COALESCE(SUM(turn_count), 0)     AS turns
       FROM features
       WHERE id != 'unassigned'`
    )
    .get() as { cost: number; turns: number };

  const totalFeatures = (
    db.prepare(`SELECT COUNT(*) AS c FROM features`).get() as { c: number }
  ).c;

  const currentRow = db
    .prepare(
      `SELECT id, name, total_cost_usd AS cost, turn_count AS turns
       FROM features
       WHERE status = 'open' AND id != 'unassigned'
       ORDER BY COALESCE(last_activity_at, started_at) DESC
       LIMIT 1`
    )
    .get() as { id: string; name: string; cost: number; turns: number } | undefined;

  const topFeatures = db
    .prepare(
      `SELECT id, name, total_cost_usd AS cost, subagent_cost_usd AS subagentCost,
              turn_count AS turns, status,
              (SELECT GROUP_CONCAT(tag, ',')
                 FROM tags
                 WHERE tags.feature_id = features.id
                 ORDER BY tag) AS tags_csv
       FROM features
       WHERE id != 'unassigned'
       ORDER BY total_cost_usd DESC
       LIMIT 5`
    )
    .all() as Array<{
    id: string;
    name: string;
    cost: number;
    subagentCost: number;
    turns: number;
    status: string;
    tags_csv: string | null;
  }>;

  const topSubagents = db
    .prepare(
      `SELECT
         agent,
         COUNT(*)             AS runs,
         SUM(cost_usd)        AS cost,
         SUM(turns)           AS turns,
         SUM(input_tokens)    AS input_tokens,
         SUM(output_tokens)   AS output_tokens
       FROM subagent_runs
       WHERE feature_id != 'unassigned'
       GROUP BY agent
       ORDER BY cost DESC, runs DESC
       LIMIT 5`
    )
    .all() as Array<{
    agent: string;
    runs: number;
    cost: number;
    turns: number;
    input_tokens: number;
    output_tokens: number;
  }>;

  const totalSubagentRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost
       FROM subagent_runs
       WHERE feature_id != 'unassigned'`
    )
    .get() as { cost: number };

  // byDay covers the last 30 days; missing days are filled with zeros
  // so the chart has a continuous x-axis.
  const byDayRows = db
    .prepare(
      `SELECT date(timestamp) AS date,
              SUM(cost_usd)   AS cost,
              COUNT(*)        AS turns
       FROM messages
       WHERE timestamp >= date('now', '-30 days')
       GROUP BY date(timestamp)`
    )
    .all() as Array<{ date: string; cost: number; turns: number }>;
  const dayMap = new Map(byDayRows.map((r) => [r.date, r]));
  const byDay: Array<{ date: string; cost: number; turns: number }> = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const row = dayMap.get(key);
    byDay.push({ date: key, cost: row?.cost ?? 0, turns: row?.turns ?? 0 });
  }

  const byModel = db
    .prepare(
      `SELECT model,
              SUM(cost_usd)      AS cost,
              COUNT(*)           AS turns,
              SUM(input_tokens)  AS inputTokens,
              SUM(output_tokens) AS outputTokens
       FROM messages
       GROUP BY model
       ORDER BY cost DESC`
    )
    .all() as Array<{
    model: string;
    cost: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
  }>;

  const statusRows = db
    .prepare(`SELECT status, COUNT(*) AS c FROM features GROUP BY status`)
    .all() as Array<{ status: string; c: number }>;
  const unassignedCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM features WHERE id = 'unassigned'`)
      .get() as { c: number }
  ).c;
  const byStatus = {
    open: 0,
    done: 0,
    abandoned: 0,
    merged: 0,
    unassigned: 0,
  };
  for (const row of statusRows) {
    if (row.status in byStatus && row.status !== "unassigned") {
      (byStatus as Record<string, number>)[row.status] = row.c;
    }
  }
  byStatus.unassigned = unassignedCount;

  return {
    totalCost: totalRow.cost,
    totalSubagentCost: totalSubagentRow.cost,
    totalTurns: totalRow.turns,
    totalFeatures,
    currentFeature: currentRow ?? null,
    topFeatures: topFeatures.map((f) => ({
      id: f.id,
      name: f.name,
      cost: f.cost,
      subagentCost: f.subagentCost ?? 0,
      turns: f.turns,
      status: f.status,
      tags: f.tags_csv ? f.tags_csv.split(",") : [],
    })),
    topSubagents: topSubagents.map((s) => ({
      agent: s.agent,
      runs: s.runs,
      cost: s.cost,
      turns: s.turns,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
    })),
    byDay,
    byModel,
    byStatus,
  };
}
