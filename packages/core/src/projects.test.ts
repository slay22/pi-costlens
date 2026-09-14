/**
 * Tests for the standing project mapping (config `projects`) and the
 * totals repair that `costlens claim` leans on.
 *
 * Phase 10. Motivation: every repo worked on a main branch pooled its
 * cost into the single global `unassigned` feature, so per-project
 * totals were indistinguishable. A directory → feature mapping, applied
 * only when git resolution lands on `unassigned`, keeps per-branch
 * granularity while giving each project its own line.
 *
 * Covered here:
 *   - `projectFeatureFor`: exact / nested / longest-prefix / boundary /
 *     trailing slash / no-match.
 *   - `sanitizeProjects`: drops junk, tolerates missing config.
 *   - `ensureFeatureForSession`: a mapped directory creates (never
 *     prompts) its feature; a closed mapped feature falls back to
 *     unassigned, same rule as branch features.
 *   - `recomputeFeatureTotals`: rebuilds cost/turns/first/last from
 *     `messages` (both sides of a move).
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setCoreDb, closeCoreDb, applySchema, getCoreDb } from "./db.js";
import {
  projectFeatureFor,
  ensureFeatureForSession,
  recomputeFeatureTotals,
  recordMessageAndUpdateFeature,
  UNASSIGNED_ID,
  type MessageInsert,
} from "./lifecycle.js";
import { readConfig, writeConfig, sanitizeProjects } from "./config.js";

// ---------------------------------------------------------------------------
// projectFeatureFor (pure)
// ---------------------------------------------------------------------------

describe("projectFeatureFor", () => {
  const projects = {
    "/Users/leo/Develop/receiptScanner": "receipt-ledger",
    "/Users/leo/Develop/receiptScanner/packages": "receipt-packages",
    "/Users/leo/Develop": "develop",
  };

  test("exact directory match", () => {
    assert.equal(projectFeatureFor("/Users/leo/Develop/receiptScanner", projects), "receipt-ledger");
  });

  test("nested directory matches its parent mapping", () => {
    assert.equal(
      projectFeatureFor("/Users/leo/Develop/receiptScanner/public/js", projects),
      "receipt-ledger"
    );
  });

  test("longest prefix wins", () => {
    assert.equal(
      projectFeatureFor("/Users/leo/Develop/receiptScanner/packages/core", projects),
      "receipt-packages"
    );
  });

  test("prefix must land on a path boundary", () => {
    // /Users/leo/DevelopXXX is NOT inside /Users/leo/Develop.
    assert.equal(projectFeatureFor("/Users/leo/DevelopXXX/app", projects), null);
    // ...while the mapping itself still matches.
    assert.equal(projectFeatureFor("/Users/leo/DevelopXXX", projects), null);
  });

  test("trailing slashes on either side are ignored", () => {
    assert.equal(projectFeatureFor("/Users/leo/Develop/receiptScanner/", projects), "receipt-ledger");
    assert.equal(projectFeatureFor("/Users/leo/Develop/receiptScanner", { "/Users/leo/Develop/receiptScanner/": "x" }), "x");
  });

  test("no match / no cwd / no map → null", () => {
    assert.equal(projectFeatureFor("/tmp/elsewhere", projects), null);
    assert.equal(projectFeatureFor(null, projects), null);
    assert.equal(projectFeatureFor("/Users/leo/Develop", null), null);
    assert.equal(projectFeatureFor("/Users/leo/Develop", {}), null);
  });

  test("root mapping matches everything", () => {
    assert.equal(projectFeatureFor("/anything/at/all", { "/": "everything" }), "everything");
  });
});

describe("sanitizeProjects", () => {
  test("drops non-strings, empties, and normalizes trailing slashes", () => {
    assert.deepEqual(
      sanitizeProjects({
        "/a/b/": "feat-b",
        "/a/c": "feat-c",
        "/a/d": "",
        "/a/e": 42 as unknown as string,
        "": "ghost",
      }),
      { "/a/b": "feat-b", "/a/c": "feat-c" }
    );
  });

  test("junk degrades to an empty map", () => {
    assert.deepEqual(sanitizeProjects(undefined), {});
    assert.deepEqual(sanitizeProjects("nope"), {});
    assert.deepEqual(sanitizeProjects(["a"]), {});
  });
});

// ---------------------------------------------------------------------------
// ensureFeatureForSession with a project mapping
// ---------------------------------------------------------------------------

let testHome: string;
let previousHome: string | undefined;

before(() => {
  testHome = mkdtempSync(join(tmpdir(), "costlens-projects-"));
  previousHome = process.env.COSTLENS_HOME;
  process.env.COSTLENS_HOME = testHome;
});

after(() => {
  closeCoreDb();
  if (previousHome === undefined) delete process.env.COSTLENS_HOME;
  else process.env.COSTLENS_HOME = previousHome;
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
});

function freshDb(): DatabaseSync {
  closeCoreDb();
  const db = new DatabaseSync(":memory:");
  setCoreDb(db as unknown as Parameters<typeof setCoreDb>[0]);
  applySchema(db as unknown as Parameters<typeof applySchema>[0]);
  return db;
}

/** Config with only a project mapping; notifications defaulted. */
function writeConfigWithProjects(projects: Record<string, string>) {
  const cfg = readConfig();
  writeConfig({ ...cfg, projects });
}

const MAIN_GIT = { isRepo: true, branch: "main", isMainBranch: true };

describe("ensureFeatureForSession: project mapping", () => {
  beforeEach(() => {
    freshDb();
  });

  test("mapped cwd on main claims its project feature without prompting", async () => {
    writeConfigWithProjects({ "/work/app": "my-app" });
    let prompted = false;
    const id = await ensureFeatureForSession(
      { cwd: "/work/app", sessionFile: "/sessions/s1.jsonl", git: MAIN_GIT },
      async () => {
        prompted = true;
        return true;
      }
    );
    assert.equal(id, "my-app");
    assert.equal(prompted, false, "a standing mapping must not prompt");
    const row = readFeatureRow("my-app");
    assert.ok(row, "feature row created");
    assert.equal(row.status, "open");
    assert.equal(row.branch, null, "project features are not branch-owned");
    // sessions rows follow the resolved feature.
    const sess = readSessionRow("/sessions/s1.jsonl");
    assert.equal(sess?.feature_id, "my-app");
  });

  test("nested cwd resolves to the same project feature", async () => {
    writeConfigWithProjects({ "/work/app": "my-app" });
    const id = await ensureFeatureForSession(
      { cwd: "/work/app/sub/dir", sessionFile: "/sessions/s2.jsonl", git: MAIN_GIT },
      async () => true
    );
    assert.equal(id, "my-app");
  });

  test("unmapped cwd still lands in unassigned", async () => {
    writeConfigWithProjects({ "/work/other": "other" });
    const id = await ensureFeatureForSession(
      { cwd: "/work/app", sessionFile: "/sessions/s3.jsonl", git: MAIN_GIT },
      async () => true
    );
    assert.equal(id, UNASSIGNED_ID);
  });

  test("a feature branch still wins over the project mapping", async () => {
    writeConfigWithProjects({ "/work/app": "my-app" });
    const id = await ensureFeatureForSession(
      {
        cwd: "/work/app",
        sessionFile: "/sessions/s4.jsonl",
        git: { isRepo: true, branch: "feat/x", isMainBranch: false },
      },
      async () => true
    );
    assert.equal(id, "feat/x", "per-branch granularity is preserved");
  });

  test("closed mapped feature is not auto-resumed (falls back to unassigned)", async () => {
    writeConfigWithProjects({ "/work/app": "my-app" });
    const db = freshDb();
    db.prepare(
      `INSERT INTO features (id, name, branch, status, pricing_conf, started_at)
       VALUES ('my-app', 'my-app', NULL, 'done', 'complete', '2026-01-01T00:00:00.000Z')`
    ).run();
    const id = await ensureFeatureForSession(
      { cwd: "/work/app", sessionFile: "/sessions/s5.jsonl", git: MAIN_GIT },
      async () => true
    );
    assert.equal(id, UNASSIGNED_ID);
  });
});

function readFeatureRow(id: string) {
  return getCoreDb().prepare(`SELECT * FROM features WHERE id = ?`).get(id) as
    | { id: string; status: string; branch: string | null }
    | undefined;
}

function readSessionRow(file: string) {
  return getCoreDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(file) as
    | { id: string; feature_id: string }
    | undefined;
}

// ---------------------------------------------------------------------------
// recomputeFeatureTotals
// ---------------------------------------------------------------------------

describe("recomputeFeatureTotals", () => {
  test("rebuilds cost, turns, and activity bounds from messages", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO features (id, name, branch, status, pricing_conf, started_at, total_cost_usd, turn_count)
       VALUES ('f1', 'f1', NULL, 'open', 'unknown', '2026-01-01T00:00:00.000Z', 999, 42)`
    ).run();
    // Stale cache: the row claims $999 / 42 turns.
    insertMessage("m1", "f1", 1.5, "2026-02-01T10:00:00.000Z");
    insertMessage("m2", "f1", 2.25, "2026-02-03T10:00:00.000Z");
    // A second feature to prove scope.
    db.prepare(
      `INSERT INTO features (id, name, branch, status, pricing_conf, started_at)
       VALUES ('f2', 'f2', NULL, 'open', 'unknown', '2026-01-01T00:00:00.000Z')`
    ).run();
    insertMessage("m3", "f2", 7, "2026-02-02T10:00:00.000Z");

    recomputeFeatureTotals("f1", db as unknown as Parameters<typeof recomputeFeatureTotals>[1]);

    const f1 = db.prepare(`SELECT * FROM features WHERE id = 'f1'`).get() as {
      total_cost_usd: number;
      turn_count: number;
      first_activity_at: string | null;
      last_activity_at: string | null;
      pricing_conf: string;
    };
    assert.equal(f1.total_cost_usd, 3.75);
    assert.equal(f1.turn_count, 2);
    assert.equal(f1.first_activity_at, "2026-02-01T10:00:00.000Z");
    assert.equal(f1.last_activity_at, "2026-02-03T10:00:00.000Z");
    assert.equal(f1.pricing_conf, "complete");

    const f2 = db.prepare(`SELECT * FROM features WHERE id = 'f2'`).get() as {
      total_cost_usd: number;
    };
    assert.equal(f2.total_cost_usd, 7, "other features untouched");
  });

  test("an emptied feature recomputes to zero", () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO features (id, name, branch, status, pricing_conf, started_at)
       VALUES ('f1', 'f1', NULL, 'open', 'unknown', '2026-01-01T00:00:00.000Z')`
    ).run();
    insertMessage("m1", "f1", 1, "2026-02-01T10:00:00.000Z");
    // Move it away to a real feature (FKs are enforced) — f1 is now empty.
    db.prepare(
      `INSERT INTO features (id, name, branch, status, pricing_conf, started_at)
       VALUES ('other', 'other', NULL, 'open', 'unknown', '2026-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(`UPDATE messages SET feature_id = 'other' WHERE id = 'm1'`).run();

    recomputeFeatureTotals("f1", db as unknown as Parameters<typeof recomputeFeatureTotals>[1]);

    const f1 = db.prepare(`SELECT * FROM features WHERE id = 'f1'`).get() as {
      total_cost_usd: number;
      turn_count: number;
      first_activity_at: string | null;
      last_activity_at: string | null;
      pricing_conf: string;
    };
    assert.equal(f1.total_cost_usd, 0);
    assert.equal(f1.turn_count, 0);
    assert.equal(f1.first_activity_at, null);
    assert.equal(f1.last_activity_at, null);
    assert.equal(f1.pricing_conf, "unknown");
  });
});

function insertMessage(id: string, featureId: string, cost: number, timestamp: string): void {
  const row: MessageInsert = {
    id,
    feature_id: featureId,
    session_id: "s1",
    model: "test-model",
    provider: "pi",
    input_tokens: 1,
    output_tokens: 1,
    cache_read: 0,
    cache_write: 0,
    cost_usd: cost,
    cost_input: 0,
    cost_output: 0,
    cost_cache_read: 0,
    cost_cache_write: 0,
    cost_unknown: 0,
    timestamp,
    branch_path: null,
    source: "pi",
  };
  recordMessageAndUpdateFeature(row);
}
