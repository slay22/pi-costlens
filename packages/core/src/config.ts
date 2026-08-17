/**
 * Costlens config persistence.
 *
 * `~/.costlens/config.json` (the new path; previously `~/.pi/costlens/`)
 * holds runtime-tweakable settings. The extension and the dashboard
 * server both read it; whichever writes last wins. Missing or
 * malformed files fall back to defaults silently — never crash the
 * extension over a config issue.
 *
 * Phase 6 added the `notifications` sub-config (master switch,
 * thresholds, webhook URL, daily digest). The field is optional and
 * forward-compatible: a config without it is treated as defaults.
 *
 * Phase 9 step 2: this consolidates `extension/config.ts` and
 * `server/config.ts`. The server's pre-step-2 module only knew
 * about `port`; the extension's knew about port + notifications. The
 * unified module owns both, and the server reads the same
 * notifications as the extension (it surfaces them in the dashboard).
 *
 * Phase 9 step 3 (MULTI-TOOL.md §6) will move the file path from
 * `~/.pi/costlens/` to `~/.costlens/`. The `getCostlensHome` exported
 * from `./db.ts` is the new home; this module reads from it.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CostlensConfig, NotificationConfig } from "./types.js";

export type { CostlensConfig, NotificationConfig } from "./types.js";

/**
 * Resolve the costlens home dir. Re-reads `COSTLENS_HOME` on each
 * call so test fixtures can override it without reloading the
 * module. The DB module also reads this same env var; keeping the
 * logic in one place (here) is awkward when they need to share
 * state, so both compute it independently.
 */
function resolveCostlensDir(): string {
  return process.env.COSTLENS_HOME
    ? join(process.env.COSTLENS_HOME, "costlens")
    : join(homedir(), ".costlens");
}

const DEFAULT_THRESHOLDS = [0.5, 0.8, 1.0, 1.1];
const DEFAULT_NOTIFICATIONS: NotificationConfig = {
  enabled: true,
  thresholds: [...DEFAULT_THRESHOLDS],
  webhook: null,
  dailyDigest: true,
  dailyDigestThresholdUsd: 0.5,
};

const DEFAULTS: CostlensConfig = {
  port: 7331,
  notifications: { ...DEFAULT_NOTIFICATIONS, thresholds: [...DEFAULT_THRESHOLDS] },
};

export function getConfigPath(): string {
  return join(resolveCostlensDir(), "config.json");
}

export function getDefaultThresholds(): number[] {
  return [...DEFAULT_THRESHOLDS];
}

export function readConfig(): CostlensConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return cloneDefaults();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<CostlensConfig>;
    return {
      port: typeof parsed.port === "number" && parsed.port > 0 ? parsed.port : DEFAULTS.port,
      notifications: mergeNotifications(parsed.notifications),
    };
  } catch {
    return cloneDefaults();
  }
}

export function writeConfig(config: CostlensConfig): void {
  const dir = resolveCostlensDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

function cloneDefaults(): CostlensConfig {
  return {
    port: DEFAULTS.port,
    notifications: {
      ...DEFAULT_NOTIFICATIONS,
      thresholds: [...DEFAULT_NOTIFICATIONS.thresholds],
    },
  };
}

/**
 * Merge a possibly-missing `notifications` field with the defaults.
 * Validates threshold ratios (must be numbers > 0). Drops invalid
 * values silently — a typo in config.json should never crash the
 * extension.
 */
function mergeNotifications(
  input: Partial<NotificationConfig> | undefined
): NotificationConfig {
  if (!input || typeof input !== "object") return cloneDefaults().notifications;
  const thresholds = Array.isArray(input.thresholds)
    ? input.thresholds.filter((t) => typeof t === "number" && t > 0 && t <= 10)
    : [...DEFAULT_THRESHOLDS];
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_NOTIFICATIONS.enabled,
    thresholds: thresholds.length > 0 ? thresholds : [...DEFAULT_THRESHOLDS],
    webhook:
      typeof input.webhook === "string" && input.webhook.length > 0 ? input.webhook : null,
    dailyDigest:
      typeof input.dailyDigest === "boolean"
        ? input.dailyDigest
        : DEFAULT_NOTIFICATIONS.dailyDigest,
    dailyDigestThresholdUsd:
      typeof input.dailyDigestThresholdUsd === "number" &&
      input.dailyDigestThresholdUsd >= 0
        ? input.dailyDigestThresholdUsd
        : DEFAULT_NOTIFICATIONS.dailyDigestThresholdUsd,
  };
}
