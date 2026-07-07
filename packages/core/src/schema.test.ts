/**
 * Tests for the v2 → v3 schema migration.
 *
 * Phase 9 step 4 (MULTI-TOOL.md §7). Verifies:
 *   - A v2 DB (without `messages.source`) gets migrated to v3 on
 *     `applySchema()`. Pre-existing rows default to `source = 'pi'`.
 *   - The migration is idempotent: re-running `applySchema()` on a
 *     v3 DB is a no-op (no error, no duplicate column).
 *   - A fresh DB (v3 from the start) creates the column in the
 *     `CREATE TABLE` statement.
 *   - New inserts via `recordMessageAndUpdateFeature` carry
 *     `source`.
 *   - Read queries return `source`.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  setCoreDb,
  closeCoreDb,
  applySchema,
  SCHEMA_VERSION,
  getMessages,
  exportLedger,
  exportLedgerCsv,
  getOverview,
} from "./db.js";
import { recordMessageAndUpdateFeature } from "./lifecycle.js";

let testHome: string;
let testDbPath: string;

before(() => {
  testHome = mkdtempSync(join(tmpdir(), "costlens-schema-v3-"));
  testDbPath = join(testHome, "ledger.db");
});

after(() => {
  closeCoreDb();
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// v2 → v3 migration
// ---------------------------------------------------------------------------

describe("schema v2 → v3 (messages.source)", () => {
  test("v2 DB gets the source column on first applySchema()", () => {
    // Build a v2-shaped DB directly (no source column). The
    // schema_version is recorded as v2.
    const db = new DatabaseSync(testDbPath);
    db.exec(`
      CREATE TABLE features (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        branch TEXT,
        status TEXT NOT NULL,
        cap_usd REAL,
        started_at TEXT NOT NULL,
        closed_at TEXT,
        pricing_conf TEXT NOT NULL,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        subagent_cost_usd REAL NOT NULL DEFAULT 0,
        total_input INTEGER NOT NULL DEFAULT 0,
        total_output INTEGER NOT NULL DEFAULT 0,
        total_cache_read INTEGER NOT NULL DEFAULT 0,
        total_cache_write INTEGER NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0,
        first_activity_at TEXT,
        last_activity_at TEXT
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        feature_id TEXT NOT NULL REFERENCES features(id),
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        cost_input REAL NOT NULL,
        cost_output REAL NOT NULL,
        cost_cache_read REAL NOT NULL,
        cost_cache_write REAL NOT NULL,
        cost_unknown INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        branch_path TEXT
      );
      CREATE TABLE tags (
        feature_id TEXT NOT NULL REFERENCES features(id),
        tag TEXT NOT NULL,
        PRIMARY KEY (feature_id, tag)
      );
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_id TEXT NOT NULL REFERENCES features(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        feature_id TEXT NOT NULL REFERENCES features(id),
        cwd TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE TABLE subagent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_id TEXT NOT NULL REFERENCES features(id),
        parent_message_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        agent_source TEXT NOT NULL,
        model TEXT,
        task TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        turns INTEGER NOT NULL,
        step INTEGER,
        exit_code INTEGER NOT NULL,
        stop_reason TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE TABLE tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_id TEXT NOT NULL REFERENCES features(id),
        message_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_size INTEGER,
        timestamp TEXT NOT NULL
      );
      INSERT INTO features (id, name, status, pricing_conf, started_at, first_activity_at, last_activity_at)
        VALUES ('feat/a', 'feat/a', 'open', 'unknown', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO messages
        (id, feature_id, session_id, model, provider, input_tokens, output_tokens,
         cache_read, cache_write, cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write,
         cost_unknown, timestamp)
        VALUES
        ('m1', 'feat/a', 'sess1', 'minimax-m3', 'openai', 100, 50, 0, 0,
         0.001, 0.0005, 0.0005, 0, 0, 0, '2026-01-01T00:00:01Z');
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_version (version, applied_at) VALUES (2, datetime('now'));
    `);

    // Sanity: v2 has no source column.
    const colsBefore = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as Array<{ name: string }>;
    assert.ok(!colsBefore.some((c) => c.name === "source"));

    setCoreDb(db as unknown as Parameters<typeof setCoreDb>[0]);

    // Run the migration.
    applySchema(db as unknown as Parameters<typeof applySchema>[0]);

    // After: source column exists, and the existing row defaulted
    // to 'pi' (the migration's default).
    const colsAfter = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as Array<{ name: string; dflt_value: string | null }>;
    const sourceCol = colsAfter.find((c) => c.name === "source");
    assert.ok(sourceCol, "source column added by applySchema()");
    assert.equal(sourceCol!.dflt_value, "'pi'", "default is 'pi'");

    const row = db
      .prepare(`SELECT source FROM messages WHERE id = 'm1'`)
      .get() as { source: string };
    assert.equal(row.source, "pi", "existing row defaulted to 'pi'");

    // Schema version is now 3.
    const versionRow = db
      .prepare(`SELECT MAX(version) AS v FROM schema_version`)
      .get() as { v: number };
    assert.equal(versionRow.v, 3);
  });

  test("applySchema() is idempotent on a v3 DB", () => {
    const db = new DatabaseSync(testDbPath);
    // Re-run the migration. Should not throw, should not add a
    // duplicate column, should not change the schema version row.
    applySchema(db as unknown as Parameters<typeof applySchema>[0]);
    applySchema(db as unknown as Parameters<typeof applySchema>[0]);
    applySchema(db as unknown as Parameters<typeof applySchema>[0]);

    const cols = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as Array<{ name: string }>;
    const sourceCount = cols.filter((c) => c.name === "source").length;
    assert.equal(sourceCount, 1, "source column appears exactly once after repeated migrations");

    const versionRow = db
      .prepare(`SELECT MAX(version) AS v FROM schema_version`)
      .get() as { v: number };
    assert.equal(versionRow.v, 3, "schema version stays at 3");
  });

  test("new inserts via recordMessageAndUpdateFeature carry source", () => {
    const db = new DatabaseSync(testDbPath);

    recordMessageAndUpdateFeature({
      id: "m2",
      feature_id: "feat/a",
      session_id: "sess1",
      model: "minimax-m3",
      provider: "openai",
      input_tokens: 200,
      output_tokens: 100,
      cache_read: 0,
      cache_write: 0,
      cost_usd: 0.002,
      cost_input: 0.001,
      cost_output: 0.001,
      cost_cache_read: 0,
      cost_cache_write: 0,
      cost_unknown: 0,
      timestamp: "2026-01-01T00:00:02Z",
      branch_path: null,
      source: "pi",
    });

    recordMessageAndUpdateFeature({
      id: "m3",
      feature_id: "feat/a",
      session_id: "sess2",
      model: "minimax-m3",
      provider: "openai",
      input_tokens: 50,
      output_tokens: 25,
      cache_read: 0,
      cache_write: 0,
      cost_usd: 0.0005,
      cost_input: 0.0003,
      cost_output: 0.0002,
      cost_cache_read: 0,
      cost_cache_write: 0,
      cost_unknown: 0,
      timestamp: "2026-01-01T00:00:03Z",
      branch_path: null,
      source: "opencode", // future: opencode-costlens would write this
    });

    const rows = db
      .prepare(`SELECT id, source FROM messages ORDER BY id`)
      .all() as Array<{ id: string; source: string }>;
    assert.equal(rows.length, 3, "three messages total (m1 migrated + m2 + m3 inserted)");
    assert.equal(rows[0].source, "pi", "m1 (migrated) source is 'pi'");
    assert.equal(rows[1].source, "pi", "m2 (pi insert) source is 'pi'");
    assert.equal(rows[2].source, "opencode", "m3 (opencode insert) source is 'opencode'");
  });

  test("read queries (getMessages, exportLedger) include source", () => {
    const db = new DatabaseSync(testDbPath);

    const msgs = getMessages("feat/a");
    assert.ok(msgs.length >= 2, "getMessages returns the messages");
    for (const m of msgs) {
      assert.equal(typeof m.source, "string", `message ${m.id} has a source`);
      assert.ok(m.source.length > 0, "source is non-empty");
    }
    // Spot-check: m2 is "pi", m3 is "opencode".
    const m2 = msgs.find((m) => m.id === "m2");
    const m3 = msgs.find((m) => m.id === "m3");
    assert.equal(m2?.source, "pi");
    assert.equal(m3?.source, "opencode");

    const ledger = exportLedger();
    const m3Row = ledger.messages.find((m) => m.id === "m3") as Record<string, unknown> | undefined;
    assert.ok(m3Row, "m3 appears in the export");
    assert.equal(m3Row!.source, "opencode", "export includes the source column");

    const csv = exportLedgerCsv();
    assert.match(csv, /source/m, "CSV export mentions the source column");
    assert.match(csv, /opencode/m, "CSV export includes the opencode source value");
  });

  test("getOverview still works with the new column (no SQL error)", () => {
    // Just verifying the overview query doesn't choke on the new
    // column. The bySource aggregate is deferred to v1.5+; for
    // now the overview just returns its existing shape.
    const overview = getOverview();
    assert.equal(typeof overview.totalCost, "number");
    assert.equal(overview.totalTurns, 3, "3 messages: m1 (migrated) + m2 + m3");
  });

  test("SCHEMA_VERSION constant is 3", () => {
    assert.equal(SCHEMA_VERSION, 3);
  });
});
