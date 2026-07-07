/**
 * SQLite ledger for Costlens — pi adapter.
 *
 * Phase 9 step 2: the schema, migrations, and the singleton
 * lifecycle live in `@costlens/core`. This file is now a thin
 * adapter that:
 *   1. Opens a `node:sqlite` connection (the extension is loaded
 *      via jiti in Node, not Bun).
 *   2. Enables WAL + foreign keys (the same pragmas core's
 *      `applySchema` expects, and which let the Bun server read
 *      while the extension writes).
 *   3. Calls `setCoreDb()` so core's `getCoreDb()` returns the
 *      same handle.
 *   4. Re-exports core's reads/writes so existing call sites
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
  type LedgerExport,
} from "@costlens/core";

// `COSTLENS_HOME` lets tests point the ledger at a temp directory.
// In normal use it is undefined and we use `~/.pi/costlens/`
// (the legacy path — step 3 of MULTI-TOOL.md moves this to
// `~/.costlens/` with lazy migration).
const LEGACY_DIR = process.env.COSTLENS_HOME
  ? join(process.env.COSTLENS_HOME, "costlens")
  : join(homedir(), ".pi", "costlens");
export const LEGACY_DB_PATH = join(LEGACY_DIR, "ledger.db");

let _db: DatabaseSync | null = null;

/** Initialise (or return the already-open) DB. Idempotent. */
export function initDb(): CoreDatabase {
  if (_db) return _db as unknown as CoreDatabase;
  // For step 1+2 the extension still uses the legacy `~/.pi/costlens/`
  // path. Step 3 (MULTI-TOOL.md §6) moves this to `~/.costlens/`.
  mkdirSync(LEGACY_DIR, { recursive: true });
  const db = new DatabaseSync(LEGACY_DB_PATH);
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
};
