/**
 * Tool-agnostic notification utilities.
 *
 * Phase 9 step 9 (MULTI-TOOL.md §9 v1.5). Moved here from
 * `pi-costlens/extension/notifications.ts` so every adapter (pi,
 * opencode, …) shares the same threshold-check, debounce, OS
 * notification, webhook, and daily-digest logic.
 *
 * What lives here:
 *   sendNative(title, body, level)       — osascript / notify-send / PS
 *   postWebhook(url, payload)            — HTTP POST, fire-and-forget
 *   computeDailyDigest(db, threshold)    — SQL aggregation
 *   checkThresholdsAndFire(...)          — debounce + return firings
 *   seedFiredFromCurrentCosts(config)    — seed debounce on startup
 *   clearFiredForFeature(featureId)      — reset debounce on reopen
 *   emojiForLevel / levelForThreshold    — formatting helpers
 *
 * What does NOT live here (stays in each adapter):
 *   notify() with tool-specific in-app UI (ctx.ui.notify, api.ui.toast)
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCoreDb, listFeatures } from "./db.js";
import type { CostlensConfig } from "./types.js";
import type { CoreDatabase, Feature } from "./types.js";

const execFileAsync = promisify(execFile);

const NATIVE_TIMEOUT_MS = 1500;
const WEBHOOK_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Level = "info" | "warn" | "critical";

export type Digest = {
  date: string;
  lines: string[];
  totalUsd: number;
  totalTurns: number;
};

export type ThresholdFiring = {
  threshold: number;
  level: Level;
  /** Human-readable body for the notification. */
  body: string;
  /** Ready-to-POST webhook payload object. */
  webhookPayload: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Debounce state (per-process, not persisted)
// ---------------------------------------------------------------------------

const _fired = new Set<string>();

function thresholdKey(featureId: string, threshold: number): string {
  return `${featureId}:${threshold}`;
}

/** Reset the debounce. Tests only. */
export function _resetFiredForTest(): void {
  _fired.clear();
}

/**
 * On startup, mark every already-crossed threshold as fired so that
 * a process restart doesn't re-notify for crossings that happened
 * in a previous session.
 */
export function seedFiredFromCurrentCosts(config: CostlensConfig): void {
  if (!config.notifications.enabled) return;
  const db = getCoreDb();
  const features = listFeatures();
  for (const f of features) {
    if (f.cap_usd == null || f.cap_usd <= 0) continue;
    const ratio = f.total_cost_usd / f.cap_usd;
    for (const t of config.notifications.thresholds) {
      if (ratio >= t) _fired.add(thresholdKey(f.id, t));
    }
  }
}

/** Called on `/feature reopen` (or opencode-costlens equivalent) so the
 *  reopened feature can notify again as it crosses new thresholds. */
export function clearFiredForFeature(featureId: string): void {
  const prefix = `${featureId}:`;
  for (const key of Array.from(_fired)) {
    if (key.startsWith(prefix)) _fired.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Threshold detection
// ---------------------------------------------------------------------------

export function levelForThreshold(t: number): Level {
  if (t >= 1.0) return "critical";
  if (t >= 0.8) return "warn";
  return "info";
}

export function emojiForLevel(level: Level): string {
  switch (level) {
    case "info": return "⚠️";
    case "warn": return "🚨";
    case "critical": return "💥";
  }
}

function formatThresholdBody(
  feature: Pick<Feature, "id" | "total_cost_usd" | "turn_count">,
  cost: number,
  cap: number,
  threshold: number,
  level: Level
): string {
  const pct = (threshold * 100).toFixed(0);
  return (
    `${emojiForLevel(level)} hit ${pct}% of $${cap.toFixed(2)} cap` +
    ` — $${cost.toFixed(4)} / $${cap.toFixed(2)}` +
    ` across ${feature.total_cost_usd > 0 ? feature.turn_count : 0}` +
    ` turn${feature.turn_count === 1 ? "" : "s"}`
  );
}

/**
 * Check which thresholds were just crossed, mark them in the debounce,
 * and return a list of firings for the adapter to act on (send native
 * OS notification, send webhook, show in-app toast, etc.).
 *
 * Returns an empty array when:
 *   - notifications are disabled in config
 *   - cap is 0 / null
 *   - all relevant thresholds already fired this session
 */
export function checkThresholdsAndFire(
  feature: Feature,
  cost: number,
  cap: number,
  config: CostlensConfig
): ThresholdFiring[] {
  if (!config.notifications.enabled) return [];
  if (cap <= 0) return [];
  const ratio = cost / cap;
  const firings: ThresholdFiring[] = [];
  const MAX = 4; // guard against unbounded notification spam

  for (const t of config.notifications.thresholds) {
    if (firings.length >= MAX) break;
    if (ratio < t) continue;
    const key = thresholdKey(feature.id, t);
    if (_fired.has(key)) continue;
    _fired.add(key);
    const level = levelForThreshold(t);
    const body = formatThresholdBody(feature, cost, cap, t, level);
    firings.push({
      threshold: t,
      level,
      body,
      webhookPayload: {
        text: `${emojiForLevel(level)} *${feature.id}* hit ${(t * 100).toFixed(0)}% of $${cap.toFixed(2)} cap — $${cost.toFixed(4)} / $${cap.toFixed(2)}`,
        feature: feature.id,
        threshold: t,
        cost,
        cap,
        level,
      },
    });
  }
  return firings;
}

// ---------------------------------------------------------------------------
// OS notification (tool-agnostic)
// ---------------------------------------------------------------------------

/**
 * Best-effort platform-native notification. 1.5s timeout. Never throws.
 * macOS: osascript   Linux: notify-send   Windows: BurntToast PowerShell.
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
      const script =
        `display notification ${appleScriptQuote(body)}` +
        ` with title ${appleScriptQuote(title)}` +
        ` subtitle ${appleScriptQuote(subtitle)}`;
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
      const ps =
        `if (Get-Module -ListAvailable -Name BurntToast) {` +
        ` New-BurntToastNotification -Text '${title.replace(/'/g, "''")}',` +
        ` '${body.replace(/'/g, "''")}' }`;
      await execFileAsync("powershell", ["-NoProfile", "-Command", ps], {
        timeout: NATIVE_TIMEOUT_MS,
      });
      return;
    }
    process.stderr.write(`[costlens-notify] ${title}: ${body}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[costlens-notify] ${msg}\n`);
  }
}

/** @internal AppleScript double-quoted string with proper escaping. */
export function appleScriptQuote(s: string): string {
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

/**
 * Pure: returns a digest of yesterday's per-feature spend, filtered to
 * features whose cost was > `thresholdUsd`. Top 3 features by cost;
 * additional features summarised as "and N more".
 */
export function computeDailyDigest(db: CoreDatabase, thresholdUsd: number): Digest {
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
    (r) =>
      `  ${r.feature_id.padEnd(30)} $${r.cost.toFixed(4)}  (${r.turns} turn${r.turns === 1 ? "" : "s"})`
  );
  if (rest > 0) lines.push(`  …and ${rest} more`);

  return { date, lines, totalUsd, totalTurns };
}

export function utcYesterdayDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
