/**
 * Bun:sqlite adapter for @costlens/core — opencode adapter.
 *
 * opencode plugins run in Bun, so the SQLite driver is bun:sqlite.
 * Same pattern as packages/core/src/server/index.ts (which also
 * uses bun:sqlite). The DB_PATH (~/.costlens/ledger.db) is shared
 * with the pi adapter and the dashboard server.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import {
  setCoreDb,
  closeCoreDb,
  applySchema,
  COSTLENS_DIR,
  DB_PATH,
  ensureMigratedFromEnv,
  type CoreDatabase,
} from "@costlens/core";

export { COSTLENS_DIR, DB_PATH };

let _db: Database | null = null;

/**
 * Open (or return already-open) Bun:sqlite connection.
 * Runs the legacy migration and schema migrations idempotently.
 * Called once when the plugin factory first runs.
 */
export function initDb(): CoreDatabase {
  if (_db) return _db as unknown as CoreDatabase;
  // Lazy migration: ~/.pi/costlens/ → ~/.costlens/ (step 3).
  ensureMigratedFromEnv();
  mkdirSync(COSTLENS_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000"); // tolerate concurrent pi writes
  applySchema(db as unknown as CoreDatabase);
  _db = db;
  setCoreDb(db as unknown as CoreDatabase);
  return db as unknown as CoreDatabase;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    closeCoreDb();
  }
}
