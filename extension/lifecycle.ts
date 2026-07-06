/**
 * Feature lifecycle.
 *
 * Phase 2 adds the full lifecycle:
 *   - Branch → feature mapping (idempotent, multi-session)
 *   - Y/n prompt for fresh branches
 *   - close / cancel / rename / set-cap / reopen
 *   - Notes attached at close/cancel or standalone
 *   - List / get for UI
 *
 * Phase 5 adds:
 *   - merge (third "ended" state: branch merged, work may continue)
 *   - tags (free-form, lowercased on save)
 *   - notes (standalone `attachNote` was already there; add a listAll
 *     helper and a listNotes alias)
 *   - search (case-insensitive substring on id/name)
 *   - export (JSON dump of all tables; CSV with one section per table)
 *
 * Decisions baked in:
 *   - On session_start, a feature is resumed (no prompt) only if its
 *     status is "open". Closed/cancelled features stay closed; a new
 *     session on the same branch goes to "unassigned" unless the user
 *     explicitly reopens with `/feature reopen`.
 *   - The "unassigned" feature is the bucket for main / detached / no-git
 *     and for branches whose feature is closed. It is never closed, and
 *     it refuses tags (no identity worth categorising).
 */

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "./db.js";
import type { GitContext } from "./git.js";

let _activeFeatureId: string | null = null;
let _activeGit: GitContext | null = null;

export type SessionCtx = {
  cwd: string;
  sessionFile: string | null;
  git: GitContext;
};

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
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write: number;
  turn_count: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
};

const UNASSIGNED_ID = "unassigned";
const MAIN_BRANCHES = new Set(["main", "master", "develop", "dev"]);

function featureIdFor(git: GitContext): string {
  if (!git.isRepo || git.branch === null || MAIN_BRANCHES.has(git.branch)) {
    return UNASSIGNED_ID;
  }
  return git.branch;
}

export function getFeature(featureId: string): Feature | undefined {
  return getDb()
    .prepare(`SELECT * FROM features WHERE id = ?`)
    .get(featureId) as Feature | undefined;
}

export function getCurrentFeatureId(ctx: { sessionManager: { getSessionFile(): string | undefined } }): string | null {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return null;
  const row = getDb()
    .prepare(`SELECT feature_id FROM sessions WHERE id = ?`)
    .get(sessionFile) as { feature_id: string } | undefined;
  return row?.feature_id ?? null;
}

/**
 * Open or resume a feature for a session, applying these rules:
 *   - If the feature exists and is 'open' → resume (no prompt, no row touch
 *     beyond last_activity_at).
 *   - If the feature exists and is closed (done/abandoned/merged) → do NOT
 *     resume; return the unassigned id. Caller should notify the user
 *     that costs won't be tracked.
 *   - If the feature does not exist → if `prompt` returns true (or there
 *     is no UI), create it. If false, return the unassigned id.
 *
 * Always writes the sessions row mapping this session → the returned
 * feature id, so the next event hook can find it.
 */
export async function ensureFeatureForSession(
  ctx: SessionCtx,
  prompt: () => Promise<boolean>
): Promise<string> {
  const db = getDb();
  const desiredId = featureIdFor(ctx.git);
  const now = new Date().toISOString();

  // Resolve to either `desiredId` or UNASSIGNED_ID based on the rules.
  let resolvedId = UNASSIGNED_ID;
  let closedExisting: Feature | null = null;

  if (desiredId === UNASSIGNED_ID) {
    resolvedId = UNASSIGNED_ID;
  } else {
    const existing = getFeature(desiredId);
    if (!existing) {
      const ok = await prompt();
      if (ok) {
        db.prepare(`
          INSERT INTO features
            (id, name, branch, status, pricing_conf,
             started_at, first_activity_at, last_activity_at)
          VALUES
            (?, ?, ?, 'open', 'unknown', ?, ?, ?)
        `).run(desiredId, desiredId, ctx.git.branch, now, now, now);
        resolvedId = desiredId;
      } else {
        resolvedId = UNASSIGNED_ID;
      }
    } else if (existing.status === "open") {
      db.prepare(`UPDATE features SET last_activity_at = ? WHERE id = ?`)
        .run(now, desiredId);
      resolvedId = desiredId;
    } else {
      // Closed feature on this branch — don't auto-resume.
      closedExisting = existing;
      resolvedId = UNASSIGNED_ID;
    }
  }

  // Ensure the unassigned feature row exists (lazy, idempotent).
  if (resolvedId === UNASSIGNED_ID) {
    const u = getFeature(UNASSIGNED_ID);
    if (!u) {
      db.prepare(`
        INSERT INTO features
          (id, name, branch, status, pricing_conf,
           started_at, first_activity_at, last_activity_at)
        VALUES
          (?, 'unassigned', NULL, 'open', 'unknown', ?, ?, ?)
      `).run(UNASSIGNED_ID, now, now, now);
    } else {
      db.prepare(`UPDATE features SET last_activity_at = ? WHERE id = ?`)
        .run(now, UNASSIGNED_ID);
    }
  }

  // Track the session → feature mapping.
  if (ctx.sessionFile) {
    db.prepare(`
      INSERT INTO sessions (id, feature_id, cwd, started_at, last_seen)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        feature_id = excluded.feature_id,
        last_seen  = excluded.last_seen
    `).run(ctx.sessionFile, resolvedId, ctx.cwd, now, now);
  }

  return resolvedId;
}

// ---------------------------------------------------------------------------
// State mutations (close / cancel / rename / setCap / reopen)
// ---------------------------------------------------------------------------

export class LifecycleError extends Error {
  constructor(public code: "NOT_FOUND" | "INVALID_STATE" | "UNASSIGNED", message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

export function closeFeature(featureId: string, note?: string): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot close the unassigned pool.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (f.status !== "open") {
    throw new LifecycleError(
      "INVALID_STATE",
      `Feature "${featureId}" is already ${f.status}; close it with /feature reopen first, or it's already terminal.`
    );
  }
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`UPDATE features SET status = 'done', closed_at = ? WHERE id = ?`)
    .run(now, featureId);
  if (note && note.trim()) attachNote(featureId, note.trim());
  return getFeature(featureId)!;
}

export function cancelFeature(featureId: string, note?: string): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot cancel the unassigned pool.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (f.status !== "open") {
    throw new LifecycleError(
      "INVALID_STATE",
      `Feature "${featureId}" is already ${f.status}.`
    );
  }
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`UPDATE features SET status = 'abandoned', closed_at = ? WHERE id = ?`)
    .run(now, featureId);
  if (note && note.trim()) attachNote(featureId, note.trim());
  return getFeature(featureId)!;
}

/**
 * Mark a feature as `merged` — the branch was merged but feature work
 * may continue. Freezes cost (closed_at is set) but the status is
 * semantically distinct from `done` (work completed) and `abandoned`
 * (work dropped). Reopen via `/feature reopen` works the same as for
 * done/abandoned.
 */
export function mergeFeature(featureId: string, note?: string): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot merge the unassigned pool.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (f.status !== "open") {
    throw new LifecycleError(
      "INVALID_STATE",
      `Feature "${featureId}" is already ${f.status}; reopen it first if you want to merge again.`
    );
  }
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(`UPDATE features SET status = 'merged', closed_at = ? WHERE id = ?`)
    .run(now, featureId);
  if (note && note.trim()) attachNote(featureId, note.trim());
  return getFeature(featureId)!;
}

export function reopenFeature(featureId: string): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot reopen the unassigned pool.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (f.status === "open") {
    throw new LifecycleError("INVALID_STATE", `Feature "${featureId}" is already open.`);
  }
  const db = getDb();
  db.prepare(`UPDATE features SET status = 'open', closed_at = NULL WHERE id = ?`)
    .run(featureId);
  return getFeature(featureId)!;
}

export function renameFeature(featureId: string, newName: string): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot rename the unassigned pool.");
  }
  const trimmed = newName.trim();
  if (!trimmed) {
    throw new LifecycleError("INVALID_STATE", "New name cannot be empty.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  getDb().prepare(`UPDATE features SET name = ? WHERE id = ?`)
    .run(trimmed, featureId);
  return getFeature(featureId)!;
}

export function setCap(featureId: string, capUsd: number | null): Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot set a cap on the unassigned pool.");
  }
  if (capUsd !== null && (isNaN(capUsd) || capUsd < 0)) {
    throw new LifecycleError("INVALID_STATE", "Cap must be a non-negative number, or 0 to clear.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  const resolved = capUsd === null || capUsd === 0 ? null : capUsd;
  getDb().prepare(`UPDATE features SET cap_usd = ? WHERE id = ?`)
    .run(resolved, featureId);
  return getFeature(featureId)!;
}

export function attachNote(featureId: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  getDb()
    .prepare(
      `INSERT INTO notes (feature_id, body, created_at) VALUES (?, ?, ?)`
    )
    .run(featureId, trimmed, new Date().toISOString());
}

export function getNotes(featureId: string): Array<{ id: number; body: string; created_at: string }> {
  return getDb()
    .prepare(`SELECT id, body, created_at FROM notes WHERE feature_id = ? ORDER BY created_at ASC`)
    .all(featureId) as Array<{ id: number; body: string; created_at: string }>;
}

export function listNotes(featureId: string): Array<{ id: number; body: string; created_at: string }> {
  return getNotes(featureId);
}

// ---------------------------------------------------------------------------
// Tags (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Add a tag to a feature. Tags are lowercased + trimmed on save. Adding
 * the same tag twice is a no-op (PK is `(feature_id, tag)`). The
 * unassigned pool refuses tags — it has no identity worth categorising.
 */
export function addTag(featureId: string, rawTag: string): string {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot tag the unassigned pool.");
  }
  const tag = normaliseTag(rawTag);
  if (!tag) {
    throw new LifecycleError("INVALID_STATE", "Tag cannot be empty.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  getDb()
    .prepare(`INSERT OR IGNORE INTO tags (feature_id, tag) VALUES (?, ?)`)
    .run(featureId, tag);
  return tag;
}

/** Remove a tag from a feature. No-op if the tag isn't set. */
export function removeTag(featureId: string, rawTag: string): boolean {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot untag the unassigned pool.");
  }
  const tag = normaliseTag(rawTag);
  if (!tag) return false;
  const res = getDb()
    .prepare(`DELETE FROM tags WHERE feature_id = ? AND tag = ?`)
    .run(featureId, tag);
  return res.changes > 0;
}

/** Sorted list of tags for a single feature. */
export function listTags(featureId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT tag FROM tags WHERE feature_id = ? ORDER BY tag`)
      .all(featureId) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

/**
 * All unique tags across the ledger, sorted, with the count of features
 * carrying each tag. Useful for the "what tags exist" overview.
 */
export function listAllTags(): Array<{ tag: string; count: number }> {
  return getDb()
    .prepare(
      `SELECT tag, COUNT(*) AS count
       FROM tags
       GROUP BY tag
       ORDER BY tag`
    )
    .all() as Array<{ tag: string; count: number }>;
}

/** Lowercase + trim + collapse internal whitespace. */
function normaliseTag(rawTag: string): string {
  return rawTag.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------------------------------------------------------------------------
// Search (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Case-insensitive substring match on `id` and `name`. Uses `instr()` so
 * user input isn't interpreted as a LIKE pattern (no wildcards). The
 * unassigned pool is included.
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

// ---------------------------------------------------------------------------
// Export (Phase 5)
// ---------------------------------------------------------------------------

export type LedgerExport = {
  exportedAt: string;
  features: Feature[];
  messages: Array<Record<string, unknown>>;
  notes: Array<{ id: number; feature_id: string; body: string; created_at: string }>;
  tags: Array<{ feature_id: string; tag: string }>;
  sessions: Array<{ id: string; feature_id: string; cwd: string; started_at: string; last_seen: string }>;
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
    csvSection("features", [
      "id", "name", "branch", "status", "cap_usd", "started_at", "closed_at",
      "pricing_conf", "total_cost_usd", "total_input", "total_output",
      "total_cache_read", "total_cache_write", "turn_count",
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

export function listFeatures(filter?: { status?: Feature["status"] }): Feature[] {
  const db = getDb();
  // Use COALESCE so the order works regardless of NULL handling quirks.
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
      `SELECT * FROM features ORDER BY COALESCE(last_activity_at, started_at) DESC`
    )
    .all() as Feature[];
}

// ---------------------------------------------------------------------------
// Module-level active-feature cache (used for footer / commands)
// ---------------------------------------------------------------------------

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

/** Convenience for tests. */
export function _resetForTest(): void {
  _activeFeatureId = null;
  _activeGit = null;
}
