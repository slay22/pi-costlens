/**
 * Feature lifecycle — the data plane.
 *
 * Phase 9 step 2: this consolidates the two pre-step-2 duplicates
 * (extension/lifecycle.ts and server/lifecycle.ts) into one tool-
 * agnostic module. Both adapters now call the same functions; the
 * only difference between them is which SQLite driver they use to
 * construct the connection.
 *
 * What this module owns:
 *   - Session lifecycle: ensureFeatureForSession (resume, create,
 *     refuse-to-resume-closed), setActiveFeature, getActiveFeatureId.
 *   - State mutations: closeFeature, cancelFeature, mergeFeature,
 *     reopenFeature, renameFeature, setCap.
 *   - Notes: attachNote (idempotent, accepts the dashboard's stricter
 *     BAD_REQUEST validation; the extension's silent-trim behavior
 *     is preserved by treating whitespace-only bodies as a no-op
 *     when called without a UI).
 *   - Tags: addTag, removeTag, listTags, listAllTags.
 *   - Sub-agent / tool-call writes: insertSubagentRun,
 *     updateFeatureSubagentCost, insertToolCall.
 *   - Message bookkeeping: recordMessageAndUpdateFeature (the
 *     INSERT + feature-totals recompute that the extension's
 *     message_end hook does in a single transaction).
 *
 * What does NOT live here:
 *   - The pi `ExtensionContext` shape and `ctx.ui.*` calls (those
 *     stay in the pi adapter).
 *   - The HTTP request → LifecycleError mapping (that lives in
 *     `core/server/api.ts`).
 *   - The slash-command parser (that lives in the pi adapter's
 *     `commands.ts`).
 */

import { getCoreDb } from "./db.js";
import { getFeature as readFeature } from "./db.js";
import {
  type Feature,
  type GitContext,
  type SessionCtx,
  LifecycleError,
} from "./types.js";

// Re-export so adapters can import LifecycleError alongside the
// functions that throw it.
export { LifecycleError } from "./types.js";

// ---------------------------------------------------------------------------
// Module-level active-feature cache
// ---------------------------------------------------------------------------

/**
 * Per-process cache of the feature that the running session is
 * currently booked to. The extension's session_start calls
 * `setActiveFeature(featureId, git)`; the rest of the adapter
 * (footer, notifications) reads `getActiveFeatureId()`.
 *
 * The server doesn't set this — its reads are request-scoped via
 * `getSessionFeatureId(sessionFile)`.
 */
let _activeFeatureId: string | null = null;
let _activeGit: GitContext | null = null;

export function getActiveFeatureId(): string | null {
  return _activeFeatureId;
}

export function getActiveGit(): GitContext | null {
  return _activeGit;
}

export function setActiveFeature(featureId: string, git: GitContext): void {
  _activeFeatureId = featureId;
  _activeGit = git;
}

/** Reset the module-level cache. Tests only. */
export function _resetForTest(): void {
  _activeFeatureId = null;
  _activeGit = null;
}

// ---------------------------------------------------------------------------
// Branch → feature mapping
// ---------------------------------------------------------------------------

export const UNASSIGNED_ID = "unassigned";
const MAIN_BRANCHES = new Set(["main", "master", "develop", "dev"]);

export function featureIdFor(git: GitContext): string {
  if (!git.isRepo || git.branch === null || MAIN_BRANCHES.has(git.branch)) {
    return UNASSIGNED_ID;
  }
  return git.branch;
}

/**
 * Open or resume a feature for a session:
 *   - if the feature exists and is `open` → resume (no prompt, just
 *     bump `last_activity_at`);
 *   - if the feature exists and is closed (done / abandoned / merged)
 *     → do NOT resume; return `unassigned`;
 *   - if the feature does not exist → if `prompt` returns true (or
 *     there's no UI), create it. Otherwise return `unassigned`.
 *
 * Always writes the `sessions` row mapping the session file → the
 * returned feature id, so the next event hook can find it via
 * `getSessionFeatureId(sessionFile)`.
 *
 * Returns the resolved feature id (either `desiredId` or
 * `unassigned`). The caller is responsible for calling
 * `setActiveFeature` with the result.
 */
export async function ensureFeatureForSession(
  ctx: SessionCtx,
  prompt: () => Promise<boolean>
): Promise<string> {
  const db = getCoreDb();
  const desiredId = featureIdFor(ctx.git);
  const now = new Date().toISOString();

  let resolvedId = UNASSIGNED_ID;

  if (desiredId === UNASSIGNED_ID) {
    resolvedId = UNASSIGNED_ID;
  } else {
    const existing = readFeature(desiredId);
    if (!existing) {
      const ok = await prompt();
      if (ok) {
        db.prepare(
          `INSERT INTO features
             (id, name, branch, status, pricing_conf,
              started_at, first_activity_at, last_activity_at)
           VALUES
             (?, ?, ?, 'open', 'unknown', ?, ?, ?)`
        ).run(desiredId, desiredId, ctx.git.branch, now, now, now);
        resolvedId = desiredId;
      } else {
        resolvedId = UNASSIGNED_ID;
      }
    } else if (existing.status === "open") {
      db.prepare(`UPDATE features SET last_activity_at = ? WHERE id = ?`).run(
        now,
        desiredId
      );
      resolvedId = desiredId;
    } else {
      // Closed feature on this branch — don't auto-resume.
      resolvedId = UNASSIGNED_ID;
    }
  }

  if (resolvedId === UNASSIGNED_ID) {
    const u = readFeature(UNASSIGNED_ID);
    if (!u) {
      db.prepare(
        `INSERT INTO features
           (id, name, branch, status, pricing_conf,
            started_at, first_activity_at, last_activity_at)
         VALUES
           (?, 'unassigned', NULL, 'open', 'unknown', ?, ?, ?)`
      ).run(UNASSIGNED_ID, now, now, now);
    } else {
      db.prepare(`UPDATE features SET last_activity_at = ? WHERE id = ?`).run(
        now,
        UNASSIGNED_ID
      );
    }
  }

  if (ctx.sessionFile) {
    db.prepare(
      `INSERT INTO sessions (id, feature_id, cwd, started_at, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         feature_id = excluded.feature_id,
         last_seen  = excluded.last_seen`
    ).run(ctx.sessionFile, resolvedId, ctx.cwd, now, now);
  }

  return resolvedId;
}

// ---------------------------------------------------------------------------
// State mutations (close / cancel / rename / setCap / reopen / merge)
// ---------------------------------------------------------------------------

/**
 * Mark a feature `done`. Optionally attach a note in the same
 * transaction so the close + note commit atomically. The extension
 * uses this via `/feature close <id> [note]`; the dashboard uses
 * this from the close button.
 */
export function closeFeature(featureId: string, note?: string): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot close the unassigned pool.");
  }
  const f = readFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (f.status !== "open") {
    throw new LifecycleError(
      "INVALID_STATE",
      `Feature "${featureId}" is already ${f.status}; close it with /feature reopen first, or it's already terminal.`
    );
  }
  const now = new Date().toISOString();
  const db = getCoreDb();
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE features SET status = 'done', closed_at = ? WHERE id = ?`).run(
      now,
      featureId
    );
    if (note && note.trim()) {
      db.prepare(
        `INSERT INTO notes (feature_id, body, created_at) VALUES (?, ?, ?)`
      ).run(featureId, note.trim(), now);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // best-effort
    }
    throw err;
  }
  return readFeature(featureId)!;
}

/** Mark a feature `abandoned`. Same note-on-close semantics as close. */
export function cancelFeature(featureId: string, note?: string): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot cancel the unassigned pool.");
  }
  const f = readFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (f.status !== "open") {
    throw new LifecycleError(
      "INVALID_STATE",
      `Feature "${featureId}" is already ${f.status}.`
    );
  }
  const now = new Date().toISOString();
  const db = getCoreDb();
  db.exec("BEGIN");
  try {
    db.prepare(
      `UPDATE features SET status = 'abandoned', closed_at = ? WHERE id = ?`
    ).run(now, featureId);
    if (note && note.trim()) {
      db.prepare(
        `INSERT INTO notes (feature_id, body, created_at) VALUES (?, ?, ?)`
      ).run(featureId, note.trim(), now);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // best-effort
    }
    throw err;
  }
  return readFeature(featureId)!;
}

/**
 * Mark a feature `merged` — the branch was merged but feature work
 * may continue. Freezes cost (`closed_at` is set) but the status is
 * semantically distinct from `done` (work completed) and `abandoned`
 * (work dropped). Reopen via `/feature reopen` or the dashboard's
 * Reopen button works the same as for done/abandoned.
 */
export function mergeFeature(featureId: string, note?: string): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot merge the unassigned pool.");
  }
  const f = readFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (f.status !== "open") {
    throw new LifecycleError(
      "INVALID_STATE",
      `Feature "${featureId}" is already ${f.status}; reopen it first if you want to merge again.`
    );
  }
  const now = new Date().toISOString();
  const db = getCoreDb();
  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE features SET status = 'merged', closed_at = ? WHERE id = ?`).run(
      now,
      featureId
    );
    if (note && note.trim()) {
      db.prepare(
        `INSERT INTO notes (feature_id, body, created_at) VALUES (?, ?, ?)`
      ).run(featureId, note.trim(), now);
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // best-effort
    }
    throw err;
  }
  return readFeature(featureId)!;
}

/** Restore a closed/cancelled/merged feature to `open`. */
export function reopenFeature(featureId: string): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot reopen the unassigned pool.");
  }
  const f = readFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (f.status === "open") {
    throw new LifecycleError("INVALID_STATE", `Feature "${featureId}" is already open.`);
  }
  getCoreDb()
    .prepare(`UPDATE features SET status = 'open', closed_at = NULL WHERE id = ?`)
    .run(featureId);
  return readFeature(featureId)!;
}

export function renameFeature(featureId: string, newName: string): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot rename the unassigned pool.");
  }
  const trimmed = newName.trim();
  if (!trimmed) {
    throw new LifecycleError("INVALID_STATE", "New name cannot be empty.");
  }
  const f = readFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  getCoreDb().prepare(`UPDATE features SET name = ? WHERE id = ?`).run(trimmed, featureId);
  return readFeature(featureId)!;
}

/**
 * Set or clear the cap. `null` (or `0`) clears the cap. Negative
 * numbers are a validation error. Returns the updated Feature.
 */
export function setCap(featureId: string, capUsd: number | null): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot set a cap on the unassigned pool.");
  }
  if (capUsd !== null && (isNaN(capUsd) || capUsd < 0)) {
    throw new LifecycleError("BAD_REQUEST", "Cap must be a non-negative number, or null to clear.");
  }
  const f = readFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  const resolved = capUsd === null || capUsd === 0 ? null : capUsd;
  getCoreDb().prepare(`UPDATE features SET cap_usd = ? WHERE id = ?`).run(resolved, featureId);
  return readFeature(featureId)!;
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * Append a standalone note.
 *
 * The dashboard surfaces empty / whitespace-only notes as
 * `BAD_REQUEST` so the user gets a clear error. The extension
 * silently drops them (preserves the pre-phase-7.5 behavior). To
 * preserve both, this function returns the inserted row when the
 * body is non-empty, or `null` when it's empty / whitespace-only.
 * Adapters decide how to communicate the no-op.
 */
export function attachNote(
  featureId: string,
  body: string,
  opts: { strict?: boolean } = {}
): { id: number; body: string; created_at: string; feature_id: string } | null {
  const trimmed = body.trim();
  if (!trimmed) {
    if (opts.strict) {
      throw new LifecycleError("BAD_REQUEST", "Note body cannot be empty.");
    }
    return null;
  }
  const f = readFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  const now = new Date().toISOString();
  const db = getCoreDb();
  const res = db
    .prepare(`INSERT INTO notes (feature_id, body, created_at) VALUES (?, ?, ?)`)
    .run(featureId, trimmed, now);
  return {
    id: Number(res.lastInsertRowid),
    body: trimmed,
    created_at: now,
    feature_id: featureId,
  };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Lowercase + trim + collapse internal whitespace. */
function normaliseTag(rawTag: string): string {
  return rawTag.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Add a tag. Returns the normalised tag value so the API / UI can
 * echo it back. PK is `(feature_id, tag)` so duplicates are a no-op.
 */
export function addTag(featureId: string, rawTag: string): string {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot tag the unassigned pool.");
  }
  const tag = normaliseTag(rawTag);
  if (!tag) {
    throw new LifecycleError("BAD_REQUEST", "Tag cannot be empty.");
  }
  const f = readFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  getCoreDb()
    .prepare(`INSERT OR IGNORE INTO tags (feature_id, tag) VALUES (?, ?)`)
    .run(featureId, tag);
  return tag;
}

/**
 * Remove a tag. No-op if the tag isn't set. Returns the current
 * sorted tag list for the feature (so the API can return it without
 * a second round-trip). The server's pre-step-2 version returned
 * the list; the extension's pre-step-2 version returned a boolean.
 * To keep both, we return the list and let the extension translate.
 */
export function removeTag(featureId: string, rawTag: string): string[] {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot untag the unassigned pool.");
  }
  const tag = normaliseTag(rawTag);
  const f = readFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (tag) {
    getCoreDb()
      .prepare(`DELETE FROM tags WHERE feature_id = ? AND tag = ?`)
      .run(featureId, tag);
  }
  return (
    getCoreDb()
      .prepare(`SELECT tag FROM tags WHERE feature_id = ? ORDER BY tag`)
      .all(featureId) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

/** Sorted list of tags for a single feature. */
export function listTags(featureId: string): string[] {
  return (
    getCoreDb()
      .prepare(`SELECT tag FROM tags WHERE feature_id = ? ORDER BY tag`)
      .all(featureId) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

// ---------------------------------------------------------------------------
// Sub-agent + tool-call writes
// ---------------------------------------------------------------------------

export type SubagentRunInsert = {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  model?: string;
  task: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
  step?: number;
  exitCode: number;
  stopReason?: string;
};

/**
 * Insert a single sub-agent run row. Idempotent: the unique index
 * `(feature_id, parent_message_id, agent, COALESCE(step, -1))` makes
 * the insert a no-op when the same result is re-emitted (e.g. on
 * session reload). Returns `true` if a new row was inserted, `false`
 * if the insert was ignored.
 */
export function insertSubagentRun(
  featureId: string,
  parentMessageId: string,
  r: SubagentRunInsert,
  ts?: string
): boolean {
  const timestamp = ts ?? new Date().toISOString();
  const res = getCoreDb()
    .prepare(
      `INSERT OR IGNORE INTO subagent_runs (
         feature_id, parent_message_id, agent, agent_source, model, task,
         input_tokens, output_tokens, cache_read, cache_write, cost_usd,
         turns, step, exit_code, stop_reason, timestamp
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      featureId,
      parentMessageId,
      r.agent,
      r.agentSource,
      r.model ?? null,
      r.task.slice(0, 200),
      r.usage.input,
      r.usage.output,
      r.usage.cacheRead,
      r.usage.cacheWrite,
      r.usage.cost,
      r.usage.turns,
      r.step ?? null,
      r.exitCode,
      r.stopReason ?? null,
      timestamp
    );
  return res.changes > 0;
}

/**
 * Insert a single tool-call row. No unique guard — duplicate inserts
 * are fine because tool calls are not aggregated by id; the
 * dashboard shows counts via `getToolCallCounts`, not a list of every
 * call. Returns the inserted rowid (for tests).
 */
export function insertToolCall(
  featureId: string,
  messageId: string,
  toolName: string,
  argsSize: number | null,
  ts?: string
): number {
  const timestamp = ts ?? new Date().toISOString();
  const res = getCoreDb()
    .prepare(
      `INSERT INTO tool_calls
         (feature_id, message_id, tool_name, args_size, timestamp)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(featureId, messageId, toolName, argsSize, timestamp);
  return Number(res.lastInsertRowid);
}

/**
 * After inserting (or re-counting) subagent_runs for a feature, update
 * the parent feature's `subagent_cost_usd` pre-computed total. Matches
 * the pattern used for `total_cost_usd` after message inserts.
 */
export function updateFeatureSubagentCost(featureId: string): number {
  const db = getCoreDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost
       FROM subagent_runs
       WHERE feature_id = ?`
    )
    .get(featureId) as { cost: number };
  db.prepare(`UPDATE features SET subagent_cost_usd = ? WHERE id = ?`).run(
    row.cost,
    featureId
  );
  return row.cost;
}

// ---------------------------------------------------------------------------
// Message bookkeeping (extension's message_end hook)
// ---------------------------------------------------------------------------

export type MessageInsert = {
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
  /**
   * The tool that produced this row. Phase 9 step 4 (MULTI-TOOL.md
   * §7). Free-form string: `pi`, `opencode`, `claude-code`,
   * `manual`, ... Adapters pass their own source; the column has
   * a `DEFAULT 'pi'` for the v2→v3 migration but the insert path
   * always sets it explicitly.
   */
  source: string;
};

/**
 * Insert a `messages` row and recompute the parent feature's
 * pre-computed totals in a single transaction. Idempotent on the
 * `messages.id` PK (uses `INSERT OR REPLACE`).
 *
 * This is the function the extension's `message_end` hook calls on
 * every assistant message. The `feature_id` and `timestamp` are
 * already-known values (the active feature id and the message's
 * `msg.timestamp`); passing them in keeps core free of any pi
 * dependency.
 */
export function recordMessageAndUpdateFeature(m: MessageInsert): void {
  const db = getCoreDb();
  db.exec("BEGIN");
  try {
    // Use positional ? params for cross-driver compatibility.
    // node:sqlite supports @name; bun:sqlite uses $name but requires
    // the $ prefix in the object key. Positional ? works in both.
    db.prepare(
      `INSERT OR REPLACE INTO messages (
         id, feature_id, session_id, model, provider,
         input_tokens, output_tokens, cache_read, cache_write,
         cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write,
         cost_unknown, timestamp, branch_path, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      m.id, m.feature_id, m.session_id, m.model, m.provider,
      m.input_tokens, m.output_tokens, m.cache_read, m.cache_write,
      m.cost_usd, m.cost_input, m.cost_output, m.cost_cache_read, m.cost_cache_write,
      m.cost_unknown, m.timestamp, m.branch_path, m.source
    );
    db.prepare(
      `UPDATE features
       SET
         total_cost_usd    = COALESCE((SELECT SUM(cost_usd)        FROM messages WHERE feature_id = ?), 0),
         total_input       = COALESCE((SELECT SUM(input_tokens)    FROM messages WHERE feature_id = ?), 0),
         total_output      = COALESCE((SELECT SUM(output_tokens)   FROM messages WHERE feature_id = ?), 0),
         total_cache_read  = COALESCE((SELECT SUM(cache_read)      FROM messages WHERE feature_id = ?), 0),
         total_cache_write = COALESCE((SELECT SUM(cache_write)     FROM messages WHERE feature_id = ?), 0),
         turn_count        = COALESCE((SELECT COUNT(*)             FROM messages WHERE feature_id = ?), 0),
         first_activity_at = COALESCE(first_activity_at, ?),
         last_activity_at  = ?
       WHERE id = ?`
    ).run(
      m.feature_id, m.feature_id, m.feature_id, m.feature_id, m.feature_id, m.feature_id,
      m.timestamp, m.timestamp, m.feature_id
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // best-effort
    }
    throw err;
  }
}
