/**
 * Notifications — pi adapter.
 *
 * Phase 9 step 9 (MULTI-TOOL.md §9 v1.5): the tool-agnostic parts
 * (sendNative, postWebhook, computeDailyDigest, threshold debounce)
 * moved to @costlens/core/notifications. This file is now a thin pi
 * adapter that:
 *   1. Re-exports the tool-agnostic parts for existing call sites.
 *   2. Adds the pi-specific `notify(ctx)` wrapper that routes through
 *      `ctx.ui.notify()` before falling back to the native notifier.
 *   3. Provides `fireThresholdNotification(feature, ctx)` which uses
 *      `checkThresholdsAndFire` from core and then dispatches via `notify`.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  sendNative,
  postWebhook,
  computeDailyDigest,
  utcYesterdayDate,
  checkThresholdsAndFire,
  seedFiredFromCurrentCosts as seedFiredFromCurrentCostsFn,
  clearFiredForFeature,
  _resetFiredForTest,
  emojiForLevel,
  type Level,
  type Digest,
  type ThresholdFiring,
} from "@costlens/core";
import { readConfig, type CostlensConfig } from "./config.js";
import type { Feature } from "./lifecycle.js";

// Re-export the tool-agnostic surface so existing import sites keep
// working unchanged.
export {
  sendNative,
  postWebhook,
  computeDailyDigest,
  utcYesterdayDate,
  checkThresholdsAndFire,
  clearFiredForFeature,
  _resetFiredForTest,
  _resetFiredForTest as _resetForTest, // legacy alias used by pi tests
  emojiForLevel,
  type Level,
  type Digest,
  type ThresholdFiring,
};

/**
 * pi adapter wrapper: calls core's seedFiredFromCurrentCosts with the
 * config from readConfig() so the existing no-arg call in index.ts works.
 */
export function seedFiredFromCurrentCosts(): void {
  // Import config lazily (circular imports otherwise).
  const cfg = readConfig();
  seedFiredFromCurrentCostsFn(cfg);
}

export type NotifyOpts = { emoji?: string };

// ---------------------------------------------------------------------------
// pi-specific: in-pi notification + native
// ---------------------------------------------------------------------------

/**
 * Fire a notification:
 *   1. In-pi (if ctx.hasUI) via ctx.ui.notify — always visible in the TUI.
 *   2. Native OS via sendNative — visible even when the TUI isn't in focus.
 */
export async function notify(
  title: string,
  body: string,
  level: Level,
  ctx?: ExtensionContext,
  opts: NotifyOpts = {}
): Promise<void> {
  if (ctx?.hasUI) {
    const piLevel: "info" | "warning" | "error" =
      level === "info" ? "info" : level === "warn" ? "warning" : "error";
    try {
      await ctx.ui.notify(`${title}\n${body}`, piLevel);
    } catch {
      // best-effort
    }
  }
  await sendNative(title, body, level, opts.emoji);
}

// ---------------------------------------------------------------------------
// pi-specific: threshold notification
// ---------------------------------------------------------------------------

export function fireThresholdNotification(
  feature: Feature,
  cost: number,
  cap: number,
  ctx?: ExtensionContext
): void {
  const cfg = readConfig();
  const firings = checkThresholdsAndFire(feature, cost, cap, cfg);
  for (const f of firings) {
    void notify(`Costlens: ${feature.id}`, f.body, f.level, ctx);
    if (cfg.notifications.webhook) {
      void postWebhook(cfg.notifications.webhook, f.webhookPayload);
    }
  }
}
