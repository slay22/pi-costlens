/**
 * Server tests (Bun).
 *
 * Run with: `bun test test/server.test.ts`
 * Or via npm script: `npm run test:server`
 *
 * Covers:
 *   - db.ts queries return expected shapes against a seeded DB
 *   - api.ts handlers return correct JSON for known fixtures
 *   - port.ts finds the next free port in 7331..7399
 *   - config.ts round-trips a config object through disk
 *
 * The DB is seeded once in beforeAll. Tests run against the known
 * fixture state. Tests that mutate the DB (config round-trip) use
 * separate temp paths so they don't disturb the seeded DB.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const TEST_HOME = mkdtempSync(join(tmpdir(), "costlens-server-test-"));
process.env.COSTLENS_HOME = TEST_HOME;

const DB_DIR = join(TEST_HOME, "costlens");
const DB_PATH = join(DB_DIR, "ledger.db");
const CONFIG_PATH = join(DB_DIR, "config.json");

// ---------------------------------------------------------------------------
// Schema + fixture seed
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE features (
    id                TEXT    PRIMARY KEY,
    name              TEXT    NOT NULL,
    branch            TEXT,
    status            TEXT    NOT NULL,
    cap_usd           REAL,
    started_at        TEXT    NOT NULL,
    closed_at         TEXT,
    pricing_conf      TEXT    NOT NULL,
    total_cost_usd    REAL    NOT NULL DEFAULT 0,
    total_input       INTEGER NOT NULL DEFAULT 0,
    total_output      INTEGER NOT NULL DEFAULT 0,
    total_cache_read  INTEGER NOT NULL DEFAULT 0,
    total_cache_write INTEGER NOT NULL DEFAULT 0,
    turn_count        INTEGER NOT NULL DEFAULT 0,
    first_activity_at TEXT,
    last_activity_at  TEXT
  );

  CREATE TABLE messages (
    id              TEXT    PRIMARY KEY,
    feature_id      TEXT    NOT NULL,
    session_id      TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    provider        TEXT    NOT NULL,
    input_tokens    INTEGER NOT NULL,
    output_tokens   INTEGER NOT NULL,
    cache_read      INTEGER NOT NULL,
    cache_write     INTEGER NOT NULL,
    cost_usd        REAL    NOT NULL,
    cost_input      REAL    NOT NULL,
    cost_output     REAL    NOT NULL,
    cost_cache_read REAL    NOT NULL,
    cost_cache_write REAL   NOT NULL,
    cost_unknown    INTEGER NOT NULL,
    timestamp       TEXT    NOT NULL,
    branch_path     TEXT
  );

  CREATE TABLE tags (
    feature_id TEXT NOT NULL,
    tag        TEXT NOT NULL,
    PRIMARY KEY (feature_id, tag)
  );

  CREATE TABLE notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    created_at TEXT    NOT NULL
  );

  CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL,
    cwd        TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_seen  TEXT NOT NULL
  );
`;

function seed() {
  mkdirSync(DB_DIR, { recursive: true });
  if (existsSync(DB_PATH)) rmSync(DB_PATH);
  const db = new Database(DB_PATH);
  db.exec(SCHEMA);

  const insertFeature = db.prepare(
    `INSERT INTO features
       (id, name, branch, status, cap_usd, started_at, closed_at,
        pricing_conf, total_cost_usd, total_input, total_output,
        total_cache_read, total_cache_write, turn_count,
        first_activity_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMessage = db.prepare(
    `INSERT INTO messages
       (id, feature_id, session_id, model, provider, input_tokens,
        output_tokens, cache_read, cache_write, cost_usd,
        cost_input, cost_output, cost_cache_read, cost_cache_write,
        cost_unknown, timestamp, branch_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertNote = db.prepare(
    `INSERT INTO notes (feature_id, body, created_at) VALUES (?, ?, ?)`
  );
  const insertTag = db.prepare(
    `INSERT INTO tags (feature_id, tag) VALUES (?, ?)`
  );

  // Three features: open, done, unassigned.
  insertFeature.run(
    "feat/open", "open feature", "feat/open", "open", 5.0,
    "2026-06-30T10:00:00Z", null, "complete",
    1.234, 1000, 500, 10000, 0, 12,
    "2026-06-30T10:00:00Z", "2026-07-01T10:00:00Z"
  );
  insertFeature.run(
    "feat/done", "done feature", "feat/done", "done", null,
    "2026-06-25T10:00:00Z", "2026-06-29T10:00:00Z", "partial",
    0.5, 500, 200, 5000, 0, 5,
    "2026-06-25T10:00:00Z", "2026-06-29T10:00:00Z"
  );
  insertFeature.run(
    "unassigned", "unassigned", null, "open", null,
    "2026-06-20T10:00:00Z", null, "unknown",
    0.1, 50, 10, 0, 0, 2,
    "2026-06-20T10:00:00Z", "2026-07-01T11:00:00Z"
  );

  // A few messages for the open feature, spread across 2 days, 2 models.
  insertMessage.run(
    "m1", "feat/open", "sess1", "claude-haiku-4-5", "anthropic",
    100, 50, 1000, 0, 0.05, 0.03, 0.02, 0.00, 0.00, 0,
    "2026-06-30T12:00:00Z", "feat/open"
  );
  insertMessage.run(
    "m2", "feat/open", "sess1", "claude-haiku-4-5", "anthropic",
    200, 80, 2000, 0, 0.10, 0.06, 0.04, 0.00, 0.00, 0,
    "2026-06-30T13:00:00Z", "feat/open"
  );
  insertMessage.run(
    "m3", "feat/open", "sess1", "minimax-m3", "opencode-go",
    300, 150, 3000, 0, 0.15, 0.09, 0.06, 0.00, 0.00, 0,
    "2026-07-01T12:00:00Z", "feat/open"
  );

  insertNote.run("feat/open", "started work", "2026-06-30T10:30:00Z");
  insertNote.run("feat/open", "finished backend", "2026-07-01T10:00:00Z");
  insertTag.run("feat/open", "backend");
  insertTag.run("feat/open", "v1");

  db.close();
}

// Import once. The singleton is opened in beforeAll.
const db = await import("../server/db.js");
const api = await import("../server/api.js");

// ---------------------------------------------------------------------------
// port.ts
// ---------------------------------------------------------------------------

describe("port", () => {
  test("PORT_RANGE bounds are correct", async () => {
    const { PORT_RANGE_START, PORT_RANGE_END } = await import("../server/port.js");
    expect(PORT_RANGE_START).toBe(7331);
    expect(PORT_RANGE_END).toBe(7399);
  });

  test("findFreePort returns a port in range", async () => {
    const { findFreePort } = await import("../server/port.js");
    const port = await findFreePort(7331);
    expect(port).not.toBeNull();
    expect(port!).toBeGreaterThanOrEqual(7331);
    expect(port!).toBeLessThanOrEqual(7399);
  });

  test("findFreePort finds the next port when start is taken", async () => {
    const { createServer } = await import("node:net");
    const { findFreePort } = await import("../server/port.js");
    // Bind port 7331 so it's taken. Use a port in the upper half of
    // the range so we don't collide with the running server (if any).
    const blockerPort = 7350;
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(blockerPort, "127.0.0.1", r));
    try {
      const port = await findFreePort(blockerPort);
      expect(port).toBe(blockerPort + 1);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  test("findFreePort returns null when start is beyond the range", async () => {
    const { findFreePort } = await import("../server/port.js");
    const port = await findFreePort(8000);
    expect(port).toBeNull();
  });

  test("findFreePort clamps start below the range", async () => {
    const { findFreePort, PORT_RANGE_START } = await import("../server/port.js");
    const port = await findFreePort(100);
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
  });
});

// ---------------------------------------------------------------------------
// config.ts
// ---------------------------------------------------------------------------

describe("config", () => {
  beforeEach(() => {
    mkdirSync(DB_DIR, { recursive: true });
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
  });

  test("returns defaults when no config file", async () => {
    const { readConfig } = await import("../server/config.js");
    const cfg = readConfig();
    expect(cfg.port).toBe(7331);
  });

  test("round-trips a config object through disk", async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ port: 8080 }, null, 2) + "\n");
    const { readConfig } = await import("../server/config.js");
    expect(readConfig().port).toBe(8080);
  });

  test("falls back to defaults for malformed JSON", async () => {
    writeFileSync(CONFIG_PATH, "{ not valid json");
    const { readConfig } = await import("../server/config.js");
    expect(readConfig().port).toBe(7331);
  });

  test("falls back to defaults for non-positive port", async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ port: -1 }));
    const { readConfig } = await import("../server/config.js");
    expect(readConfig().port).toBe(7331);
  });
});

// ---------------------------------------------------------------------------
// db.ts + api.ts (read-only, against the seeded fixture)
// ---------------------------------------------------------------------------

describe("db + api", () => {
  beforeAll(() => {
    seed();
    db.openDb(DB_PATH);
  });

  test("getAllFeatures returns rows sorted by last activity desc", () => {
    const features = db.getAllFeatures();
    expect(features.length).toBe(3);
    // unassigned has the most recent last_activity_at.
    expect(features[0].id).toBe("unassigned");
    expect(features[1].id).toBe("feat/open");
    expect(features[2].id).toBe("feat/done");
  });

  test("getFeature returns the row or null", () => {
    expect(db.getFeature("feat/open")?.id).toBe("feat/open");
    // bun:sqlite's .get() returns null for not-found, which we
    // normalize through the call sites that distinguish 404s.
    expect(db.getFeature("nope")).toBeNull();
  });

  test("getNotes returns notes in created_at order", () => {
    const notes = db.getNotes("feat/open");
    expect(notes.length).toBe(2);
    expect(notes[0].body).toBe("started work");
    expect(notes[1].body).toBe("finished backend");
  });

  test("getTags returns sorted tags", () => {
    expect(db.getTags("feat/open")).toEqual(["backend", "v1"]);
    expect(db.getTags("feat/done")).toEqual([]);
  });

  test("getRecentModels returns the most recent N models in order", () => {
    expect(db.getRecentModels("feat/open", 2)).toEqual([
      "minimax-m3",
      "claude-haiku-4-5",
    ]);
  });

  test("getMessages returns all messages for a feature", () => {
    const msgs = db.getMessages("feat/open");
    expect(msgs.length).toBe(3);
    expect(msgs[0].id).toBe("m1");
    expect(msgs[2].id).toBe("m3");
  });

  test("getMessages respects limit and since", () => {
    const last2 = db.getMessages("feat/open", { limit: 2 });
    expect(last2.length).toBe(2);
    expect(last2[0].id).toBe("m1");
    expect(last2[1].id).toBe("m2");

    const since = db.getMessages("feat/open", {
      since: "2026-07-01T00:00:00Z",
    });
    expect(since.length).toBe(1);
    expect(since[0].id).toBe("m3");
  });

  test("getOverview shape and totals", () => {
    const o = db.getOverview();
    // 1.234 (open) + 0.5 (done) — unassigned excluded from total
    expect(o.totalCost).toBeCloseTo(1.734, 4);
    expect(o.totalTurns).toBe(17); // 12 + 5
    expect(o.totalFeatures).toBe(3);
    expect(o.currentFeature).not.toBeNull();
    expect(o.byDay.length).toBe(30);
    expect(o.byDay[0].date < o.byDay[o.byDay.length - 1].date).toBe(true);
    expect(o.byModel.length).toBe(2);
    const haiku = o.byModel.find((m) => m.model === "claude-haiku-4-5");
    expect(haiku?.cost).toBeCloseTo(0.15, 4);
    expect(o.byStatus.open).toBe(2);
    expect(o.byStatus.done).toBe(1);
    expect(o.byStatus.abandoned).toBe(0);
    expect(o.byStatus.merged).toBe(0);
    expect(o.byStatus.unassigned).toBe(1);
  });

  test("handleHealth returns ok + version + startedAt + port", async () => {
    const res = api.handleHealth({ startedAt: "X", version: "v1" }, 8080);
    expect(res.status).toBe(200);
    const body = (await (res as any).json()) as any;
    expect(body.ok).toBe(true);
    expect(body.version).toBe("v1");
    expect(body.startedAt).toBe("X");
    expect(body.port).toBe(8080);
  });

  test("handleOverview returns the overview object", async () => {
    const res = api.handleOverview();
    expect(res.status).toBe(200);
    const body = (await (res as any).json()) as any;
    expect(body.totalFeatures).toBe(3);
    expect(body.byDay.length).toBe(30);
  });

  test("handleFeatures returns the full list", async () => {
    const res = api.handleFeatures(new URL("http://x/api/features"));
    expect(res.status).toBe(200);
    const body = (await (res as any).json()) as any[];
    expect(body.length).toBe(3);
  });

  test("handleFeatures?q= filters by id/name substring (case-insensitive)", async () => {
    const res = api.handleFeatures(new URL("http://x/api/features?q=OPEN"));
    const body = (await (res as any).json()) as any[];
    expect(body.length).toBe(1);
    expect(body[0].id).toBe("feat/open");
  });

  test("handleFeatures?q= matches by name fragment", async () => {
    const res = api.handleFeatures(new URL("http://x/api/features?q=done"));
    const body = (await (res as any).json()) as any[];
    expect(body.length).toBe(1);
    expect(body[0].id).toBe("feat/done");
  });

  test("handleFeatures?q= returns empty for no match", async () => {
    const res = api.handleFeatures(new URL("http://x/api/features?q=zzz"));
    const body = (await (res as any).json()) as any[];
    expect(body.length).toBe(0);
  });

  test("getAllTags returns unique tags with counts", () => {
    const tags = db.getAllTags();
    expect(tags.length).toBe(2);
    expect(tags[0]).toEqual({ tag: "backend", count: 1 });
    expect(tags[1]).toEqual({ tag: "v1", count: 1 });
  });

  test("handleAllTags returns the same shape", async () => {
    const res = api.handleAllTags();
    expect(res.status).toBe(200);
    const body = (await (res as any).json()) as any[];
    expect(body.length).toBe(2);
  });

  test("handleFeatureTags returns the tags array", async () => {
    const res = api.handleFeatureTags("feat/open");
    expect(res.status).toBe(200);
    const body = (await (res as any).json()) as any[];
    expect(body).toEqual(["backend", "v1"]);
  });

  test("handleFeatureTags 404s for missing feature", async () => {
    const res = api.handleFeatureTags("nope");
    expect(res.status).toBe(404);
  });

  test("handleFeatureNotes returns the notes array", async () => {
    const res = api.handleFeatureNotes("feat/open");
    expect(res.status).toBe(200);
    const body = (await (res as any).json()) as any[];
    expect(body.length).toBe(2);
    expect(body[0].body).toBe("started work");
  });

  test("handleFeatureNotes 404s for missing feature", async () => {
    const res = api.handleFeatureNotes("nope");
    expect(res.status).toBe(404);
  });

  test("handleExportJson returns full ledger with all tables", async () => {
    const res = api.handleExportJson();
    expect(res.status).toBe(200);
    const body = (await (res as any).json()) as any;
    expect(typeof body.exportedAt).toBe("string");
    expect(body.features.length).toBe(3);
    expect(body.messages.length).toBe(3);
    expect(body.notes.length).toBe(2);
    expect(body.tags.length).toBe(2);
    expect(body.sessions.length).toBe(0);
  });

  test("handleExportCsv returns text/csv with 5 sections", async () => {
    const res = api.handleExportCsv();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const body = await res.text();
    // 5 section markers
    expect(body.match(/^# /gm)?.length).toBe(5);
    // Each section has a header line (column list)
    expect(body).toContain("# features\nid,name,branch,status");
    expect(body).toContain("# tags\nfeature_id,tag");
    // One tag row appears
    expect(body).toContain("feat/open,backend");
  });

  test("searchFeatures in db returns substring matches", () => {
    expect(db.searchFeatures("OPEN").map((f) => f.id)).toEqual(["feat/open"]);
    expect(db.searchFeatures("done").map((f) => f.id)).toEqual(["feat/done"]);
    expect(db.searchFeatures("").length).toBe(0);
  });

  test("exportLedger includes tags per feature", () => {
    const data = db.exportLedger();
    expect(data.tags.length).toBe(2);
    expect(data.tags[0]).toEqual({ feature_id: "feat/open", tag: "backend" });
  });

  test("exportLedgerCsv produces parseable sections", () => {
    const csv = db.exportLedgerCsv();
    expect(csv).toContain("# features");
    expect(csv).toContain("# messages");
    expect(csv).toContain("# notes");
    expect(csv).toContain("# tags");
    expect(csv).toContain("# sessions");
    // Last section's header line should be present, with or without
    // trailing newline (depending on whether there are session rows).
    expect(csv).toMatch(/# sessions\nid,feature_id,cwd,started_at,last_seen($|\n)/);
  });

  test("handleFeature returns 404 for missing", async () => {
    const res = api.handleFeature("nope");
    expect(res.status).toBe(404);
    const body = (await (res as any).json()) as any;
    expect(body.error).toBe("not_found");
  });

  test("handleFeature returns full record with notes/tags/recentModels", async () => {
    const res = api.handleFeature("feat/open");
    expect(res.status).toBe(200);
    const body = (await (res as any).json()) as any;
    expect(body.id).toBe("feat/open");
    expect(body.notes.length).toBe(2);
    expect(body.tags).toEqual(["backend", "v1"]);
    expect(body.recentModels.length).toBeGreaterThan(0);
  });

  test("handleMessages validates limit", () => {
    const url = new URL("http://x/api/features/feat/open/messages?limit=abc");
    const res = api.handleMessages("feat/open", url);
    expect(res.status).toBe(400);
    const url2 = new URL("http://x/api/features/feat/open/messages?limit=-1");
    const res2 = api.handleMessages("feat/open", url2);
    expect(res2.status).toBe(400);
  });

  test("handleMessages returns 404 for missing feature", () => {
    const url = new URL("http://x/api/features/nope/messages");
    const res = api.handleMessages("nope", url);
    expect(res.status).toBe(404);
  });

  test("handleMessages returns messages with valid limit", async () => {
    const url = new URL("http://x/api/features/feat/open/messages?limit=2");
    const res = api.handleMessages("feat/open", url);
    const body = (await (res as any).json()) as any[];
    expect(body.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  try {
    db.closeDb();
    rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env.COSTLENS_HOME;
  } catch {
    // best-effort
  }
});
