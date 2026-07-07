/**
 * Status bar / footer.
 *
 * Renders: "● <name>  $X / $cap  ▏N turns  ▏<model>  [marker]"
 *
 * Color logic (ANSI, applied to the cost amount and the leading ●):
 *   - no cap                 → white / default
 *   - cost < 50% of cap      → green
 *   - cost 50-80% of cap     → yellow
 *   - cost 80-100% of cap    → bright yellow
 *   - cost > 100% of cap     → red
 *
 * Text markers (always present, even if pi's TUI strips ANSI):
 *   - cost 80-100%           → "  ! near cap"
 *   - cost > 100%            → "  ✗ over cap by $X.XX"
 *
 * `formatFooterText` is pure & testable; `renderFooter` is the side-effect
 * wrapper that talks to `ctx.ui.setStatus`. The two are split so we can
 * cover the formatting with unit tests.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDb } from "./db.js";
import { getCurrentFeatureId, type Feature } from "./lifecycle.js";

const STATUS_KEY = "costlens";

// ANSI escape codes. Wrapped in helpers so the formatter stays readable.
const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const BRIGHT_YELLOW = `${ESC}93m`;
const RED = `${ESC}31m`;
const BRIGHT_RED = `${ESC}91m`;
const DIM = `${ESC}2m`;

export type CostLevel = "default" | "ok" | "warn" | "high" | "over";

export function costLevel(cost: number, cap: number | null): CostLevel {
  if (cap == null || cap <= 0) return "default";
  if (cost > cap) return "over";
  const ratio = cost / cap;
  if (ratio >= 0.8) return "high";
  if (ratio >= 0.5) return "warn";
  return "ok";
}

function colorFor(level: CostLevel): string {
  switch (level) {
    case "ok": return GREEN;
    case "warn": return YELLOW;
    case "high": return BRIGHT_YELLOW;
    case "over": return BRIGHT_RED;
    default: return "";
  }
}

/** Wrap `text` with an ANSI color only if `color` is non-empty. */
function paint(text: string, color: string): string {
  return color ? `${color}${text}${RESET}` : text;
}

function capMarker(cost: number, cap: number | null, level: CostLevel): string {
  if (level === "over" && cap != null) {
    return `  ✗ over cap by $${(cost - cap).toFixed(2)}`;
  }
  if (level === "high" && cap != null) {
    const pct = (cost / cap) * 100;
    return `  ! ${pct.toFixed(0)}% of $${cap.toFixed(2)} cap`;
  }
  return "";
}

export type FormatOptions = { useColor?: boolean };

/**
 * Pure formatter. Returns the string the footer should display.
 * Exposed for testing.
 */
export function formatFooterText(
  feature: Pick<
    Feature,
    "name" | "total_cost_usd" | "turn_count" | "cap_usd" | "status" | "pricing_conf"
  >,
  model: string | null,
  opts: FormatOptions = {}
): string {
  const useColor = opts.useColor ?? true;
  const cost = feature.total_cost_usd;
  const cap = feature.cap_usd;
  const level = costLevel(cost, cap);

  const costStr = `$${cost.toFixed(4)}`;
  const capPart = cap != null ? ` / $${cap.toFixed(2)} cap` : " / no cap";
  const marker = capMarker(cost, cap, level);
  const turnPart = `▏${feature.turn_count} turn${feature.turn_count === 1 ? "" : "s"}`;
  const modelPart = `▏${model ?? "?"}`;

  const pricingBadge = feature.pricing_conf !== "complete" ? `  [${feature.pricing_conf}]` : "";
  const statusBadge = feature.status !== "open" ? `  (${feature.status})` : "";

  if (!useColor) {
    return (
      `● ${feature.name}  ${costStr}${capPart}  ${turnPart}  ${modelPart}` +
      `${marker}${pricingBadge}${statusBadge}`
    );
  }

  // Color the ● and the cost amount with the level color; the rest
  // is neutral so the line stays readable.
  const dot = paint("●", colorFor(level));
  const costColored = paint(costStr, colorFor(level));
  // The cap marker is colored to draw the eye when nearing/exceeding cap.
  const markerColored =
    level === "over" ? paint(marker, BRIGHT_RED)
    : level === "high" ? paint(marker, BRIGHT_YELLOW)
    : marker;
  // Subtle dim for badges to keep them quiet.
  const badges = pricingBadge || statusBadge
    ? paint(`${pricingBadge}${statusBadge}`, DIM)
    : "";

  return (
    `${dot} ${feature.name}  ${costColored}${capPart}  ${turnPart}  ${modelPart}` +
    `${markerColored}${badges}`
  );
}

export function renderFooter(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return; // skip in print/JSON mode

  const featureId = getCurrentFeatureId(ctx);
  if (!featureId || featureId === "unassigned") {
    clearFooter(ctx);
    return;
  }

  const feature = getDb()
    .prepare(
      `SELECT name, total_cost_usd, turn_count, cap_usd, status, pricing_conf
       FROM features WHERE id = ?`
    )
    .get(featureId) as
    | {
        name: string;
        total_cost_usd: number;
        turn_count: number;
        cap_usd: number | null;
        status: "open" | "done" | "abandoned" | "merged";
        pricing_conf: "complete" | "partial" | "unknown";
      }
    | undefined;

  if (!feature) {
    clearFooter(ctx);
    return;
  }

  const modelRow = getDb()
    .prepare(
      `SELECT model FROM messages
       WHERE feature_id = ?
       ORDER BY timestamp DESC LIMIT 1`
    )
    .get(featureId) as { model: string } | undefined;

  ctx.ui.setStatus(STATUS_KEY, formatFooterText(feature, modelRow?.model ?? null));
}

export function clearFooter(ctx: ExtensionContext): void {
  ctx.ui.setStatus(STATUS_KEY, "");
}

// Re-export for tests
export const _ansi = { GREEN, YELLOW, BRIGHT_YELLOW, RED, BRIGHT_RED, DIM, RESET };
