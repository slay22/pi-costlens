/**
 * Bun:sqlite adapter for the standalone CLI. Same open pattern as the
 * pi/opencode adapters and the dashboard server — one shared ledger at
 * ~/.costlens/ledger.db (WAL mode → concurrent reads while pi/opencode
 * write). The CLI is a reader (`feature`) and an occasional writer
 * (`ingest-ccusage`); busy_timeout tolerates a live adapter writing.
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

export function initDb(): CoreDatabase {
  if (_db) return _db as unknown as CoreDatabase;
  ensureMigratedFromEnv(); // lazy ~/.pi/costlens → ~/.costlens migration
  mkdirSync(COSTLENS_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
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
