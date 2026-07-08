/**
 * Notifications — opencode adapter (v1.5).
 *
 * Wires @costlens/core's threshold-check, OS notification, webhook,
 * and daily-digest into the opencode plugin surfaces.
 *
 * Server plugin (src/server.ts) calls:
 *   fireThresholdNotificationOc(feature, cost, cap)  — after message insert
 *   maybeShowDailyDigestOc()                          — on session.created
 *
 * TUI plugin (src/tui.tsx) calls:
 *   maybeShowDailyDigestOcTui(api)  — on session.created (toast + native)
 *
 * Notification channels for opencode server plugin (no TUI access):
 *   1. Native OS (osascript / notify-send / PowerShell)
 *   2. Webhook (if configured)
 *
 * Notification channels for opencode TUI plugin:
 *   1. api.attention.notify() — opencode's built-in attention API
 *   2. api.ui.toast()         — ephemeral in-TUI toast
 *   3. Native OS
 *   4. Webhook (if configured)
 *
 * Daily digest is shown once per session.created event (idempotent
 * within a session via the in-memory `digestShownToday` flag).
 */

import {
  sendNative,
  postWebhook,
  computeDailyDigest,
  checkThresholdsAndFire,
  seedFiredFromCurrentCosts,
  getCoreDb,
  readConfig,
  type Level,
  type Feature,
} from "@costlens/core";

// Prevent showing the digest more than once per process lifetime.
let _digestShownToday = false;

export function _resetNotifStateForTest(): void {
  _digestShownToday = false;
}

// ---------------------------------------------------------------------------
// Threshold notifications (server plugin, native OS + webhook only)
// ---------------------------------------------------------------------------

/**
 * Check if any thresholds were just crossed. For each crossing:
 *   1. Send a native OS notification (silent if osascript/notify-send absent).
 *   2. POST to the webhook URL if configured.
 *
 * Called from server.ts after every completed assistant message.
 * Safe to call when the feature has no cap (returns immediately).
 */
export function fireThresholdNotificationOc(
  feature: Feature,
  cost: number,
  cap: number | null
): void {
  if (!cap || cap <= 0) return;
  const cfg = readConfig();
  const firings = checkThresholdsAndFire(feature, cost, cap, cfg);
  for (const f of firings) {
    void sendNative(`Costlens: ${feature.id}`, f.body, f.level);
    if (cfg.notifications.webhook) {
      void postWebhook(cfg.notifications.webhook, f.webhookPayload);
    }
  }
}

// ---------------------------------------------------------------------------
// Daily digest (server plugin, native OS only)
// ---------------------------------------------------------------------------

/**
 * Called on `session.created`. Shows yesterday's spend as a native OS
 * notification. Guard: runs at most once per process lifetime (set on
 * first call, resets via `_resetNotifStateForTest` in tests).
 */
export function maybeShowDailyDigestOc(): void {
  if (_digestShownToday) return;
  const cfg = readConfig();
  if (!cfg.notifications.enabled) return;
  if (!cfg.notifications.dailyDigest) return;
  let db;
  try {
    db = getCoreDb();
  } catch {
    return; // DB not open yet
  }
  const digest = computeDailyDigest(db, cfg.notifications.dailyDigestThresholdUsd);
  if (digest.lines.length === 0) return;
  _digestShownToday = true;
  const totalStr = `$${digest.totalUsd.toFixed(4)}`;
  const title = `Costlens — yesterday (${digest.date})`;
  const body =
    `${totalStr} across ${digest.totalTurns} turn${digest.totalTurns === 1 ? "" : "s"}\n` +
    digest.lines.join("\n");
  void sendNative(title, body, "info");
}

// ---------------------------------------------------------------------------
// Daily digest (TUI plugin, api.attention + api.ui.toast + native)
// ---------------------------------------------------------------------------

type TuiApi = {
  ui: {
    toast(opts: { variant: string; message: string; duration?: number }): void;
  };
  attention?: {
    notify(opts: { title: string; message: string }): void;
  };
};

/**
 * TUI variant of the daily digest. Shows in the opencode TUI (toast +
 * attention notification) in addition to the native OS notification.
 * Same `_digestShownToday` guard as the server variant — only fires once
 * per process. In practice the TUI and server are separate processes, but
 * the guard still prevents multiple `session.created` events from showing
 * the digest multiple times within one TUI session.
 */
export function maybeShowDailyDigestOcTui(api: TuiApi): void {
  if (_digestShownToday) return;
  const cfg = readConfig();
  if (!cfg.notifications.enabled) return;
  if (!cfg.notifications.dailyDigest) return;
  let db;
  try {
    db = getCoreDb();
  } catch {
    return;
  }
  const digest = computeDailyDigest(db, cfg.notifications.dailyDigestThresholdUsd);
  if (digest.lines.length === 0) return;
  _digestShownToday = true;
  const totalStr = `$${digest.totalUsd.toFixed(4)}`;
  const title = `Costlens — yesterday (${digest.date})`;
  const body =
    `${totalStr} across ${digest.totalTurns} turn${digest.totalTurns === 1 ? "" : "s"}\n` +
    digest.lines.join("\n");
  // In-TUI channels
  try {
    api.attention?.notify({ title, message: body });
  } catch { /* graceful */ }
  try {
    api.ui.toast({ variant: "info", message: `${title}: ${totalStr}`, duration: 6000 });
  } catch { /* graceful */ }
  // Native OS channel
  void sendNative(title, body, "info");
  // Webhook
  if (cfg.notifications.webhook) {
    void postWebhook(cfg.notifications.webhook, { type: "daily_digest", title, body });
  }
}
