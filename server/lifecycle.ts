/**
 * Server-side feature lifecycle writes.
 *
 * Phase 7.5 of PHASE7.5.md: the dashboard gains the ability to act on
 * a feature (close / cancel / merge / reopen / set-cap / add-tag /
 * remove-tag / attach-note) from the browser, without dropping back to
 * the pi TUI.
 *
 * This module is a deliberate, bounded duplicate of
 * `extension/lifecycle.ts`. Both modules own the same business rules
 * (what counts as a "closed" feature, what setCap does at 0, what a
 * valid tag looks like). The plan calls out the duplication as
 * intentional: extracting a shared core would require a build step
 * because the extension is Node + node:sqlite and the server is Bun +
 * bun:sqlite, and the functions are small and stable.
 *
 * The server's `db.ts` opens the same SQLite file (in WAL mode, since
 * the extension sets `PRAGMA journal_mode=WAL` at init) in read-write
 * mode. SQLite WAL serializes writes between the two processes, so
 * concurrent writes from the extension's `message_end` hook and a
 * dashboard close action are safe: the writes interleave, both
 * commit, no data loss.
 *
 * Each multi-statement function (close / cancel / merge) wraps its
 * writes in a single transaction so the feature status and any
 * attached note commit atomically.
 *
 * Reads still come from `server/db.ts` — this module only writes.
 */

import { getDb, getFeature } from "./db.js";

const UNASSIGNED_ID = "unassigned";

/**
 * Same shape as `extension/lifecycle.ts` `LifecycleError`. The HTTP
 * layer maps these to JSON responses with the right status code.
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
// State transitions
// ---------------------------------------------------------------------------

/**
 * Mark a feature `done`. Optionally attach a note in the same
 * transaction so the close + note commit atomically. The extension's
 * `/feature close <id> [note]` does exactly this.
 */
export function closeFeature(featureId: string, note?: string): import("./db.js").Feature {
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
  const tx = db.transaction(() => {
    db.prepare(`UPDATE features SET status = 'done', closed_at = ? WHERE id = ?`)
      .run(now, featureId);
    if (note && note.trim()) {
      db.prepare(`INSERT INTO notes (feature_id, body, created_at) VALUES (?, ?, ?)`)
        .run(featureId, note.trim(), now);
    }
  });
  tx();
  return getFeature(featureId)!;
}

/** Mark a feature `abandoned`. Same note-on-close semantics as close. */
export function cancelFeature(featureId: string, note?: string): import("./db.js").Feature {
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
  const tx = db.transaction(() => {
    db.prepare(`UPDATE features SET status = 'abandoned', closed_at = ? WHERE id = ?`)
      .run(now, featureId);
    if (note && note.trim()) {
      db.prepare(`INSERT INTO notes (feature_id, body, created_at) VALUES (?, ?, ?)`)
        .run(featureId, note.trim(), now);
    }
  });
  tx();
  return getFeature(featureId)!;
}

/**
 * Mark a feature `merged` — the branch was merged but feature work may
 * continue. Freezes cost (closed_at is set) but the status is
 * semantically distinct from `done` and `abandoned`. Reopen via the
 * dashboard's Reopen button works the same as for done/abandoned.
 */
export function mergeFeature(featureId: string, note?: string): import("./db.js").Feature {
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
  const tx = db.transaction(() => {
    db.prepare(`UPDATE features SET status = 'merged', closed_at = ? WHERE id = ?`)
      .run(now, featureId);
    if (note && note.trim()) {
      db.prepare(`INSERT INTO notes (feature_id, body, created_at) VALUES (?, ?, ?)`)
        .run(featureId, note.trim(), now);
    }
  });
  tx();
  return getFeature(featureId)!;
}

/**
 * Restore a closed/cancelled/merged feature to `open`. Clears
 * `closed_at`. No transition is reversible from the dashboard other
 * than via this button.
 */
export function reopenFeature(featureId: string): import("./db.js").Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot reopen the unassigned pool.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (f.status === "open") {
    throw new LifecycleError("INVALID_STATE", `Feature "${featureId}" is already open.`);
  }
  getDb()
    .prepare(`UPDATE features SET status = 'open', closed_at = NULL WHERE id = ?`)
    .run(featureId);
  return getFeature(featureId)!;
}

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

/**
 * Set or clear the cap. `null` (or `0`) clears the cap. Negative
 * numbers are a validation error. Returns the updated Feature.
 */
export function setCap(featureId: string, capUsd: number | null): import("./db.js").Feature {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot set a cap on the unassigned pool.");
  }
  if (capUsd !== null && (isNaN(capUsd) || capUsd < 0)) {
    throw new LifecycleError("BAD_REQUEST", "Cap must be a non-negative number, or null to clear.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  const resolved = capUsd === null || capUsd === 0 ? null : capUsd;
  getDb().prepare(`UPDATE features SET cap_usd = ? WHERE id = ?`)
    .run(resolved, featureId);
  return getFeature(featureId)!;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * Add a tag. Tags are lowercased + trimmed on save. Adding the same
 * tag twice is a no-op (PK is `(feature_id, tag)`). Returns the
 * normalised tag value so the API can echo it back.
 */
export function addTag(featureId: string, rawTag: string): string {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot tag the unassigned pool.");
  }
  const tag = normaliseTag(rawTag);
  if (!tag) {
    throw new LifecycleError("BAD_REQUEST", "Tag cannot be empty.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  getDb()
    .prepare(`INSERT OR IGNORE INTO tags (feature_id, tag) VALUES (?, ?)`)
    .run(featureId, tag);
  return tag;
}

/**
 * Remove a tag. No-op if the tag isn't set. Returns the current
 * sorted tag list for the feature (so the API can return it without a
 * second round-trip).
 */
export function removeTag(featureId: string, rawTag: string): string[] {
  if (featureId === UNASSIGNED_ID) {
    throw new LifecycleError("UNASSIGNED", "Cannot untag the unassigned pool.");
  }
  const tag = normaliseTag(rawTag);
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  if (tag) {
    getDb()
      .prepare(`DELETE FROM tags WHERE feature_id = ? AND tag = ?`)
      .run(featureId, tag);
  }
  return (
    getDb()
      .prepare(`SELECT tag FROM tags WHERE feature_id = ? ORDER BY tag`)
      .all(featureId) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

/** Sorted list of tags for a single feature. */
export function listTags(featureId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT tag FROM tags WHERE feature_id = ? ORDER BY tag`)
      .all(featureId) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

/** Lowercase + trim + collapse internal whitespace. Matches the extension. */
function normaliseTag(rawTag: string): string {
  return rawTag.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * Append a standalone note. Returns the inserted note (with its
 * assigned id and created_at) so the dashboard can render it without
 * re-fetching the full notes list. Empty / whitespace-only bodies
 * are rejected with BAD_REQUEST so the dashboard can show a clear
 * error rather than a silent no-op.
 */
export function attachNote(
  featureId: string,
  body: string
): { id: number; body: string; created_at: string } {
  const trimmed = body.trim();
  if (!trimmed) {
    throw new LifecycleError("BAD_REQUEST", "Note body cannot be empty.");
  }
  const f = getFeature(featureId);
  if (!f) throw new LifecycleError("NOT_FOUND", `No feature "${featureId}".`);
  const now = new Date().toISOString();
  const db = getDb();
  // `lastInsertRowid` is on the `Statement.run()` result in
  // `bun:sqlite` (not on the Database like in some other SQLite
  // bindings). A single INSERT is already atomic; the explicit
  // transaction is just for symmetry with close/cancel/merge.
  const result = db
    .prepare(`INSERT INTO notes (feature_id, body, created_at) VALUES (?, ?, ?)`)
    .run(featureId, trimmed, now);
  return { id: Number(result.lastInsertRowid), body: trimmed, created_at: now };
}
