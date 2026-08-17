/**
 * SQLite ledger for Costlens — pi adapter.
 *
 * Phase 9 step 2: the schema, migrations, and the singleton
 * lifecycle live in `@costlens/core`. This file is now a thin
 * adapter that:
 *   1. Runs the legacy data migration (`~/.pi/costlens/` →
 *      `~/.costlens/`) via `core.ensureMigratedFromEnv()`.
 *   2. Opens a `node:sqlite` connection at the new path
 *      (`~/.costlens/ledger.db`).
 *   3. Enables WAL + foreign keys (the same pragmas core's
 *      `applySchema` expects, and which let the Bun server read
 *      while the extension writes).
 *   4. Calls `setCoreDb()` so core's `getCoreDb()` returns the
 *      same handle.
 *   5. Re-exports core's reads/writes so existing call sites
 *      (`import { ... } from "./db.js"`) keep working unchanged.
 *
 * The extension remains the primary writer (every `message_end`
 * event). The dashboard server is a secondary writer (user
 * actions in the browser). SQLite WAL serialises writes between
 * the two processes.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  setCoreDb,
  getCoreDb,
  closeCoreDb,
  applySchema,
  COSTLENS_DIR,
  DB_PATH,
  ensureMigratedFromEnv,
  type CoreDatabase,
  // Re-exports for the rest of the extension
  getFeature,
  getSessionFeatureId,
  getMessages,
  getRecentModels,
  getNotes,
  getTags,
  getAllTags,
  getSubagentRuns,
  getSubagentSummary,
  getTopSubagents,
  getToolCalls,
  getToolCallCounts,
  searchFeatures,
  listFeatures,
  getAllFeatures,
  getOverview,
  exportLedger,
  exportLedgerCsv,
  LEGACY_DB_DIR,
  type LedgerExport,
} from "@costlens/core";

/**
 * Phase 9 step 3: the legacy path is now only consulted by the
 * migration, never opened. Exposed for tests + the rare call site
 * that wants to read the old path explicitly.
 */
export const LEGACY_DB_PATH = join(LEGACY_DB_DIR, "ledger.db");

let _db: DatabaseSync | null = null;

/** Initialise (or return the already-open) DB. Idempotent. */
export function initDb(): CoreDatabase {
  if (_db) return _db as unknown as CoreDatabase;
  // Phase 9 step 3: rename the legacy `~/.pi/costlens/` directory
  // to `~/.costlens/` if needed. Idempotent — safe to call on
  // every `initDb()`. If both paths exist, the new path wins; the
  // legacy data is left in place (don't overwrite).
  const result = ensureMigratedFromEnv();
  if (result.kind === "migrated") {
    // Best-effort log; not fatal if the user has no TTY.
    console.warn(
      `Costlens: migrated data from ${result.from} to ${result.to} (${result.at}). ` +
        `The legacy directory is now at the new home.`
    );
  }
  mkdirSync(COSTLENS_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  applySchema(db);
  _db = db;
  setCoreDb(db as unknown as CoreDatabase);
  return db as unknown as CoreDatabase;
}

export function getDb(): CoreDatabase {
  if (!_db) {
    throw new Error(
      "Costlens: DB not initialised. Call initDb() first (e.g. from session_start)."
    );
  }
  return _db as unknown as CoreDatabase;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    closeCoreDb();
  }
}

// ---------------------------------------------------------------------------
// Re-exports from core
// ---------------------------------------------------------------------------

export {
  setCoreDb,
  getCoreDb,
  closeCoreDb,
  applySchema,
  COSTLENS_DIR,
  DB_PATH,
  ensureMigratedFromEnv,
  getFeature,
  getSessionFeatureId,
  getMessages,
  getRecentModels,
  getNotes,
  getTags,
  getAllTags,
  getSubagentRuns,
  getSubagentSummary,
  getTopSubagents,
  getToolCalls,
  getToolCallCounts,
  searchFeatures,
  listFeatures,
  getAllFeatures,
  getOverview,
  exportLedger,
  exportLedgerCsv,
  type CoreDatabase,
  type LedgerExport,
  LEGACY_DB_DIR,
};
