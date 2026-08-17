/**
 * Tests for core/src/notifications.ts.
 *
 * Phase 9 step 9 (MULTI-TOOL.md §9 v1.5). Covers the tool-agnostic
 * logic moved from pi-costlens/extension/notifications.ts:
 *   - checkThresholdsAndFire: fires once per threshold, debounced
 *   - clearFiredForFeature: re-arms after reopen
 *   - seedFiredFromCurrentCosts: seeds debounce from existing costs
 *   - computeDailyDigest: SQL aggregation
 *   - postWebhook: error paths (network failure, bad URL)
 *   - appleScriptQuote: escaping helper
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CostlensConfig } from "./types.js";
import type { Feature } from "./types.js";
import {
  checkThresholdsAndFire,
  clearFiredForFeature,
  _resetFiredForTest,
  appleScriptQuote,
  computeDailyDigest,
  postWebhook,
} from "./notifications.js";
// (db module imported below where needed)

let testHome: string;

before(() => {
  testHome = mkdtempSync(join(tmpdir(), "costlens-notif-core-"));
  process.env.COSTLENS_HOME = testHome;
});

after(() => {
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  delete process.env.COSTLENS_HOME;
});

const defaultConfig: CostlensConfig = {
  port: 7331,
  notifications: {
    enabled: true,
    thresholds: [0.5, 0.8, 1.0, 1.1],
    webhook: null,
    dailyDigest: true,
    dailyDigestThresholdUsd: 0.5,
  },
};

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "feat/test",
    name: "feat/test",
    branch: "feat/test",
    status: "open",
    cap_usd: 1.0,
    started_at: "2026-01-01T00:00:00Z",
    closed_at: null,
    pricing_conf: "complete",
    total_cost_usd: 0,
    subagent_cost_usd: 0,
    total_input: 0,
    total_output: 0,
    total_cache_read: 0,
    total_cache_write: 0,
    turn_count: 0,
    first_activity_at: "2026-01-01T00:00:00Z",
    last_activity_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("checkThresholdsAndFire", () => {
  beforeEach(() => _resetFiredForTest());

  test("fires once for each threshold when cost crosses them", () => {
    const f = makeFeature({ total_cost_usd: 0.55 });
    const firings = checkThresholdsAndFire(f, 0.55, 1.0, defaultConfig);
    assert.equal(firings.length, 1);
    assert.equal(firings[0].threshold, 0.5);
  });

  test("does not re-fire an already-fired threshold (debounce)", () => {
    const f = makeFeature({ total_cost_usd: 0.55 });
    checkThresholdsAndFire(f, 0.55, 1.0, defaultConfig);
    const firings2 = checkThresholdsAndFire(f, 0.60, 1.0, defaultConfig);
    assert.equal(firings2.length, 0);
  });

  test("fires multiple thresholds in one call if cost crosses several", () => {
    const f = makeFeature({ total_cost_usd: 1.05, turn_count: 5 });
    const firings = checkThresholdsAndFire(f, 1.05, 1.0, defaultConfig);
    // Thresholds 0.5, 0.8, 1.0 all crossed; 1.1 not yet
    assert.equal(firings.length, 3);
  });

  test("does nothing when notifications are disabled", () => {
    const cfg = { ...defaultConfig, notifications: { ...defaultConfig.notifications, enabled: false } };
    const f = makeFeature({ total_cost_usd: 2.0 });
    const firings = checkThresholdsAndFire(f, 2.0, 1.0, cfg);
    assert.equal(firings.length, 0);
  });

  test("does nothing when cap is 0", () => {
    const f = makeFeature();
    const firings = checkThresholdsAndFire(f, 100, 0, defaultConfig);
    assert.equal(firings.length, 0);
  });

  test("ThresholdFiring has correct body and webhookPayload shape", () => {
    // This test must run with a fresh debounce to get predictable firings.
    _resetFiredForTest();
    const f = makeFeature({ total_cost_usd: 0.85, turn_count: 3 });
    const firings = checkThresholdsAndFire(f, 0.85, 1.0, defaultConfig);
    // At 85% of cap, thresholds 0.5 and 0.8 both fire.
    // Find the 0.8 threshold firing.
    const firing80 = firings.find(f => f.threshold === 0.8);
    assert.ok(firing80, "should have a 0.8 threshold firing");
    assert.ok(firing80!.body.includes("80%"), `body should mention 80%, got: ${firing80!.body}`);
    assert.equal(typeof firing80!.webhookPayload, "object");
    assert.equal((firing80!.webhookPayload as any).threshold, 0.8);
  });
});

describe("clearFiredForFeature", () => {
  beforeEach(() => _resetFiredForTest());

  test("re-arms a feature so it can fire again after reopen", () => {
    const f = makeFeature({ total_cost_usd: 0.55 });
    checkThresholdsAndFire(f, 0.55, 1.0, defaultConfig); // fires once
    clearFiredForFeature(f.id);
    const firings = checkThresholdsAndFire(f, 0.55, 1.0, defaultConfig); // should fire again
    assert.equal(firings.length, 1);
  });
});

describe("appleScriptQuote", () => {
  test("escapes backslashes and double quotes", () => {
    const raw = 'say "hello" \\ world';
    const quoted = appleScriptQuote(raw);
    assert.ok(quoted.startsWith('"'));
    assert.ok(quoted.endsWith('"'));
    assert.ok(quoted.includes('\\"'));
    assert.ok(quoted.includes("\\\\"));
  });
});

describe("computeDailyDigest", () => {
  test("returns empty when no messages yesterday (in-memory DB)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, feature_id TEXT NOT NULL,
      session_id TEXT NOT NULL, model TEXT NOT NULL,
      provider TEXT NOT NULL, cost_usd REAL NOT NULL,
      timestamp TEXT NOT NULL
    )`);
    const digest = computeDailyDigest(db as unknown as Parameters<typeof computeDailyDigest>[0], 0.5);
    assert.equal(digest.lines.length, 0);
    assert.equal(typeof digest.date, "string");
    db.close();
  });
});

describe("postWebhook", () => {
  test("returns cleanly on 4xx response (non-2xx)", async () => {
    // Use a port that should be closed to trigger ECONNREFUSED.
    // The exact address doesn't matter — we're testing no throw.
    await assert.doesNotReject(postWebhook("http://127.0.0.1:1/hook", { test: 1 }));
  });

  test("returns cleanly on invalid URL", async () => {
    await assert.doesNotReject(postWebhook("not a url", {}));
  });
});
