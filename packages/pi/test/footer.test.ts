/**
 * Tests for the footer formatter.
 *
 * `formatFooterText` is a pure function — no DB, no pi runtime. These
 * tests cover the cost-level thresholds, text markers, and color output
 * (with and without ANSI).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatFooterText, costLevel, _ansi } from "../extension/footer.js";

function feature(overrides: Record<string, unknown> = {}) {
  return {
    name: "fix-landing",
    total_cost_usd: 4.32,
    turn_count: 12,
    cap_usd: 20,
    status: "open" as const,
    pricing_conf: "complete" as const,
    ...overrides,
  };
}

describe("costLevel", () => {
  test("no cap → default", () => {
    assert.equal(costLevel(50, null), "default");
    assert.equal(costLevel(0, null), "default");
  });

  test("zero cap → default (no cap)", () => {
    assert.equal(costLevel(50, 0), "default");
  });

  test("cost < 50% of cap → ok", () => {
    assert.equal(costLevel(5, 20), "ok"); // 25%
    assert.equal(costLevel(9.99, 20), "ok"); // 49.95%
  });

  test("cost 50-80% of cap → warn", () => {
    assert.equal(costLevel(10, 20), "warn"); // 50%
    assert.equal(costLevel(15, 20), "warn"); // 75%
    assert.equal(costLevel(15.99, 20), "warn"); // 79.95%
  });

  test("cost 80-100% of cap → high", () => {
    assert.equal(costLevel(16, 20), "high"); // 80%
    assert.equal(costLevel(20, 20), "high"); // 100%
  });

  test("cost > cap → over", () => {
    assert.equal(costLevel(20.01, 20), "over");
    assert.equal(costLevel(100, 20), "over");
  });
});

describe("formatFooterText (no color)", () => {
  test("renders the basic line", () => {
    const text = formatFooterText(feature(), "claude-opus-4-5", { useColor: false });
    assert.equal(
      text,
      "● fix-landing  $4.3200 / $20.00 cap  ▏12 turns  ▏claude-opus-4-5"
    );
  });

  test("renders 'no cap' when cap is null", () => {
    const text = formatFooterText(
      feature({ cap_usd: null }),
      "claude-opus-4-5",
      { useColor: false }
    );
    assert.ok(text.includes("/ no cap"), "shows / no cap");
    assert.ok(!text.includes("near cap"), "no marker");
    assert.ok(!text.includes("over cap"), "no marker");
  });

  test("shows 'near cap' marker at 80% of cap", () => {
    const text = formatFooterText(
      feature({ total_cost_usd: 16, cap_usd: 20 }),
      "m",
      { useColor: false }
    );
    assert.ok(text.includes("! 80% of $20.00 cap"), "shows near cap marker");
  });

  test("shows 'over cap' marker with delta when over", () => {
    const text = formatFooterText(
      feature({ total_cost_usd: 25, cap_usd: 20 }),
      "m",
      { useColor: false }
    );
    assert.ok(text.includes("✗ over cap by $5.00"), "shows over cap with delta");
  });

  test("singular 'turn' for 1 turn", () => {
    const text = formatFooterText(
      feature({ turn_count: 1 }),
      "m",
      { useColor: false }
    );
    assert.ok(text.includes("1 turn "), "uses singular 'turn'");
    assert.ok(!text.includes("1 turns"), "no plural");
  });

  test("plural 'turns' for many turns", () => {
    const text = formatFooterText(feature(), "m", { useColor: false });
    assert.ok(text.includes("12 turns"), "uses plural 'turns'");
  });

  test("status badge for done", () => {
    const text = formatFooterText(
      feature({ status: "done" }),
      "m",
      { useColor: false }
    );
    assert.ok(text.includes("(done)"), "shows (done) badge");
  });

  test("status badge for abandoned", () => {
    const text = formatFooterText(
      feature({ status: "abandoned" }),
      "m",
      { useColor: false }
    );
    assert.ok(text.includes("(abandoned)"), "shows (abandoned) badge");
  });

  test("no status badge for open", () => {
    const text = formatFooterText(feature(), "m", { useColor: false });
    assert.ok(!text.includes("(open)"), "no badge for open");
  });

  test("pricing badge when not complete", () => {
    const text = formatFooterText(
      feature({ pricing_conf: "partial" }),
      "m",
      { useColor: false }
    );
    assert.ok(text.includes("[partial]"), "shows [partial] badge");
  });

  test("no pricing badge when complete", () => {
    const text = formatFooterText(feature(), "m", { useColor: false });
    assert.ok(!text.includes("[complete]"), "no [complete] badge");
  });

  test("model '?' when null", () => {
    const text = formatFooterText(feature(), null, { useColor: false });
    assert.ok(text.includes("▏?"), "shows ? for missing model");
  });
});

describe("formatFooterText (with color)", () => {
  test("ok level uses green", () => {
    const text = formatFooterText(feature(), "m"); // default has cost=4.32, cap=20 → ok
    assert.ok(text.includes(_ansi.GREEN), "contains green ANSI");
    assert.ok(!text.includes(_ansi.YELLOW), "no yellow");
    assert.ok(!text.includes(_ansi.BRIGHT_RED), "no red");
  });

  test("warn level uses yellow", () => {
    const text = formatFooterText(
      feature({ total_cost_usd: 12, cap_usd: 20 }),
      "m"
    );
    assert.ok(text.includes(_ansi.YELLOW), "contains yellow ANSI");
  });

  test("high level uses bright yellow", () => {
    const text = formatFooterText(
      feature({ total_cost_usd: 17, cap_usd: 20 }),
      "m"
    );
    assert.ok(text.includes(_ansi.BRIGHT_YELLOW), "contains bright yellow ANSI");
  });

  test("over level uses bright red", () => {
    const text = formatFooterText(
      feature({ total_cost_usd: 25, cap_usd: 20 }),
      "m"
    );
    assert.ok(text.includes(_ansi.BRIGHT_RED), "contains bright red ANSI");
  });

  test("default level (no cap) has no color codes", () => {
    const text = formatFooterText(
      feature({ cap_usd: null, total_cost_usd: 100 }),
      "m"
    );
    assert.ok(!text.includes(_ansi.GREEN), "no green");
    assert.ok(!text.includes(_ansi.YELLOW), "no yellow");
    assert.ok(!text.includes(_ansi.BRIGHT_RED), "no red");
    assert.ok(!text.includes(_ansi.RESET), "no reset (would be wasted)");
  });

  test("all color codes are reset", () => {
    const text = formatFooterText(
      feature({ total_cost_usd: 25, cap_usd: 20, status: "done", pricing_conf: "partial" }),
      "m"
    );
    // Count only NON-reset codes as opens; the reset code is \x1b[0m.
    const allCodes = text.match(/\x1b\[\d+m/g) ?? [];
    const opens = allCodes.filter((c) => c !== "\x1b[0m").length;
    const resets = (text.match(/\x1b\[0m/g) ?? []).length;
    assert.equal(opens, resets, `opens=${opens} resets=${resets} text=${JSON.stringify(text)}`);
  });
});
