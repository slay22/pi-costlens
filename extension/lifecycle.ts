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
 * Decisions baked in:
 *   - On session_start, a feature is resumed (no prompt) only if its
 *     status is "open". Closed/cancelled features stay closed; a new
 *     session on the same branch goes to "unassigned" unless the user
 *     explicitly reopens with `/feature reopen`.
 *   - The "unassigned" feature is the bucket for main / detached / no-git
 *     and for branches whose feature is closed. It is never closed.
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
