import { test, expect } from "bun:test";
import {
  pickCcusageSession,
  ccusageSessionToInserts,
  shapeFeatureReport,
  SOURCE_CLAUDE,
  type CcusageSession,
} from "./lib.ts";

const sessions: CcusageSession[] = [
  { period: "aaaa1111-0000", metadata: { lastActivity: "2026-01-01T00:00:00Z" }, totalCost: 1 },
  { period: "bbbb2222-9999", metadata: { lastActivity: "2026-03-03T00:00:00Z" }, totalCost: 2 },
];

test("pickCcusageSession: substring match on period", () => {
  expect(pickCcusageSession(sessions, "bbbb2222")?.period).toBe("bbbb2222-9999");
});

test("pickCcusageSession: no id → most recently active", () => {
  expect(pickCcusageSession(sessions)?.period).toBe("bbbb2222-9999");
});

test("pickCcusageSession: empty / no match → null", () => {
  expect(pickCcusageSession([], "x")).toBeNull();
  expect(pickCcusageSession(sessions, "zzzz")).toBeNull();
});

test("ccusageSessionToInserts: one row per model, deterministic id, cost mapping", () => {
  const sess: CcusageSession = {
    period: "sess-123",
    metadata: { lastActivity: "2026-05-05T12:00:00Z" },
    modelBreakdowns: [
      { modelName: "claude-opus-4", inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 5, cost: 0.42 },
      { modelName: "claude-haiku-4", inputTokens: 20, outputTokens: 10, cost: 0.01 },
    ],
  };
  const rows = ccusageSessionToInserts(sess, "wi-3830", "2026-05-05T13:00:00Z");
  expect(rows).toHaveLength(2);
  expect(rows[0].id).toBe("ccusage:sess-123:claude-opus-4");
  expect(rows[0].feature_id).toBe("wi-3830");
  expect(rows[0].source).toBe(SOURCE_CLAUDE);
  expect(rows[0].cost_usd).toBe(0.42);
  expect(rows[0].input_tokens).toBe(100);
  expect(rows[0].cache_write).toBe(5);
  expect(rows[0].timestamp).toBe("2026-05-05T12:00:00Z"); // from metadata, not `now`
  expect(rows[0].cost_unknown).toBe(0);
});

test("ccusageSessionToInserts: source override tags rows (codex/gemini/…)", () => {
  const sess: CcusageSession = { period: "s", modelBreakdowns: [{ modelName: "gpt-5.6-codex", cost: 2, inputTokens: 10 }] };
  const rows = ccusageSessionToInserts(sess, "wi-1", "now", "codex");
  expect(rows[0].source).toBe("codex");
  expect(rows[0].provider).toBe("codex");
  // default stays claude-code
  expect(ccusageSessionToInserts(sess, "wi-1", "now")[0].source).toBe(SOURCE_CLAUDE);
});

test("ccusageSessionToInserts: idempotent id — re-ingest yields same ids (INSERT OR REPLACE)", () => {
  const sess: CcusageSession = { period: "s", modelBreakdowns: [{ modelName: "m", cost: 1, inputTokens: 1 }] };
  const a = ccusageSessionToInserts(sess, "f", "t1");
  const b = ccusageSessionToInserts(sess, "f", "t2");
  expect(a[0].id).toBe(b[0].id);
});

test("ccusageSessionToInserts: cost_unknown flags priced-at-zero-with-tokens (pi-style)", () => {
  const sess: CcusageSession = {
    period: "s",
    modelBreakdowns: [{ modelName: "[pi] x", inputTokens: 5, outputTokens: 5, cost: 0 }],
  };
  expect(ccusageSessionToInserts(sess, "f", "t")[0].cost_unknown).toBe(1);
});

test("ccusageSessionToInserts: falls back to modelsUsed + totalCost when no breakdowns", () => {
  const sess: CcusageSession = { period: "s", modelsUsed: ["only-model"], totalCost: 3, metadata: {} };
  const rows = ccusageSessionToInserts(sess, "f", "now");
  expect(rows).toHaveLength(1);
  expect(rows[0].model).toBe("only-model");
  expect(rows[0].cost_usd).toBe(3);
  expect(rows[0].timestamp).toBe("now"); // no lastActivity → uses `now`
});

test("shapeFeatureReport: missing feature → zeros, found=false", () => {
  const r = shapeFeatureReport("wi-9999", undefined, [], []);
  expect(r.found).toBe(false);
  expect(r.cost).toBe(0);
  expect(r.turns).toBe(0);
  expect(r.status).toBeNull();
});

test("shapeFeatureReport: maps feature row totals", () => {
  const feature: any = {
    status: "merged",
    total_cost_usd: 4.2,
    cap_usd: 10,
    total_input: 100,
    total_output: 50,
    total_cache_read: 9,
    total_cache_write: 3,
    turn_count: 7,
  };
  const r = shapeFeatureReport("wi-3830", feature, [{ model: "m", cost: 4.2, turns: 7 }], [{ source: "claude-code", cost: 4.2, turns: 7 }]);
  expect(r.found).toBe(true);
  expect(r.cost).toBe(4.2);
  expect(r.capUsd).toBe(10);
  expect(r.status).toBe("merged");
  expect(r.byModel[0].model).toBe("m");
});
