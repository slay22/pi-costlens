/**
 * Smoke tests for the Costlens ledger.
 *
 * These run with `npm test` (node --import tsx --test) and exercise the
 * DB, lifecycle, and pricing modules without needing pi's runtime.
 * The pi-coupled modules (hooks, commands, footer) are tested manually
 * inside a real pi session, plus the smoke test in extension.test.ts.
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testHome: string;

before(() => {
  testHome = mkdtempSync(join(tmpdir(), "costlens-test-"));
  process.env.COSTLENS_HOME = testHome;
});

after(() => {
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  delete process.env.COSTLENS_HOME;
});

// Reset the DB between tests so each one starts from a clean slate.
beforeEach(async () => {
  const { closeDb, initDb } = await import("../extension/db.js");
  closeDb();
  rmSync(join(testHome, "costlens"), { recursive: true, force: true });
  initDb();
});

// ---------------------------------------------------------------------------
// DB schema
// ---------------------------------------------------------------------------

describe("DB schema", () => {
  test("creates all expected tables", async () => {
    const { getDb } = await import("../extension/db.js");
    const rows = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    assert.ok(names.includes("features"), "features table exists");
    assert.ok(names.includes("messages"), "messages table exists");
    assert.ok(names.includes("tags"), "tags table exists");
    assert.ok(names.includes("notes"), "notes table exists");
    assert.ok(names.includes("sessions"), "sessions table exists");
    assert.ok(names.includes("schema_version"), "schema_version table exists");
  });

  test("schema version is 1", async () => {
    const { getDb } = await import("../extension/db.js");
    const row = getDb()
      .prepare(`SELECT MAX(version) AS v FROM schema_version`)
      .get() as { v: number };
    assert.equal(row.v, 1);
  });
});

// ---------------------------------------------------------------------------
// ensureFeatureForSession (Phase 2: prompt-driven, async)
// ---------------------------------------------------------------------------

const alwaysYes = async () => true;
const alwaysNo = async () => false;

describe("lifecycle.ensureFeatureForSession (Phase 2)", () => {
  test("creates a feature for a non-main branch when user says yes", async () => {
    const { ensureFeatureForSession, _resetForTest } = await import(
      "../extension/lifecycle.js"
    );
    _resetForTest();
    const fid = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/p1.jsonl",
        git: { isRepo: true, branch: "fix/landing", isMainBranch: false },
      },
      alwaysYes
    );
    assert.equal(fid, "fix/landing");
    const f = (await import("../extension/lifecycle.js")).getFeature(fid);
    assert.equal(f?.status, "open");
  });

  test("falls back to 'unassigned' when user says no", async () => {
    const { ensureFeatureForSession, _resetForTest, getFeature } = await import(
      "../extension/lifecycle.js"
    );
    _resetForTest();
    const fid = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/p2.jsonl",
        git: { isRepo: true, branch: "new-feature", isMainBranch: false },
      },
      alwaysNo
    );
    assert.equal(fid, "unassigned");
    assert.equal(getFeature("new-feature"), undefined, "no feature was created");
  });

  test("resumes an existing 'open' feature without prompting", async () => {
    const { ensureFeatureForSession, _resetForTest, getFeature } = await import(
      "../extension/lifecycle.js"
    );
    _resetForTest();
    await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/p3a.jsonl",
        git: { isRepo: true, branch: "feature-x", isMainBranch: false },
      },
      alwaysYes
    );
    let prompted = false;
    const fid = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/p3b.jsonl",
        git: { isRepo: true, branch: "feature-x", isMainBranch: false },
      },
      async () => {
        prompted = true;
        return true;
      }
    );
    assert.equal(fid, "feature-x");
    assert.equal(prompted, false, "should not prompt for an existing open feature");
    const f = getFeature(fid);
    assert.equal(f?.status, "open");
  });

  test("does NOT auto-resume a closed feature; falls back to unassigned", async () => {
    const {
      ensureFeatureForSession,
      closeFeature,
      _resetForTest,
    } = await import("../extension/lifecycle.js");
    _resetForTest();
    const fid = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/p4a.jsonl",
        git: { isRepo: true, branch: "done-thing", isMainBranch: false },
      },
      alwaysYes
    );
    closeFeature(fid, "shipped it");
    const resumed = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/p4b.jsonl",
        git: { isRepo: true, branch: "done-thing", isMainBranch: false },
      },
      alwaysYes
    );
    assert.equal(resumed, "unassigned", "should not auto-resume closed feature");
  });

  test("uses 'unassigned' for main / master / develop / dev", async () => {
    const { ensureFeatureForSession, _resetForTest } = await import(
      "../extension/lifecycle.js"
    );
    _resetForTest();
    for (const branch of ["main", "master", "develop", "dev"]) {
      _resetForTest();
      const fid = await ensureFeatureForSession(
        {
          cwd: "/tmp",
          sessionFile: `/tmp/main-${branch}.jsonl`,
          git: { isRepo: true, branch, isMainBranch: true },
        },
        alwaysYes
      );
      assert.equal(fid, "unassigned", `branch ${branch} → unassigned`);
    }
  });

  test("uses 'unassigned' for detached HEAD / no git", async () => {
    const { ensureFeatureForSession, _resetForTest } = await import(
      "../extension/lifecycle.js"
    );
    _resetForTest();
    const fid1 = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/detached.jsonl",
        git: { isRepo: true, branch: null, isMainBranch: false },
      },
      alwaysYes
    );
    assert.equal(fid1, "unassigned");
    _resetForTest();
    const fid2 = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/nogit.jsonl",
        git: { isRepo: false, branch: null, isMainBranch: false },
      },
      alwaysYes
    );
    assert.equal(fid2, "unassigned");
  });

  test("is idempotent across sessions on the same branch", async () => {
    const { ensureFeatureForSession, _resetForTest, getFeature } = await import(
      "../extension/lifecycle.js"
    );
    const { getDb } = await import("../extension/db.js");
    _resetForTest();
    await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/idem-a.jsonl",
        git: { isRepo: true, branch: "feature-idem", isMainBranch: false },
      },
      alwaysYes
    );
    await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/idem-b.jsonl",
        git: { isRepo: true, branch: "feature-idem", isMainBranch: false },
      },
      alwaysYes
    );
    assert.equal(getFeature("feature-idem")?.id, "feature-idem");
    const sessions = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE feature_id = ?`)
      .get("feature-idem") as { c: number };
    assert.equal(sessions.c, 2, "both sessions recorded");
  });
});

// ---------------------------------------------------------------------------
// State mutations: close / cancel / rename / setCap / reopen / note
// ---------------------------------------------------------------------------

async function openFeature(branch: string) {
  const { ensureFeatureForSession, _resetForTest, getFeature } = await import(
    "../extension/lifecycle.js"
  );
  _resetForTest();
  const id = await ensureFeatureForSession(
    {
      cwd: "/tmp",
      sessionFile: `/tmp/${branch}.jsonl`,
      git: { isRepo: true, branch, isMainBranch: false },
    },
    alwaysYes
  );
  return getFeature(id)!;
}

describe("closeFeature", () => {
  test("sets status to 'done' and records closed_at", async () => {
    const { closeFeature } = await import("../extension/lifecycle.js");
    const f = await openFeature("close-1");
    const closed = closeFeature(f.id);
    assert.equal(closed.status, "done");
    assert.notEqual(closed.closed_at, null);
  });

  test("attaches a note when provided", async () => {
    const { closeFeature, getNotes } = await import("../extension/lifecycle.js");
    const f = await openFeature("close-2");
    closeFeature(f.id, "shipped to production");
    const notes = getNotes(f.id);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].body, "shipped to production");
  });

  test("refuses to close an already-closed feature", async () => {
    const { closeFeature, LifecycleError } = await import("../extension/lifecycle.js");
    const f = await openFeature("close-3");
    closeFeature(f.id);
    assert.throws(() => closeFeature(f.id), (err: unknown) => {
      return err instanceof LifecycleError && err.code === "INVALID_STATE";
    });
  });

  test("refuses to close the unassigned pool", async () => {
    const { closeFeature, LifecycleError } = await import("../extension/lifecycle.js");
    assert.throws(() => closeFeature("unassigned"), (err: unknown) => {
      return err instanceof LifecycleError && err.code === "UNASSIGNED";
    });
  });
});

describe("cancelFeature", () => {
  test("sets status to 'abandoned' and records closed_at", async () => {
    const { cancelFeature } = await import("../extension/lifecycle.js");
    const f = await openFeature("cancel-1");
    const c = cancelFeature(f.id);
    assert.equal(c.status, "abandoned");
    assert.notEqual(c.closed_at, null);
  });

  test("attaches a note when provided", async () => {
    const { cancelFeature, getNotes } = await import("../extension/lifecycle.js");
    const f = await openFeature("cancel-2");
    cancelFeature(f.id, "abandoned in favour of rewrite");
    const notes = getNotes(f.id);
    assert.equal(notes.length, 1);
    assert.equal(notes[0].body, "abandoned in favour of rewrite");
  });

  test("refuses to cancel an already-cancelled feature", async () => {
    const { cancelFeature, LifecycleError } = await import("../extension/lifecycle.js");
    const f = await openFeature("cancel-3");
    cancelFeature(f.id);
    assert.throws(() => cancelFeature(f.id), (err: unknown) => {
      return err instanceof LifecycleError && err.code === "INVALID_STATE";
    });
  });
});

describe("renameFeature", () => {
  test("updates the name but keeps the id", async () => {
    const { renameFeature } = await import("../extension/lifecycle.js");
    const f = await openFeature("rename-1");
    const r = renameFeature(f.id, "Friendly Name");
    assert.equal(r.id, f.id);
    assert.equal(r.name, "Friendly Name");
  });

  test("rejects empty names", async () => {
    const { renameFeature, LifecycleError } = await import("../extension/lifecycle.js");
    const f = await openFeature("rename-2");
    assert.throws(() => renameFeature(f.id, "   "), (err: unknown) => {
      return err instanceof LifecycleError && err.code === "INVALID_STATE";
    });
  });
});

describe("setCap", () => {
  test("sets a non-zero cap", async () => {
    const { setCap } = await import("../extension/lifecycle.js");
    const f = await openFeature("cap-1");
    const r = setCap(f.id, 25);
    assert.equal(r.cap_usd, 25);
  });

  test("zero clears the cap", async () => {
    const { setCap } = await import("../extension/lifecycle.js");
    const f = await openFeature("cap-2");
    setCap(f.id, 25);
    const r = setCap(f.id, 0);
    assert.equal(r.cap_usd, null);
  });

  test("negative cap throws", async () => {
    const { setCap, LifecycleError } = await import("../extension/lifecycle.js");
    const f = await openFeature("cap-3");
    assert.throws(() => setCap(f.id, -1), (err: unknown) => {
      return err instanceof LifecycleError && err.code === "INVALID_STATE";
    });
  });
});

describe("reopenFeature", () => {
  test("reopens a closed feature, clears closed_at", async () => {
    const { closeFeature, reopenFeature } = await import("../extension/lifecycle.js");
    const f = await openFeature("reopen-1");
    closeFeature(f.id);
    const r = reopenFeature(f.id);
    assert.equal(r.status, "open");
    assert.equal(r.closed_at, null);
  });

  test("reopens a cancelled feature", async () => {
    const { cancelFeature, reopenFeature } = await import("../extension/lifecycle.js");
    const f = await openFeature("reopen-2");
    cancelFeature(f.id);
    const r = reopenFeature(f.id);
    assert.equal(r.status, "open");
  });

  test("refuses to reopen an already-open feature", async () => {
    const { reopenFeature, LifecycleError } = await import("../extension/lifecycle.js");
    const f = await openFeature("reopen-3");
    assert.throws(() => reopenFeature(f.id), (err: unknown) => {
      return err instanceof LifecycleError && err.code === "INVALID_STATE";
    });
  });
});

describe("listFeatures", () => {
  test("returns all features sorted by last activity", async () => {
    const { listFeatures, ensureFeatureForSession, _resetForTest } = await import(
      "../extension/lifecycle.js"
    );
    _resetForTest();
    // Two non-main branches (real features) + one unassigned (from main).
    await openFeature("list-a");
    await openFeature("list-b");
    _resetForTest();
    await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/list-main.jsonl",
        git: { isRepo: true, branch: "main", isMainBranch: true },
      },
      alwaysYes
    );
    const features = listFeatures();
    assert.equal(features.length, 3, `got ${features.length} features: ${features.map((f) => f.id).join(", ")}`);
    const ids = features.map((f) => f.id);
    assert.ok(ids.includes("list-a"));
    assert.ok(ids.includes("list-b"));
    assert.ok(ids.includes("unassigned"));
  });

  test("filters by status", async () => {
    const { closeFeature, listFeatures } = await import("../extension/lifecycle.js");
    const f = await openFeature("list-c");
    closeFeature(f.id);
    const done = listFeatures({ status: "done" });
    assert.equal(done.length, 1);
    assert.equal(done[0].id, f.id);
  });
});

// ---------------------------------------------------------------------------
// feature total rollup + pricing confidence (Phase 1 regression tests)
// ---------------------------------------------------------------------------

describe("feature total rollup", () => {
  test("sums message costs and counts turns", async () => {
    const { ensureFeatureForSession, _resetForTest } = await import(
      "../extension/lifecycle.js"
    );
    const { getDb } = await import("../extension/db.js");
    _resetForTest();
    const fid = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/rollup.jsonl",
        git: { isRepo: true, branch: "feature-y", isMainBranch: false },
      },
      alwaysYes
    );
    const insert = getDb().prepare(`
      INSERT INTO messages (
        id, feature_id, session_id, model, provider,
        input_tokens, output_tokens, cache_read, cache_write,
        cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write,
        cost_unknown, timestamp, branch_path
      ) VALUES (
        @id, @feature_id, @session_id, @model, @provider,
        @input_tokens, @output_tokens, @cache_read, @cache_write,
        @cost_usd, @cost_input, @cost_output, @cost_cache_read, @cost_cache_write,
        @cost_unknown, @timestamp, @branch_path
      )
    `);
    const rows = [
      { id: "m1", cost: 0.05, input: 100, output: 200, cache_r: 50, cache_w: 0, unknown: 0 },
      { id: "m2", cost: 0.10, input: 200, output: 400, cache_r: 100, cache_w: 0, unknown: 0 },
      { id: "m3", cost: 0.00, input: 50,  output: 100, cache_r: 25,  cache_w: 0, unknown: 1 },
    ];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      insert.run({
        id: r.id,
        feature_id: fid,
        session_id: "/tmp/rollup.jsonl",
        model: "claude-opus-4-5",
        provider: "anthropic",
        input_tokens: r.input,
        output_tokens: r.output,
        cache_read: r.cache_r,
        cache_write: r.cache_w,
        cost_usd: r.cost,
        cost_input: r.cost * 0.2,
        cost_output: r.cost * 0.8,
        cost_cache_read: 0,
        cost_cache_write: 0,
        cost_unknown: r.unknown,
        timestamp: `2024-01-01T00:0${i}:00Z`,
        branch_path: null,
      });
    }
    getDb()
      .prepare(
        `UPDATE features
         SET total_cost_usd = COALESCE((SELECT SUM(cost_usd) FROM messages WHERE feature_id = ?), 0),
             total_input    = COALESCE((SELECT SUM(input_tokens) FROM messages WHERE feature_id = ?), 0),
             total_output   = COALESCE((SELECT SUM(output_tokens) FROM messages WHERE feature_id = ?), 0),
             turn_count     = COALESCE((SELECT COUNT(*) FROM messages WHERE feature_id = ?), 0)
         WHERE id = ?`
      )
      .run(fid, fid, fid, fid, fid);
    const row = getDb()
      .prepare(
        `SELECT total_cost_usd, total_input, total_output, turn_count
         FROM features WHERE id = ?`
      )
      .get(fid) as Record<string, number>;
    assert.equal(Math.round(row.total_cost_usd * 100) / 100, 0.15);
    assert.equal(row.total_input, 350);
    assert.equal(row.total_output, 700);
    assert.equal(row.turn_count, 3);
  });
});

describe("pricing confidence", () => {
  test("returns 'complete' when all messages priced", async () => {
    const { computePricingConfidence } = await import("../extension/pricing.js");
    const { ensureFeatureForSession, _resetForTest } = await import(
      "../extension/lifecycle.js"
    );
    const { getDb } = await import("../extension/db.js");
    _resetForTest();
    const fid = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/price1.jsonl",
        git: { isRepo: true, branch: "feature-c", isMainBranch: false },
      },
      alwaysYes
    );
    getDb()
      .prepare(
        `INSERT INTO messages (id, feature_id, session_id, model, provider,
          input_tokens, output_tokens, cache_read, cache_write,
          cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write,
          cost_unknown, timestamp, branch_path)
         VALUES (?, ?, ?, 'm', 'p', 1, 1, 0, 0, 0.01, 0, 0.01, 0, 0, 0, '2024-01-01', NULL)`
      )
      .run("p1", fid, "/tmp/price1.jsonl");
    assert.equal(computePricingConfidence(getDb(), fid), "complete");
  });

  test("returns 'partial' when some messages unknown", async () => {
    const { computePricingConfidence } = await import("../extension/pricing.js");
    const { ensureFeatureForSession, _resetForTest } = await import(
      "../extension/lifecycle.js"
    );
    const { getDb } = await import("../extension/db.js");
    _resetForTest();
    const fid = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/price2.jsonl",
        git: { isRepo: true, branch: "feature-d", isMainBranch: false },
      },
      alwaysYes
    );
    getDb()
      .prepare(
        `INSERT INTO messages (id, feature_id, session_id, model, provider,
          input_tokens, output_tokens, cache_read, cache_write,
          cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write,
          cost_unknown, timestamp, branch_path)
         VALUES (?, ?, ?, 'm', 'p', 1, 1, 0, 0, 0.01, 0, 0.01, 0, 0, 0, '2024-01-01', NULL)`
      )
      .run("p2", fid, "/tmp/price2.jsonl");
    getDb()
      .prepare(
        `INSERT INTO messages (id, feature_id, session_id, model, provider,
          input_tokens, output_tokens, cache_read, cache_write,
          cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write,
          cost_unknown, timestamp, branch_path)
         VALUES (?, ?, ?, 'm', 'p', 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, '2024-01-01', NULL)`
      )
      .run("p3", fid, "/tmp/price2.jsonl");
    assert.equal(computePricingConfidence(getDb(), fid), "partial");
  });

  test("returns 'unknown' when all messages unknown", async () => {
    const { computePricingConfidence } = await import("../extension/pricing.js");
    const { ensureFeatureForSession, _resetForTest } = await import(
      "../extension/lifecycle.js"
    );
    const { getDb } = await import("../extension/db.js");
    _resetForTest();
    const fid = await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/price3.jsonl",
        git: { isRepo: true, branch: "feature-e", isMainBranch: false },
      },
      alwaysYes
    );
    getDb()
      .prepare(
        `INSERT INTO messages (id, feature_id, session_id, model, provider,
          input_tokens, output_tokens, cache_read, cache_write,
          cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write,
          cost_unknown, timestamp, branch_path)
         VALUES (?, ?, ?, 'm', 'p', 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, '2024-01-01', NULL)`
      )
      .run("p4", fid, "/tmp/price3.jsonl");
    assert.equal(computePricingConfidence(getDb(), fid), "unknown");
  });
});
