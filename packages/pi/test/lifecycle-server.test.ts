/**
 * Server-side lifecycle tests (Bun).
 *
 * Run with: `bun test test/lifecycle-server.test.ts`
 *
 * Mirrors `test/lifecycle.test.ts` (the extension's lifecycle) but
 * exercises `server/lifecycle.ts` against a `bun:sqlite` database in
 * a temp directory. Same scenarios, same assertions: the duplication
 * is deliberate per PHASE7.5.md, and the tests are how we keep the
 * two implementations in sync.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const TEST_HOME = mkdtempSync(join(tmpdir(), "costlens-lifecycle-server-"));
process.env.COSTLENS_HOME = TEST_HOME;

const DB_DIR = join(TEST_HOME, "costlens");
const DB_PATH = join(DB_DIR, "ledger.db");

// Same schema as test/server.test.ts.
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

// ---------------------------------------------------------------------------
// Setup: open the DB, seed a feature for each test
// ---------------------------------------------------------------------------

const db = await import("../server/db.js");
const lc = await import("../server/lifecycle.js");
type LifecycleError = InstanceType<typeof lc.LifecycleError>;

function seedOpenFeature(id: string) {
  const now = new Date().toISOString();
  db.getDb()
    .prepare(
      `INSERT INTO features
         (id, name, branch, status, pricing_conf, started_at,
          first_activity_at, last_activity_at)
       VALUES (?, ?, ?, 'open', 'unknown', ?, ?, ?)`
    )
    .run(id, id, id, now, now, now);
}

function seedFeature(id: string, status: "open" | "done" | "abandoned" | "merged") {
  const now = new Date().toISOString();
  const closed = status === "open" ? null : now;
  db.getDb()
    .prepare(
      `INSERT INTO features
         (id, name, branch, status, closed_at, pricing_conf, started_at,
          first_activity_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?, ?)`
    )
    .run(id, id, id, status, closed, now, now, now);
}

beforeAll(() => {
  mkdirSync(DB_DIR, { recursive: true });
  rmSync(DB_PATH, { force: true });
  const fresh = new Database(DB_PATH);
  fresh.exec(SCHEMA);
  fresh.close();
  db.openDb(DB_PATH);
});

beforeEach(() => {
  // Wipe features/tags/notes between tests so each starts clean.
  db.getDb().exec(`DELETE FROM notes; DELETE FROM tags; DELETE FROM features;`);
});

afterAll(() => {
  try {
    db.closeDb();
    rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env.COSTLENS_HOME;
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// closeFeature
// ---------------------------------------------------------------------------

describe("closeFeature", () => {
  test("sets status to 'done' and records closed_at", () => {
    seedOpenFeature("feat/close-1");
    const closed = lc.closeFeature("feat/close-1");
    expect(closed.status).toBe("done");
    expect(closed.closed_at).not.toBeNull();
  });

  test("attaches a note when provided", () => {
    seedOpenFeature("feat/close-2");
    lc.closeFeature("feat/close-2", "shipped to production");
    const notes = db.getNotes("feat/close-2");
    expect(notes.length).toBe(1);
    expect(notes[0].body).toBe("shipped to production");
  });

  test("does NOT attach a note when not provided", () => {
    seedOpenFeature("feat/close-2b");
    lc.closeFeature("feat/close-2b");
    expect(db.getNotes("feat/close-2b").length).toBe(0);
  });

  test("ignores whitespace-only note", () => {
    seedOpenFeature("feat/close-2c");
    lc.closeFeature("feat/close-2c", "   ");
    expect(db.getNotes("feat/close-2c").length).toBe(0);
  });

  test("refuses to close an already-closed feature", () => {
    seedFeature("feat/close-3", "done");
    expect(() => lc.closeFeature("feat/close-3")).toThrow(lc.LifecycleError);
    try {
      lc.closeFeature("feat/close-3");
    } catch (err) {
      expect(err).toBeInstanceOf(lc.LifecycleError);
      expect((err as LifecycleError).code).toBe("INVALID_STATE");
    }
  });

  test("refuses to close a missing feature", () => {
    expect(() => lc.closeFeature("feat/nope")).toThrow(lc.LifecycleError);
    try {
      lc.closeFeature("feat/nope");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("NOT_FOUND");
    }
  });

  test("refuses to close the unassigned pool", () => {
    expect(() => lc.closeFeature("unassigned")).toThrow(lc.LifecycleError);
    try {
      lc.closeFeature("unassigned");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("UNASSIGNED");
    }
  });

  test("note + close commit atomically (both visible after call)", () => {
    seedOpenFeature("feat/close-atom");
    lc.closeFeature("feat/close-atom", "atomic note");
    const f = db.getFeature("feat/close-atom");
    const notes = db.getNotes("feat/close-atom");
    expect(f?.status).toBe("done");
    expect(notes.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cancelFeature
// ---------------------------------------------------------------------------

describe("cancelFeature", () => {
  test("sets status to 'abandoned' and records closed_at", () => {
    seedOpenFeature("feat/cancel-1");
    const c = lc.cancelFeature("feat/cancel-1");
    expect(c.status).toBe("abandoned");
    expect(c.closed_at).not.toBeNull();
  });

  test("attaches a note when provided", () => {
    seedOpenFeature("feat/cancel-2");
    lc.cancelFeature("feat/cancel-2", "abandoned in favour of rewrite");
    const notes = db.getNotes("feat/cancel-2");
    expect(notes.length).toBe(1);
    expect(notes[0].body).toBe("abandoned in favour of rewrite");
  });

  test("refuses to cancel an already-cancelled feature", () => {
    seedFeature("feat/cancel-3", "abandoned");
    expect(() => lc.cancelFeature("feat/cancel-3")).toThrow(lc.LifecycleError);
    try {
      lc.cancelFeature("feat/cancel-3");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("INVALID_STATE");
    }
  });

  test("refuses to cancel the unassigned pool", () => {
    expect(() => lc.cancelFeature("unassigned")).toThrow(lc.LifecycleError);
    try {
      lc.cancelFeature("unassigned");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("UNASSIGNED");
    }
  });
});

// ---------------------------------------------------------------------------
// mergeFeature
// ---------------------------------------------------------------------------

describe("mergeFeature", () => {
  test("sets status to 'merged' and records closed_at", () => {
    seedOpenFeature("feat/merge-1");
    const m = lc.mergeFeature("feat/merge-1");
    expect(m.status).toBe("merged");
    expect(m.closed_at).not.toBeNull();
  });

  test("attaches a note when provided", () => {
    seedOpenFeature("feat/merge-2");
    lc.mergeFeature("feat/merge-2", "merged to main");
    const notes = db.getNotes("feat/merge-2");
    expect(notes.length).toBe(1);
    expect(notes[0].body).toBe("merged to main");
  });

  test("refuses to merge an already-merged feature", () => {
    seedFeature("feat/merge-3", "merged");
    expect(() => lc.mergeFeature("feat/merge-3")).toThrow(lc.LifecycleError);
    try {
      lc.mergeFeature("feat/merge-3");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("INVALID_STATE");
    }
  });

  test("reopen from merged restores the feature to open", () => {
    seedOpenFeature("feat/merge-4");
    lc.mergeFeature("feat/merge-4");
    const r = lc.reopenFeature("feat/merge-4");
    expect(r.status).toBe("open");
    expect(r.closed_at).toBeNull();
  });

  test("refuses to merge the unassigned pool", () => {
    expect(() => lc.mergeFeature("unassigned")).toThrow(lc.LifecycleError);
    try {
      lc.mergeFeature("unassigned");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("UNASSIGNED");
    }
  });
});

// ---------------------------------------------------------------------------
// reopenFeature
// ---------------------------------------------------------------------------

describe("reopenFeature", () => {
  test("reopens a closed feature, clears closed_at", () => {
    seedFeature("feat/reopen-1", "done");
    const r = lc.reopenFeature("feat/reopen-1");
    expect(r.status).toBe("open");
    expect(r.closed_at).toBeNull();
  });

  test("reopens a cancelled feature", () => {
    seedFeature("feat/reopen-2", "abandoned");
    const r = lc.reopenFeature("feat/reopen-2");
    expect(r.status).toBe("open");
  });

  test("reopens a merged feature", () => {
    seedFeature("feat/reopen-3", "merged");
    const r = lc.reopenFeature("feat/reopen-3");
    expect(r.status).toBe("open");
  });

  test("refuses to reopen an already-open feature", () => {
    seedFeature("feat/reopen-4", "open");
    expect(() => lc.reopenFeature("feat/reopen-4")).toThrow(lc.LifecycleError);
    try {
      lc.reopenFeature("feat/reopen-4");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("INVALID_STATE");
    }
  });

  test("refuses to reopen the unassigned pool", () => {
    expect(() => lc.reopenFeature("unassigned")).toThrow(lc.LifecycleError);
    try {
      lc.reopenFeature("unassigned");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("UNASSIGNED");
    }
  });

  test("refuses to reopen a missing feature", () => {
    expect(() => lc.reopenFeature("feat/nope")).toThrow(lc.LifecycleError);
    try {
      lc.reopenFeature("feat/nope");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// setCap
// ---------------------------------------------------------------------------

describe("setCap", () => {
  test("sets a non-zero cap", () => {
    seedOpenFeature("feat/cap-1");
    const r = lc.setCap("feat/cap-1", 25);
    expect(r.cap_usd).toBe(25);
  });

  test("zero clears the cap", () => {
    seedOpenFeature("feat/cap-2");
    lc.setCap("feat/cap-2", 25);
    const r = lc.setCap("feat/cap-2", 0);
    expect(r.cap_usd).toBeNull();
  });

  test("null clears the cap", () => {
    seedOpenFeature("feat/cap-2b");
    lc.setCap("feat/cap-2b", 25);
    const r = lc.setCap("feat/cap-2b", null);
    expect(r.cap_usd).toBeNull();
  });

  test("negative cap throws BAD_REQUEST", () => {
    seedOpenFeature("feat/cap-3");
    expect(() => lc.setCap("feat/cap-3", -1)).toThrow(lc.LifecycleError);
    try {
      lc.setCap("feat/cap-3", -1);
    } catch (err) {
      expect((err as LifecycleError).code).toBe("BAD_REQUEST");
    }
  });

  test("NaN cap throws BAD_REQUEST", () => {
    seedOpenFeature("feat/cap-4");
    expect(() => lc.setCap("feat/cap-4", NaN)).toThrow(lc.LifecycleError);
    try {
      lc.setCap("feat/cap-4", NaN);
    } catch (err) {
      expect((err as LifecycleError).code).toBe("BAD_REQUEST");
    }
  });

  test("missing feature throws NOT_FOUND", () => {
    expect(() => lc.setCap("feat/nope", 5)).toThrow(lc.LifecycleError);
    try {
      lc.setCap("feat/nope", 5);
    } catch (err) {
      expect((err as LifecycleError).code).toBe("NOT_FOUND");
    }
  });

  test("refuses the unassigned pool", () => {
    expect(() => lc.setCap("unassigned", 5)).toThrow(lc.LifecycleError);
    try {
      lc.setCap("unassigned", 5);
    } catch (err) {
      expect((err as LifecycleError).code).toBe("UNASSIGNED");
    }
  });
});

// ---------------------------------------------------------------------------
// addTag / removeTag
// ---------------------------------------------------------------------------

describe("addTag", () => {
  test("lowercases and trims, returning the normalised value", () => {
    seedOpenFeature("feat/tags-1");
    const t = lc.addTag("feat/tags-1", "  Client:Acme  ");
    expect(t).toBe("client:acme");
    expect(lc.listTags("feat/tags-1")).toEqual(["client:acme"]);
  });

  test("is idempotent (no duplicate rows)", () => {
    seedOpenFeature("feat/tags-2");
    lc.addTag("feat/tags-2", "backend");
    lc.addTag("feat/tags-2", "backend");
    lc.addTag("feat/tags-2", "BACKEND");
    expect(lc.listTags("feat/tags-2")).toEqual(["backend"]);
    const row = db.getDb()
      .prepare(`SELECT COUNT(*) AS c FROM tags WHERE feature_id = ? AND tag = ?`)
      .get("feat/tags-2", "backend") as { c: number };
    expect(row.c).toBe(1);
  });

  test("refuses empty / whitespace tags", () => {
    seedOpenFeature("feat/tags-3");
    expect(() => lc.addTag("feat/tags-3", "   ")).toThrow(lc.LifecycleError);
    try {
      lc.addTag("feat/tags-3", "   ");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("BAD_REQUEST");
    }
  });

  test("refuses the unassigned pool", () => {
    expect(() => lc.addTag("unassigned", "x")).toThrow(lc.LifecycleError);
    try {
      lc.addTag("unassigned", "x");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("UNASSIGNED");
    }
  });

  test("refuses a missing feature", () => {
    expect(() => lc.addTag("feat/nope", "x")).toThrow(lc.LifecycleError);
    try {
      lc.addTag("feat/nope", "x");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("NOT_FOUND");
    }
  });
});

describe("removeTag", () => {
  test("deletes an existing tag and returns the new list", () => {
    seedOpenFeature("feat/tags-4");
    lc.addTag("feat/tags-4", "to-go");
    const remaining = lc.removeTag("feat/tags-4", "to-go");
    expect(remaining).toEqual([]);
  });

  test("normalises the input (case-insensitive match)", () => {
    seedOpenFeature("feat/tags-5");
    lc.addTag("feat/tags-5", "Backend");
    const remaining = lc.removeTag("feat/tags-5", "  BACKEND  ");
    expect(remaining).toEqual([]);
  });

  test("removing a non-existent tag is a no-op (returns current list)", () => {
    seedOpenFeature("feat/tags-6");
    lc.addTag("feat/tags-6", "alpha");
    const remaining = lc.removeTag("feat/tags-6", "nope");
    expect(remaining).toEqual(["alpha"]);
  });

  test("returns tags sorted", () => {
    seedOpenFeature("feat/tags-7");
    lc.addTag("feat/tags-7", "zeta");
    lc.addTag("feat/tags-7", "alpha");
    lc.addTag("feat/tags-7", "mu");
    const remaining = lc.removeTag("feat/tags-7", "mu");
    expect(remaining).toEqual(["alpha", "zeta"]);
  });

  test("refuses the unassigned pool", () => {
    expect(() => lc.removeTag("unassigned", "x")).toThrow(lc.LifecycleError);
    try {
      lc.removeTag("unassigned", "x");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("UNASSIGNED");
    }
  });

  test("refuses a missing feature", () => {
    expect(() => lc.removeTag("feat/nope", "x")).toThrow(lc.LifecycleError);
    try {
      lc.removeTag("feat/nope", "x");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// attachNote
// ---------------------------------------------------------------------------

describe("attachNote", () => {
  test("inserts a note and returns the new row (id, body, created_at)", () => {
    seedOpenFeature("feat/note-1");
    const note = lc.attachNote("feat/note-1", "a standalone note");
    expect(note.id).toBeGreaterThan(0);
    expect(note.body).toBe("a standalone note");
    expect(note.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const fromDb = db.getNotes("feat/note-1");
    expect(fromDb.length).toBe(1);
    expect(fromDb[0].body).toBe("a standalone note");
  });

  test("rejects empty body with BAD_REQUEST", () => {
    seedOpenFeature("feat/note-2");
    expect(() => lc.attachNote("feat/note-2", "")).toThrow(lc.LifecycleError);
    try {
      lc.attachNote("feat/note-2", "");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("BAD_REQUEST");
    }
  });

  test("rejects whitespace-only body with BAD_REQUEST", () => {
    seedOpenFeature("feat/note-3");
    expect(() => lc.attachNote("feat/note-3", "   \n  ")).toThrow(lc.LifecycleError);
    try {
      lc.attachNote("feat/note-3", "   \n  ");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("BAD_REQUEST");
    }
  });

  test("refuses a missing feature with NOT_FOUND", () => {
    expect(() => lc.attachNote("feat/nope", "x")).toThrow(lc.LifecycleError);
    try {
      lc.attachNote("feat/nope", "x");
    } catch (err) {
      expect((err as LifecycleError).code).toBe("NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// WAL concurrency: a second process can write to the same DB while
// the server has it open. SQLite WAL serialises writes between the
// two connections; both see each other's writes after commit. The
// dashboard server is a secondary writer; the extension is the
// primary writer. This test simulates that with two `bun:sqlite`
// connections in the same process, which behave like two processes
// (separate file handles, separate statement caches).
// ---------------------------------------------------------------------------

describe("WAL concurrency with a second writer", () => {
  test("another connection's writes are visible to the server's reads", () => {
    seedOpenFeature("feat/wal-1");
    // Simulate the extension inserting a message while the server
    // has the DB open. Uses a fresh `bun:sqlite` connection on the
    // same file, which is what the extension would look like.
    const other = new Database(DB_PATH);
    other
      .prepare(
        `INSERT INTO messages
           (id, feature_id, session_id, model, provider,
            input_tokens, output_tokens, cache_read, cache_write,
            cost_usd, cost_input, cost_output, cost_cache_read,
            cost_cache_write, cost_unknown, timestamp, branch_path)
         VALUES (?, ?, ?, 'm', 'p', 100, 50, 0, 0, 0.10,
                 0.06, 0.04, 0, 0, 0, '2026-07-01T00:00:00Z', NULL)`
      )
      .run("m-1", "feat/wal-1", "/tmp/wal-1.jsonl");
    other.close();
    // Server's view of the world.
    const messages = db.getMessages("feat/wal-1");
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe("m-1");
  });

  test("server's writes are visible to a second connection's reads", () => {
    seedOpenFeature("feat/wal-2");
    lc.addTag("feat/wal-2", "wal-test");
    const other = new Database(DB_PATH);
    const row = other
      .prepare(`SELECT tag FROM tags WHERE feature_id = ?`)
      .get("feat/wal-2") as { tag: string } | null;
    expect(row).not.toBeNull();
    expect(row!.tag).toBe("wal-test");
    other.close();
  });

  test("a close on the server while the other writer is inserting does not corrupt the DB", () => {
    seedOpenFeature("feat/wal-3");
    const other = new Database(DB_PATH);
    // Many concurrent writes from the "extension" while the server
    // performs a close. Both should commit cleanly; the final
    // feature should be 'done' and the messages should all be there.
    const insertMsg = other.prepare(
      `INSERT INTO messages
         (id, feature_id, session_id, model, provider,
          input_tokens, output_tokens, cache_read, cache_write,
          cost_usd, cost_input, cost_output, cost_cache_read,
          cost_cache_write, cost_unknown, timestamp, branch_path)
       VALUES (?, ?, ?, 'm', 'p', 1, 1, 0, 0, 0.01, 0, 0.01, 0, 0, 0, ?, NULL)`
    );
    for (let i = 0; i < 5; i++) {
      insertMsg.run(`m3-${i}`, "feat/wal-3", "/tmp/wal-3.jsonl", `2026-07-01T00:00:0${i}Z`);
    }
    lc.closeFeature("feat/wal-3", "server closed");
    // The "extension" can still insert after the close. The status
    // is now 'done' but the message inserts commit.
    insertMsg.run("m3-final", "feat/wal-3", "/tmp/wal-3.jsonl", "2026-07-01T00:00:10Z");
    other.close();
    const f = db.getFeature("feat/wal-3");
    expect(f?.status).toBe("done");
    const msgs = db.getMessages("feat/wal-3");
    expect(msgs.length).toBe(6);
  });
});
