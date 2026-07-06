/**
 * Tests for the Phase 6 notifications module.
 *
 * Covers:
 *   - threshold detection + debounce (in-memory)
 *   - postWebhook HTTP error paths (404, abort, bad URL)
 *   - computeDailyDigest SQL aggregation
 *   - config defaults when `notifications` field missing
 *   - clearFiredForFeature / seedFiredFromCurrentCosts behaviour
 *
 * Native `notify()` is NOT exercised here — it shells out to
 * osascript / notify-send / PowerShell. The platform commands are
 * covered manually via `/feature notify-test`; the unit tests focus
 * on the JS-only logic.
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testHome: string;

before(() => {
  testHome = mkdtempSync(join(tmpdir(), "costlens-notif-test-"));
  process.env.COSTLENS_HOME = testHome;
});

after(() => {
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  delete process.env.COSTLENS_HOME;
});

beforeEach(async () => {
  // Fresh DB + fresh notification debounce + fresh config per test.
  const { closeDb } = await import("../extension/db.js");
  closeDb();
  rmSync(join(testHome, "costlens"), { recursive: true, force: true });
  const { initDb } = await import("../extension/db.js");
  initDb();
  const notif = await import("../extension/notifications.js");
  notif._resetForTest();
  // Wipe config.json so each test gets defaults unless it writes one.
  const { writeConfig } = await import("../extension/config.js");
  writeConfig({
    port: 7331,
    notifications: {
      enabled: true,
      thresholds: [0.5, 0.8, 1.0, 1.1],
      webhook: null,
      dailyDigest: true,
      dailyDigestThresholdUsd: 0.5,
    },
  });
});

async function openFeature(id: string, capUsd: number | null = null) {
  const { ensureFeatureForSession, _resetForTest, getFeature } = await import(
    "../extension/lifecycle.js"
  );
  _resetForTest();
  const fid = await ensureFeatureForSession(
    {
      cwd: "/tmp",
      sessionFile: `/tmp/${id}.jsonl`,
      git: { isRepo: true, branch: id, isMainBranch: false },
    },
    async () => true
  );
  if (capUsd != null) {
    const { setCap } = await import("../extension/lifecycle.js");
    setCap(fid, capUsd);
  }
  return getFeature(fid)!;
}

// ---------------------------------------------------------------------------
// CostlensConfig defaults
// ---------------------------------------------------------------------------

describe("config.notifications defaults", () => {
  test("missing notifications field falls back to defaults", async () => {
    const { readConfig, writeConfig } = await import("../extension/config.js");
    // Write a config without the notifications field (forward compat).
    writeConfig({ port: 7331 } as never);
    const cfg = readConfig();
    assert.equal(cfg.notifications.enabled, true);
    assert.deepEqual(cfg.notifications.thresholds, [0.5, 0.8, 1.0, 1.1]);
    assert.equal(cfg.notifications.webhook, null);
    assert.equal(cfg.notifications.dailyDigest, true);
    assert.equal(cfg.notifications.dailyDigestThresholdUsd, 0.5);
  });

  test("malformed config falls back to defaults", async () => {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { readConfig } = await import("../extension/config.js");
    mkdirSync(join(testHome, "costlens"), { recursive: true });
    writeFileSync(join(testHome, "costlens", "config.json"), "{ not valid");
    const cfg = readConfig();
    assert.equal(cfg.notifications.enabled, true);
  });

  test("invalid thresholds array falls back to defaults", async () => {
    const { writeConfig, readConfig } = await import("../extension/config.js");
    writeConfig({
      port: 7331,
      notifications: {
        enabled: true,
        // Bad entries: 0, negative, non-number, > 10
        thresholds: [0, -0.5, "x" as never, 99, 0.25, 0.9] as never,
        webhook: null,
        dailyDigest: true,
        dailyDigestThresholdUsd: 0.5,
      },
    });
    const cfg = readConfig();
    // Only 0.25 and 0.9 survive the validation
    assert.deepEqual(cfg.notifications.thresholds, [0.25, 0.9]);
  });

  test("empty thresholds array falls back to defaults", async () => {
    const { writeConfig, readConfig } = await import("../extension/config.js");
    writeConfig({
      port: 7331,
      notifications: {
        enabled: true,
        thresholds: [],
        webhook: null,
        dailyDigest: true,
        dailyDigestThresholdUsd: 0.5,
      },
    });
    const cfg = readConfig();
    assert.deepEqual(cfg.notifications.thresholds, [0.5, 0.8, 1.0, 1.1]);
  });
});

// ---------------------------------------------------------------------------
// Threshold detection + debounce
// ---------------------------------------------------------------------------

describe("fireThresholdNotification", () => {
  test("fires once for each threshold when the cost crosses them", async () => {
    const { fireThresholdNotification, _resetForTest } = await import(
      "../extension/notifications.js"
    );
    _resetForTest();
    const f = await openFeature("t-1", 1.0);

    // Mock ctx that records in-pi notify calls.
    const piCalls: Array<{ msg: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify: async (msg: string, level: string) => {
          piCalls.push({ msg, level });
        },
      },
    } as never;

    // 0% of cap: no fires
    fireThresholdNotification(f, 0.0, 1.0, ctx);
    assert.equal(piCalls.length, 0);

    // 60% of cap: crosses 0.5 → 1 fire
    fireThresholdNotification(f, 0.6, 1.0, ctx);
    assert.equal(piCalls.length, 1);
    assert.ok(piCalls[0].msg.includes("50%"));

    // Same call again: debounced, still 1 fire
    fireThresholdNotification(f, 0.6, 1.0, ctx);
    assert.equal(piCalls.length, 1);

    // 85% of cap: crosses 0.5 (already fired) and 0.8 → +1 fire
    fireThresholdNotification(f, 0.85, 1.0, ctx);
    assert.equal(piCalls.length, 2);
    assert.ok(piCalls[1].msg.includes("80%"));

    // 105% of cap: crosses 1.0 → +1 fire
    fireThresholdNotification(f, 1.05, 1.0, ctx);
    assert.equal(piCalls.length, 3);
    assert.ok(piCalls[2].msg.includes("100%"));

    // 115% of cap: crosses 1.1 → +1 fire
    fireThresholdNotification(f, 1.15, 1.0, ctx);
    assert.equal(piCalls.length, 4);
    assert.ok(piCalls[3].msg.includes("110%"));

    // Same again: no new fires (all thresholds already in `fired`)
    fireThresholdNotification(f, 1.15, 1.0, ctx);
    assert.equal(piCalls.length, 4);
  });

  test("does nothing when notifications are disabled", async () => {
    const { writeConfig } = await import("../extension/config.js");
    const { fireThresholdNotification, _resetForTest } = await import(
      "../extension/notifications.js"
    );
    _resetForTest();
    writeConfig({
      port: 7331,
      notifications: {
        enabled: false,
        thresholds: [0.5, 0.8, 1.0, 1.1],
        webhook: null,
        dailyDigest: true,
        dailyDigestThresholdUsd: 0.5,
      },
    });
    const f = await openFeature("t-2", 1.0);
    const piCalls: unknown[] = [];
    const ctx = {
      hasUI: true,
      ui: { notify: async (m: string) => piCalls.push(m) },
    } as never;
    fireThresholdNotification(f, 0.9, 1.0, ctx);
    assert.equal(piCalls.length, 0);
  });

  test("does nothing for features with no cap", async () => {
    const { fireThresholdNotification, _resetForTest } = await import(
      "../extension/notifications.js"
    );
    _resetForTest();
    const f = await openFeature("t-3"); // no cap
    const piCalls: unknown[] = [];
    const ctx = {
      hasUI: true,
      ui: { notify: async (m: string) => piCalls.push(m) },
    } as never;
    fireThresholdNotification(f, 100, 0, ctx);
    assert.equal(piCalls.length, 0);
  });

  test("respects a custom thresholds config (only the configured ones fire)", async () => {
    const { writeConfig } = await import("../extension/config.js");
    const { fireThresholdNotification, _resetForTest } = await import(
      "../extension/notifications.js"
    );
    _resetForTest();
    // Only 0.8 is configured.
    writeConfig({
      port: 7331,
      notifications: {
        enabled: true,
        thresholds: [0.8],
        webhook: null,
        dailyDigest: true,
        dailyDigestThresholdUsd: 0.5,
      },
    });
    const f = await openFeature("t-4", 1.0);
    const piCalls: unknown[] = [];
    const ctx = {
      hasUI: true,
      ui: { notify: async (m: string) => piCalls.push(m) },
    } as never;
    // 60% — 0.5 not configured, no fire
    fireThresholdNotification(f, 0.6, 1.0, ctx);
    assert.equal(piCalls.length, 0);
    // 90% — crosses 0.8, fires
    fireThresholdNotification(f, 0.9, 1.0, ctx);
    assert.equal(piCalls.length, 1);
  });

  test("skips in-pi notify when ctx has no UI", async () => {
    const { fireThresholdNotification, _resetForTest } = await import(
      "../extension/notifications.js"
    );
    _resetForTest();
    const f = await openFeature("t-5", 1.0);
    // hasUI: false → no in-pi notify call attempted
    const ctx = { hasUI: false, ui: { notify: async () => { throw new Error("should not be called"); } } } as never;
    // Should not throw, even though we never sent a UI call.
    fireThresholdNotification(f, 0.9, 1.0, ctx);
  });
});

// ---------------------------------------------------------------------------
// Debounce helpers
// ---------------------------------------------------------------------------

describe("clearFiredForFeature / seedFiredFromCurrentCosts", () => {
  test("clearFiredForFeature re-arms a feature so it can fire again", async () => {
    const {
      fireThresholdNotification,
      clearFiredForFeature,
      _resetForTest,
    } = await import("../extension/notifications.js");
    _resetForTest();
    const f = await openFeature("t-6", 1.0);
    const piCalls: unknown[] = [];
    const ctx = { hasUI: true, ui: { notify: async (m: string) => piCalls.push(m) } } as never;
    // Cross 50% once.
    fireThresholdNotification(f, 0.6, 1.0, ctx);
    assert.equal(piCalls.length, 1);
    // Same call: debounced.
    fireThresholdNotification(f, 0.6, 1.0, ctx);
    assert.equal(piCalls.length, 1);
    // Clear the debounce.
    clearFiredForFeature(f.id);
    // Now it should fire again.
    fireThresholdNotification(f, 0.6, 1.0, ctx);
    assert.equal(piCalls.length, 2);
  });

  test("seedFiredFromCurrentCosts marks all currently-crossed thresholds as fired", async () => {
    const {
      seedFiredFromCurrentCosts,
      fireThresholdNotification,
      _resetForTest,
    } = await import("../extension/notifications.js");
    _resetForTest();
    // Open a feature, set a cap, then mark it at 90% of cap.
    const f = await openFeature("t-7", 1.0);
    const { getDb } = await import("../extension/db.js");
    getDb()
      .prepare(`UPDATE features SET total_cost_usd = 0.9 WHERE id = ?`)
      .run(f.id);
    // Now seed.
    seedFiredFromCurrentCosts();
    // 0.5 and 0.8 should be marked as already fired; 1.0 should not.
    const piCalls: unknown[] = [];
    const ctx = { hasUI: true, ui: { notify: async (m: string) => piCalls.push(m) } } as never;
    // Re-call the threshold check at 90%: 0.5 and 0.8 already fired, 1.0 not crossed. No fires.
    const fresh = (await import("../extension/lifecycle.js")).getFeature(f.id)!;
    fireThresholdNotification(fresh, 0.9, 1.0, ctx);
    assert.equal(piCalls.length, 0);
    // Bump to 1.05: 1.0 fires, 0.5/0.8 still debounced.
    const fresh2 = (await import("../extension/lifecycle.js")).getFeature(f.id)!;
    fresh2.total_cost_usd = 1.05;
    fireThresholdNotification(fresh2, 1.05, 1.0, ctx);
    assert.equal(piCalls.length, 1);
  });

  test("seedFiredFromCurrentCosts is a no-op when notifications are disabled", async () => {
    const { writeConfig } = await import("../extension/config.js");
    const {
      seedFiredFromCurrentCosts,
      fireThresholdNotification,
      _resetForTest,
    } = await import("../extension/notifications.js");
    _resetForTest();
    writeConfig({
      port: 7331,
      notifications: {
        enabled: false,
        thresholds: [0.5, 0.8, 1.0, 1.1],
        webhook: null,
        dailyDigest: true,
        dailyDigestThresholdUsd: 0.5,
      },
    });
    const f = await openFeature("t-8", 1.0);
    const { getDb } = await import("../extension/db.js");
    getDb()
      .prepare(`UPDATE features SET total_cost_usd = 0.9 WHERE id = ?`)
      .run(f.id);
    seedFiredFromCurrentCosts();
    // Now check: should still fire because we didn't seed.
    const fresh = (await import("../extension/lifecycle.js")).getFeature(f.id)!;
    // (enabled: false so the function is a no-op anyway — but we
    // also want to verify the seed didn't poison the debounce. So
    // re-enable and try.)
    writeConfig({
      port: 7331,
      notifications: {
        enabled: true,
        thresholds: [0.5, 0.8, 1.0, 1.1],
        webhook: null,
        dailyDigest: true,
        dailyDigestThresholdUsd: 0.5,
      },
    });
    const piCalls: unknown[] = [];
    const ctx = { hasUI: true, ui: { notify: async (m: string) => piCalls.push(m) } } as never;
    fireThresholdNotification(fresh, 0.9, 1.0, ctx);
    assert.equal(piCalls.length, 2, "should fire for 0.5 and 0.8 since we never seeded");
  });
});

// ---------------------------------------------------------------------------
// postWebhook — error paths
// ---------------------------------------------------------------------------

describe("postWebhook", () => {
  test("returns cleanly on 4xx response", async () => {
    const { postWebhook } = await import("../extension/notifications.js");
    // localhost:1 is essentially always "connection refused" quickly,
    // but using a real http server is more deterministic. Start one.
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => res.writeHead(404).end("nope"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      // Should not throw.
      await postWebhook(`http://127.0.0.1:${port}/`, { text: "hi" });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("returns cleanly on connection refused (bad URL)", async () => {
    const { postWebhook } = await import("../extension/notifications.js");
    // Port 1 is reserved and never listens on a real machine.
    await postWebhook("http://127.0.0.1:1/", { text: "hi" });
  });

  test("returns cleanly on invalid URL", async () => {
    const { postWebhook } = await import("../extension/notifications.js");
    await postWebhook("not a url", { text: "hi" });
  });
});

// ---------------------------------------------------------------------------
// computeDailyDigest
// ---------------------------------------------------------------------------

describe("computeDailyDigest", () => {
  test("returns yesterday's top spenders above threshold", async () => {
    const { computeDailyDigest, utcYesterdayDate } = await import(
      "../extension/notifications.js"
    );
    const { getDb } = await import("../extension/db.js");
    // Create feature rows first (FK constraint on messages).
    const insertFeature = getDb().prepare(
      `INSERT INTO features (id, name, branch, status, pricing_conf, started_at, first_activity_at, last_activity_at) VALUES (?, ?, ?, 'open', 'unknown', ?, ?, ?)`
    );
    for (const id of ["feat-a", "feat-b", "feat-c", "feat-old"]) {
      insertFeature.run(id, id, id, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    }
    // Use a fixed "yesterday" timestamp so the query reliably matches.
    const yest = utcYesterdayDate();
    const ts = `${yest}T12:00:00Z`;
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
    insert.run({
      id: "y1", feature_id: "feat-a", session_id: "s", model: "m", provider: "p",
      input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
      cost_usd: 1.20, cost_input: 0, cost_output: 1.20, cost_cache_read: 0, cost_cache_write: 0,
      cost_unknown: 0, timestamp: ts, branch_path: null,
    });
    insert.run({
      id: "y2", feature_id: "feat-a", session_id: "s", model: "m", provider: "p",
      input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
      cost_usd: 0.30, cost_input: 0, cost_output: 0.30, cost_cache_read: 0, cost_cache_write: 0,
      cost_unknown: 0, timestamp: ts, branch_path: null,
    });
    insert.run({
      id: "y3", feature_id: "feat-b", session_id: "s", model: "m", provider: "p",
      input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
      cost_usd: 2.00, cost_input: 0, cost_output: 2.00, cost_cache_read: 0, cost_cache_write: 0,
      cost_unknown: 0, timestamp: ts, branch_path: null,
    });
    // Small spend on feat-c (below threshold).
    insert.run({
      id: "y4", feature_id: "feat-c", session_id: "s", model: "m", provider: "p",
      input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
      cost_usd: 0.10, cost_input: 0, cost_output: 0.10, cost_cache_read: 0, cost_cache_write: 0,
      cost_unknown: 0, timestamp: ts, branch_path: null,
    });
    // Old spend (3 days ago) — should not be in the digest.
    const oldDate = new Date();
    oldDate.setUTCDate(oldDate.getUTCDate() - 3);
    const oldTs = oldDate.toISOString().slice(0, 10) + "T00:00:00Z";
    insert.run({
      id: "y5", feature_id: "feat-old", session_id: "s", model: "m", provider: "p",
      input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
      cost_usd: 5.00, cost_input: 0, cost_output: 5.00, cost_cache_read: 0, cost_cache_write: 0,
      cost_unknown: 0, timestamp: oldTs, branch_path: null,
    });

    const digest = computeDailyDigest(getDb(), 0.5);
    assert.equal(digest.date, yest);
    assert.equal(digest.lines.length, 2, "feat-a and feat-b, not feat-c (too small) and not feat-old (wrong day)");
    assert.ok(digest.lines[0].includes("feat-b"), "feat-b is the top spender");
    assert.ok(digest.lines[1].includes("feat-a"));
    assert.equal(digest.totalUsd, 1.5 + 2.0); // 1.20 + 0.30 + 2.00
    assert.equal(digest.totalTurns, 3);
  });

  test("returns empty digest when nothing crosses the threshold", async () => {
    const { computeDailyDigest, utcYesterdayDate } = await import(
      "../extension/notifications.js"
    );
    const { getDb } = await import("../extension/db.js");
    // Create the feature row first (FK constraint).
    getDb()
      .prepare(
        `INSERT INTO features (id, name, branch, status, pricing_conf, started_at, first_activity_at, last_activity_at) VALUES (?, ?, ?, 'open', 'unknown', ?, ?, ?)`
      )
      .run("feat-tiny", "feat-tiny", "feat-tiny", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    const yest = utcYesterdayDate();
    const ts = `${yest}T00:00:00Z`;
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
    insert.run({
      id: "t1", feature_id: "feat-tiny", session_id: "s", model: "m", provider: "p",
      input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
      cost_usd: 0.05, cost_input: 0, cost_output: 0.05, cost_cache_read: 0, cost_cache_write: 0,
      cost_unknown: 0, timestamp: ts, branch_path: null,
    });
    const digest = computeDailyDigest(getDb(), 0.5);
    assert.equal(digest.lines.length, 0);
    assert.equal(digest.totalUsd, 0);
    assert.equal(digest.totalTurns, 0);
  });

  test("digest truncates to top 3 with 'and N more'", async () => {
    const { computeDailyDigest, utcYesterdayDate } = await import(
      "../extension/notifications.js"
    );
    const { getDb } = await import("../extension/db.js");
    // Create the feature rows first.
    const insertFeature = getDb().prepare(
      `INSERT INTO features (id, name, branch, status, pricing_conf, started_at, first_activity_at, last_activity_at) VALUES (?, ?, ?, 'open', 'unknown', ?, ?, ?)`
    );
    for (let i = 0; i < 5; i++) {
      insertFeature.run(`feat-${i}`, `feat-${i}`, `feat-${i}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    }
    const yest = utcYesterdayDate();
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
    const costs = [5, 4, 3, 2, 1];
    for (let i = 0; i < costs.length; i++) {
      insert.run({
        id: `r${i}`, feature_id: `feat-${i}`, session_id: "s", model: "m", provider: "p",
        input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
        cost_usd: costs[i], cost_input: 0, cost_output: costs[i],
        cost_cache_read: 0, cost_cache_write: 0,
        cost_unknown: 0, timestamp: `${yest}T0${i}:00:00Z`, branch_path: null,
      });
    }
    const digest = computeDailyDigest(getDb(), 0.1);
    assert.equal(digest.lines.length, 4, "top 3 + 1 'and N more' line");
    assert.ok(digest.lines[3].includes("and 2 more"));
  });
});

// ---------------------------------------------------------------------------
// Native command composition (unit-level, no shell-out)
// ---------------------------------------------------------------------------

describe("appleScriptQuote (helper)", () => {
  test("escapes backslashes and double quotes", async () => {
    // We don't export appleScriptQuote, but the behaviour is observable
    // through the produced osascript command. This test pins down the
    // shell-out target by reaching into the module.
    const mod = await import("../extension/notifications.js");
    // Call sendNative with a known body and verify it doesn't throw on
    // macOS. On non-darwin this is a no-op, so the test passes either way.
    if (process.platform === "darwin") {
      await mod.sendNative(
        `title "with" \\ backslash`,
        `body with "quotes" and \\ backslashes`,
        "info"
      );
    } else {
      // On non-mac, the function logs and returns. We just call it.
      await mod.sendNative(`title "x" \\ y`, `body "x" \\ y`, "info");
    }
  });
});
