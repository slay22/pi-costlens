/**
 * Notifications, webhooks, and the daily digest.
 *
 * Phase 6 — `feat/phase-6-notifications`.
 *
 *   notify(title, body, level, ctx?)
 *     — Always shows in-pi (when ctx is provided and `ctx.hasUI`).
 *     — Also dispatches to the platform's native notifier (osascript on
 *       macOS, notify-send on Linux, PowerShell on Windows) as a
 *       best-effort 1.5s call that never throws.
 *
 *   fireThresholdNotification(featureId, cost, cap, ctx?)
 *     — For each configured threshold (0.5 / 0.8 / 1.0 / 1.1 by default),
 *       fires a notification the first time cost/cap crosses that ratio
 *       for this feature in this session. In-memory debounce; reset on
 *       `/feature reopen`.
 *
 *   postWebhook(url, payload)
 *     — POSTs JSON to the URL with a 2s timeout. Fire-and-forget. Never
 *       throws. Logs to stderr on failure.
 *
 *   computeDailyDigest(db, thresholdUsd)
 *     — Pure: returns { lines: string[] } describing yesterday's
 *       per-feature spend, filtered to features that crossed the
 *       threshold USD amount.
 *
 *   seedFiredFromCurrentCosts()
 *     — On session_start, mark all currently-crossed thresholds as
 *       "already fired" so a restart doesn't re-notify. Pure on the
 *       module's in-memory state.
 *
 *   clearFiredForFeature(featureId)
 *     — Called on `/feature reopen`. Lets a reopened feature notify
 *       again as it crosses a new threshold.
 *
 * Design notes:
 *   - The `fired` set is per-process, not persisted. If pi restarts, the
 *     user may see one extra notification. That trade-off keeps the
 *     schema unchanged and the code simple.
 *   - Config is read on each call (via `readConfig()`). The user can
 *     flip the master switch without restarting pi.
 *   - `Level` ("info" | "warn" | "critical") is internal to this module.
 *     pi's `ctx.ui.notify` only knows "info" | "warning" | "error", so
 *     the bridge happens in `notify()`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig, type CostlensConfig } from "./config.js";
import { listFeatures, type Feature } from "./lifecycle.js";

const execFileAsync = promisify(execFile);

const NATIVE_TIMEOUT_MS = 1500;
const WEBHOOK_TIMEOUT_MS = 2000;
const MAX_THRESHOLDS_FIRED_PER_FEATURE = 4; // safety; default config has 4

export type Level = "info" | "warn" | "critical";

export type NotifyOpts = {
  /** Override the level-to-emoji mapping for native notifications. */
  emoji?: string;
};

// ---------------------------------------------------------------------------
// In-memory debounce state
// ---------------------------------------------------------------------------

const fired = new Set<string>(); // `${featureId}:${threshold}` pairs

function thresholdKey(featureId: string, threshold: number): string {
  return `${featureId}:${threshold}`;
}

export function _resetForTest(): void {
  fired.clear();
}

/**
 * On session_start, for every feature that has a cap, mark all
 * currently-crossed thresholds as "already fired" so that a pi reload
 * doesn't re-notify for thresholds we already know were crossed.
 */
export function seedFiredFromCurrentCosts(): void {
  const cfg = readConfig();
  if (!cfg.notifications.enabled) return;
  const features = listFeatures();
  for (const f of features) {
    seedFiredForFeature(f, cfg);
  }
}

function seedFiredForFeature(f: Feature, cfg: CostlensConfig): void {
  if (f.cap_usd == null || f.cap_usd <= 0) return;
  const ratio = f.total_cost_usd / f.cap_usd;
  for (const t of cfg.notifications.thresholds) {
    if (ratio >= t) fired.add(thresholdKey(f.id, t));
  }
}

/** Called on `/feature reopen` so the reopened feature can notify again. */
export function clearFiredForFeature(featureId: string): void {
  const prefix = `${featureId}:`;
  for (const key of Array.from(fired)) {
    if (key.startsWith(prefix)) fired.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Threshold detection
// ---------------------------------------------------------------------------

/**
 * For each configured threshold that has just been crossed, fire a
 * notification + (optionally) a webhook. Idempotent within a session
 * thanks to the in-memory `fired` set.
 */
export function fireThresholdNotification(
  feature: Feature,
  cost: number,
  cap: number,
  ctx?: ExtensionContext
): void {
  const cfg = readConfig();
  if (!cfg.notifications.enabled) return;
  if (cap <= 0) return;

  const ratio = cost / cap;
  // Cap the number of thresholds we fire for any one feature in a
  // session — even if the user configures a wild thresholds list, we
  // don't spam forever.
  let remaining = MAX_THRESHOLDS_FIRED_PER_FEATURE;

  for (const t of cfg.notifications.thresholds) {
    if (remaining <= 0) break;
    if (ratio < t) continue;
    const key = thresholdKey(feature.id, t);
    if (fired.has(key)) continue;
    fired.add(key);
    remaining -= 1;
    const level = levelForThreshold(t);
    const body = formatThresholdBody(feature, cost, cap, t, level);
    const title = `Costlens: ${feature.name}`;
    void notify(title, body, level, ctx);
    if (cfg.notifications.webhook) {
      void postWebhook(cfg.notifications.webhook, {
        text: `${emojiForLevel(level)} *${feature.name}* hit ${(t * 100).toFixed(0)}% of $${cap.toFixed(2)} cap — $${cost.toFixed(4)} / $${cap.toFixed(2)}`,
        feature: feature.id,
        threshold: t,
        cost,
        cap,
        level,
      });
    }
  }
}

function levelForThreshold(t: number): Level {
  if (t >= 1.0) return "critical";
  if (t >= 0.8) return "warn";
  return "info";
}

function emojiForLevel(level: Level): string {
  switch (level) {
    case "info": return "⚠️";
    case "warn": return "🚨";
    case "critical": return "💥";
  }
}

function formatThresholdBody(
  feature: Feature,
  cost: number,
  cap: number,
  threshold: number,
  level: Level
): string {
  const pct = (threshold * 100).toFixed(0);
  return `${emojiForLevel(level)} hit ${pct}% of $${cap.toFixed(2)} cap — $${cost.toFixed(4)} / $${cap.toFixed(2)} across ${feature.turn_count} turn${feature.turn_count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Notification dispatch
// ---------------------------------------------------------------------------

/**
 * Fire a notification. Always in-pi (if ctx provided) plus best-effort
 * native. The in-pi path is the always-works channel; the native path
 * is the "I can actually see this when my eyes are on the editor" path.
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

/**
 * Best-effort platform-native notification. 1.5s timeout. Never throws.
 * If the platform command isn't available (Linux without notify-send,
 * Windows without BurntToast), we just log to stderr.
 */
export async function sendNative(
  title: string,
  body: string,
  level: Level,
  emoji?: string
): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      const subtitle = `${emoji ?? emojiForLevel(level)} ${level}`;
      // osascript wants AppleScript-escaped strings. Use single-quoted
      // form for the inline `-e` and escape any embedded double quotes.
      const script = `display notification ${appleScriptQuote(body)} with title ${appleScriptQuote(title)} subtitle ${appleScriptQuote(subtitle)}`;
      await execFileAsync("osascript", ["-e", script], { timeout: NATIVE_TIMEOUT_MS });
      return;
    }
    if (platform === "linux") {
      const urgency = level === "info" ? "low" : level === "warn" ? "normal" : "critical";
      await execFileAsync(
        "notify-send",
        ["-u", urgency, "-a", "costlens", title, body],
        { timeout: NATIVE_TIMEOUT_MS }
      );
      return;
    }
    if (platform === "win32") {
      // Use a one-liner BurntToast PowerShell if available, otherwise
      // write a transient Windows toast via the MessageBox API. Most
      // Windows installs will have BurntToast; the MessageBox fallback
      // is intrusive, so we don't use it — we just log to stderr.
      const ps = `if (Get-Module -ListAvailable -Name BurntToast) { New-BurntToastNotification -Text '${title.replace(/'/g, "''")}', '${body.replace(/'/g, "''")}' } else { Write-Output "BurntToast not installed; skip toast" }`;
      await execFileAsync("powershell", ["-NoProfile", "-Command", ps], { timeout: NATIVE_TIMEOUT_MS });
      return;
    }
    // Unknown platform: best-effort log only.
    process.stderr.write(`[costlens-notify] ${title}: ${body}\n`);
  } catch (err) {
    // Never throw from notify. Log and move on.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[costlens-notify] ${msg}\n`);
  }
}

function appleScriptQuote(s: string): string {
  // Wrap in double quotes, escape backslashes and embedded double quotes.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * POST `payload` to `url` as JSON. 2s timeout, fire-and-forget. Never
 * throws. Logs to stderr on failure.
 */
export async function postWebhook(url: string, payload: unknown): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      process.stderr.write(
        `[costlens-webhook] non-2xx response: ${res.status} ${res.statusText}\n`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[costlens-webhook] ${msg}\n`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------

export type Digest = {
  date: string;     // YYYY-MM-DD in UTC (matches the SQL `date('now', '-1 day')`)
  lines: string[];
  totalUsd: number;
  totalTurns: number;
};

/**
 * Pure: returns a digest of yesterday's per-feature spend, filtered to
 * features whose cost was > `thresholdUsd`. Top 3 features by cost;
 * additional features are summarised as "and N more".
 */
export function computeDailyDigest(db: DatabaseSync, thresholdUsd: number): Digest {
  const rows = db
    .prepare(
      `SELECT feature_id, SUM(cost_usd) AS cost, COUNT(*) AS turns
       FROM messages
       WHERE date(timestamp) = date('now', '-1 day')
       GROUP BY feature_id
       HAVING cost > ?
       ORDER BY cost DESC`
    )
    .all(thresholdUsd) as Array<{ feature_id: string; cost: number; turns: number }>;

  const date = utcYesterdayDate();
  if (rows.length === 0) {
    return { date, lines: [], totalUsd: 0, totalTurns: 0 };
  }

  const totalUsd = rows.reduce((acc, r) => acc + r.cost, 0);
  const totalTurns = rows.reduce((acc, r) => acc + r.turns, 0);

  const top = rows.slice(0, 3);
  const rest = rows.length - top.length;
  const lines = top.map(
    (r) => `  ${r.feature_id.padEnd(30)} $${r.cost.toFixed(4)}  (${r.turns} turn${r.turns === 1 ? "" : "s"})`
  );
  if (rest > 0) {
    lines.push(`  …and ${rest} more`);
  }

  return { date, lines, totalUsd, totalTurns };
}

/** YYYY-MM-DD for "yesterday" in UTC (matches the SQL filter). */
export function utcYesterdayDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
