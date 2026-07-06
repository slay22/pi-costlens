/**
 * Read-only SQLite access for the Costlens dashboard server (Bun).
 *
 * Uses `bun:sqlite` with `readonly: true` and `fileMustExist: true`. The
 * extension's writes happen against the same DB in WAL mode, so the
 * server never blocks the writer and vice versa.
 *
 * All query functions throw on schema errors. The HTTP layer maps those
 * to 500s; missing features return `undefined` and become 404s.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCostlensHome } from "./config.js";

const COSTLENS_HOME = getCostlensHome();
export const DB_PATH = join(COSTLENS_HOME, "ledger.db");

export type Feature = {
  id: string;
  name: string;
  branch: string | null;
  status: "open" | "done" | "abandoned" | "merged";
  cap_usd: number | null;
  started_at: string;
  closed_at: string | null;
  pricing_conf: "complete" | "partial" | "unknown";
  total_cost_usd: number;
  subagent_cost_usd: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write: number;
  turn_count: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
};

export type SubagentRun = {
  id: number;
  feature_id: string;
  parent_message_id: string;
  agent: string;
  agent_source: "user" | "project" | "unknown";
  model: string | null;
  task: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  turns: number;
  step: number | null;
  exit_code: number;
  stop_reason: string | null;
  timestamp: string;
};

export type SubagentSummary = {
  agent: string;
  runs: number;
  cost: number;
  turns: number;
  input_tokens: number;
  output_tokens: number;
};

export type ToolCallSummary = {
  tool_name: string;
  calls: number;
};

export type Message = {
  id: string;
  feature_id: string;
  session_id: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  timestamp: string;
};

export type Note = { id: number; body: string; created_at: string };

export type Overview = {
  totalCost: number;
  totalSubagentCost: number;
  totalTurns: number;
  totalFeatures: number;
  currentFeature: { id: string; name: string; cost: number; turns: number } | null;
  topFeatures: Array<{
    id: string;
    name: string;
    cost: number;
    subagentCost: number;
    turns: number;
    status: string;
    tags: string[];
  }>;
  topSubagents: SubagentSummary[];
  byDay: Array<{ date: string; cost: number; turns: number }>;
  byModel: Array<{
    model: string;
    cost: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byStatus: {
    open: number;
    done: number;
    abandoned: number;
    merged: number;
    unassigned: number;
  };
};

let _db: Database | null = null;

export function openDb(path: string = DB_PATH): Database {
  if (_db) return _db;
  if (!existsSync(path)) {
    throw new Error(
      `Costlens DB not found at ${path}; has the extension been run yet?`
    );
  }
  // `readonly: true` so the server can never write. (Bun's
  // DatabaseSync doesn't accept `fileMustExist` — if the path is wrong
  // or missing, the open call will throw with a clear error.)
  _db = new Database(path, { readonly: true });
  return _db;
}

export function getDb(): Database {
  if (!_db) throw new Error("DB not opened; call openDb() first");
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export function getAllFeatures(): Feature[] {
  return getDb()
    .prepare(
      `SELECT * FROM features
       ORDER BY COALESCE(last_activity_at, started_at) DESC`
    )
    .all() as Feature[];
}

/**
 * Case-insensitive substring match on `id` and `name`. Uses `instr()`
 * so the query string is treated literally (no LIKE wildcards).
 */
export function searchFeatures(query: string): Feature[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return getDb()
    .prepare(
      `SELECT * FROM features
       WHERE instr(LOWER(id), ?) > 0
          OR instr(LOWER(name), ?) > 0
       ORDER BY COALESCE(last_activity_at, started_at) DESC`
    )
    .all(q, q) as Feature[];
}

/**
 * All unique tags across the ledger, sorted, with the count of features
 * carrying each tag. Mirrors `lifecycle.listAllTags()` for the read-only
 * server side.
 */
export function getAllTags(): Array<{ tag: string; count: number }> {
  return getDb()
    .prepare(
      `SELECT tag, COUNT(*) AS count
       FROM tags
       GROUP BY tag
       ORDER BY tag`
    )
    .all() as Array<{ tag: string; count: number }>;
}

/**
 * Dumps the full ledger as a plain object. Same shape as the extension
 * side's `exportLedger()`. Used by both `/api/export.json` and the
 * dashboard's export button.
 */
export type LedgerExport = {
  exportedAt: string;
  features: Feature[];
  messages: Array<Record<string, unknown>>;
  notes: Array<{ id: number; feature_id: string; body: string; created_at: string }>;
  tags: Array<{ feature_id: string; tag: string }>;
  sessions: Array<{ id: string; feature_id: string; cwd: string; started_at: string; last_seen: string }>;
  subagent_runs: Array<Record<string, unknown>>;
  tool_calls: Array<Record<string, unknown>>;
};

export function exportLedger(): LedgerExport {
  const db = getDb();
  return {
    exportedAt: new Date().toISOString(),
    features: db
      .prepare(`SELECT * FROM features ORDER BY id`)
      .all() as Feature[],
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
 * Render the ledger as CSV. Mirrors the extension side's
 * `exportLedgerCsv()`. One section per table, separated by blank lines,
 * with a leading `# <name>` marker per section.
 */
export function exportLedgerCsv(): string {
  const data = exportLedger();
  const sections: string[] = [];
  sections.push(
    csvSection("features", [
      "id", "name", "branch", "status", "cap_usd", "started_at", "closed_at",
      "pricing_conf", "total_cost_usd", "subagent_cost_usd", "total_input",
      "total_output", "total_cache_read", "total_cache_write", "turn_count",
      "first_activity_at", "last_activity_at",
    ], data.features as unknown as Array<Record<string, unknown>>)
  );
  sections.push(
    csvSection("messages", [
      "id", "feature_id", "session_id", "model", "provider", "input_tokens",
      "output_tokens", "cache_read", "cache_write", "cost_usd", "cost_input",
      "cost_output", "cost_cache_read", "cost_cache_write", "cost_unknown",
      "timestamp", "branch_path",
    ], data.messages)
  );
  sections.push(
    csvSection("notes", ["id", "feature_id", "body", "created_at"], data.notes)
  );
  sections.push(
    csvSection("tags", ["feature_id", "tag"], data.tags)
  );
  sections.push(
    csvSection("sessions", ["id", "feature_id", "cwd", "started_at", "last_seen"], data.sessions)
  );
  sections.push(
    csvSection("subagent_runs", [
      "id", "feature_id", "parent_message_id", "agent", "agent_source", "model",
      "task", "input_tokens", "output_tokens", "cache_read", "cache_write",
      "cost_usd", "turns", "step", "exit_code", "stop_reason", "timestamp",
    ], data.subagent_runs)
  );
  sections.push(
    csvSection("tool_calls", [
      "id", "feature_id", "message_id", "tool_name", "args_size", "timestamp",
    ], data.tool_calls)
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
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function getFeature(id: string): Feature | null {
  const row = getDb()
    .prepare(`SELECT * FROM features WHERE id = ?`)
    .get(id) as Feature | null;
  return row ?? null;
}

export function getNotes(featureId: string): Note[] {
  return getDb()
    .prepare(
      `SELECT id, body, created_at FROM notes
       WHERE feature_id = ? ORDER BY created_at ASC`
    )
    .all(featureId) as Note[];
}

export function getTags(featureId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT tag FROM tags WHERE feature_id = ? ORDER BY tag`)
      .all(featureId) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

export function getRecentModels(featureId: string, limit = 3): string[] {
  return (
    getDb()
      .prepare(
        `SELECT model FROM messages
         WHERE feature_id = ?
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(featureId, limit) as Array<{ model: string }>
  ).map((r) => r.model);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function getMessages(
  featureId: string,
  opts: { since?: string; limit?: number } = {}
): Message[] {
  const limit = opts.limit ?? 100;
  if (opts.since) {
    return getDb()
      .prepare(
        `SELECT * FROM messages
         WHERE feature_id = ? AND timestamp > ?
         ORDER BY timestamp ASC LIMIT ?`
      )
      .all(featureId, opts.since, limit) as Message[];
  }
  return getDb()
    .prepare(
      `SELECT * FROM messages
       WHERE feature_id = ?
       ORDER BY timestamp ASC LIMIT ?`
    )
    .all(featureId, limit) as Message[];
}

// ---------------------------------------------------------------------------
// Sub-agents + tool calls (Phase 7)
// ---------------------------------------------------------------------------

/** All sub-agent runs for a single feature, in chronological order. */
export function getSubagentRuns(featureId: string): SubagentRun[] {
  return getDb()
    .prepare(
      `SELECT * FROM subagent_runs
       WHERE feature_id = ?
       ORDER BY timestamp ASC, id ASC`
    )
    .all(featureId) as SubagentRun[];
}

/** Per-agent aggregation for a single feature, ordered by cost desc. */
export function getSubagentSummary(featureId: string): SubagentSummary[] {
  return getDb()
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

/**
 * Cross-feature aggregation of sub-agent runs. Excludes the unassigned
 * pool. Used by the overview "top sub-agents" table and the
 * `/api/subagents/top` endpoint.
 */
export function getTopSubagents(limit = 10): SubagentSummary[] {
  return getDb()
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

/** Per-tool call counts for a single feature, ordered by count desc. */
export function getToolCallCounts(featureId: string): ToolCallSummary[] {
  return getDb()
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
// Overview
// ---------------------------------------------------------------------------

export function getOverview(): Overview {
  const db = getDb();

  // Excludes unassigned from the totals so the "what have I spent on
  // actual features" number is clean. The byStatus.unassigned field
  // still surfaces that data separately.
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
    .get() as
    | { id: string; name: string; cost: number; turns: number }
    | undefined;

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

  // Sub-agent rollup across the whole ledger (excludes unassigned).
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
