/**
 * Shared types for @costlens/core.
 *
 * The extension and the dashboard server both consume these. The
 * underlying SQLite driver is intentionally abstract: core's
 * `CoreDatabase` type covers the methods we use from both
 * `node:sqlite`'s `DatabaseSync` and `bun:sqlite`'s `Database`, so
 * neither driver is imported here. See `core/src/db.ts` for the
 * adapter-side wiring.
 *
 * If a value lives in the SQLite schema as a column, its type is
 * defined here and reused by every read/write function. That way a
 * schema change touches one place, and adapters inherit the new
 * shape automatically.
 */

// ---------------------------------------------------------------------------
// SQLite driver abstraction
// ---------------------------------------------------------------------------

/**
 * Statement handle — covers `node:sqlite.Statement` and
 * `bun:sqlite.Statement`. Both expose `run` (write), `get` (read one
 * row), and `all` (read all rows).
 *
 * `changes` is `number` in `bun:sqlite` and `number | bigint` in
 * `node:sqlite` (depending on the row count). The wider union is
 * safe for both and lets adapters cast their native handle to
 * `CoreStatement` without a custom helper.
 */
export type CoreStatement = {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

/**
 * Database handle — covers `node:sqlite.DatabaseSync` and
 * `bun:sqlite.Database`. We use only `prepare` and `exec`; WAL mode
 * is enabled at the adapter layer.
 */
export type CoreDatabase = {
  prepare(sql: string): CoreStatement;
  exec(sql: string): void;
  close(): void;
};

// ---------------------------------------------------------------------------
// Domain types (mirrors of the SQLite schema)
// ---------------------------------------------------------------------------

/**
 * The costlens feature row. `id` is normally the git branch name;
 * `unassigned` is the synthetic feature for main / detached / no-git
 * and for branches whose feature is closed.
 */
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

/** Subset of `Feature` used in dashboard listings and the API. */
export type FeatureSummary = {
  id: string;
  name: string;
  cost: number;
  subagentCost: number;
  turns: number;
  status: string;
  tags: string[];
};

/**
 * One LLM assistant turn. `cost_unknown` is 1 if `usage.cost.total`
 * was 0 even though tokens were spent (model not in pi's pricing
 * table). `branch_path` is null in v1; the field is reserved for a
 * future "branch as it was at message time" feature.
 *
 * `source` tags the row with the tool that produced it
 * (`pi`, `opencode`, `claude-code`, `manual`, ...). Free-form
 * string, no enum constraint — adding a new tool is a config
 * change, not a schema change. The default for pre-phase-9 rows is
 * `pi` (every existing row came from pi, by definition).
 *
 * Phase 9 step 4 (MULTI-TOOL.md §7) added this column with
 * `ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'pi'`.
 * Schema v2 → v3.
 */
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
  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_write: number;
  cost_unknown: number;
  timestamp: string;
  branch_path: string | null;
  source: string;
};

/** Standalone note attached to a feature. */
export type Note = {
  id: number;
  body: string;
  created_at: string;
  feature_id: string;
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

export type ToolCall = {
  id: number;
  feature_id: string;
  message_id: string;
  tool_name: string;
  args_size: number | null;
  timestamp: string;
};

export type ToolCallSummary = {
  tool_name: string;
  calls: number;
};

/**
 * The `/api/overview` payload. Assembled in `core/db.ts`'s
 * `getOverview()` from a handful of aggregate queries. Excludes the
 * unassigned pool from totals (so "what have I spent on real
 * features" reads cleanly); unassigned still surfaces in
 * `byStatus.unassigned`.
 */
export type Overview = {
  totalCost: number;
  totalSubagentCost: number;
  totalTurns: number;
  totalFeatures: number;
  currentFeature: { id: string; name: string; cost: number; turns: number } | null;
  topFeatures: FeatureSummary[];
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

// ---------------------------------------------------------------------------
// Lifecycle errors
// ---------------------------------------------------------------------------

/**
 * Errors raised by the lifecycle write functions. The HTTP layer
 * maps these to JSON responses with the right status code; the
 * extension's `/feature` command maps them to `ctx.ui.notify` calls.
 *
 * Phase 7.5 added `BAD_REQUEST` for the dashboard's note-validation
 * path (empty / whitespace-only notes were silently dropped on the
 * extension side, but the dashboard surfaces a clear error instead).
 */
export class LifecycleError extends Error {
  constructor(
    public code: "NOT_FOUND" | "INVALID_STATE" | "UNASSIGNED" | "BAD_REQUEST",
    message: string
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type NotificationConfig = {
  enabled: boolean;
  thresholds: number[];
  webhook: string | null;
  dailyDigest: boolean;
  dailyDigestThresholdUsd: number;
};

export type CostlensConfig = {
  port: number;
  notifications: NotificationConfig;
};

// ---------------------------------------------------------------------------
// Git context (consumed by the extension; declared here so adapters
// can pass it into core functions without circular imports)
// ---------------------------------------------------------------------------

export type GitContext = {
  isRepo: boolean;
  branch: string | null;
  isMainBranch: boolean;
};

export type SessionCtx = {
  cwd: string;
  sessionFile: string | null;
  git: GitContext;
};
