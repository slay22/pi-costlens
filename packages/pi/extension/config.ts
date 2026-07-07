/**
 * Costlens config persistence.
 *
 * `~/.pi/costlens/config.json` holds runtime-tweakable settings. The
 * server and the extension both read it; whichever writes last wins.
 * Missing or malformed files fall back to defaults silently — never
 * crash the extension over a config issue.
 *
 * Phase 6 adds the `notifications` sub-config (master switch, thresholds,
 * webhook URL, daily digest). The field is optional and forward-
 * compatible: a config without it is treated as defaults.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const COSTLENS_HOME = process.env.COSTLENS_HOME
  ? join(process.env.COSTLENS_HOME, "costlens")
  : join(homedir(), ".pi", "costlens");
const CONFIG_PATH = join(COSTLENS_HOME, "config.json");

export type NotificationConfig = {
  enabled: boolean;
  thresholds: number[];
  webhook: string | null;
  dailyDigest: boolean;
  dailyDigestThresholdUsd: number;
};

export type CostlensConfig = {
  port: number;
  notifications: NotificationConfig;
};

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

export function getCostlensHome(): string {
  return COSTLENS_HOME;
}

export function getDefaultThresholds(): number[] {
  return [...DEFAULT_THRESHOLDS];
}

export function readConfig(): CostlensConfig {
  if (!existsSync(CONFIG_PATH)) return cloneDefaults();
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
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
  mkdirSync(COSTLENS_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
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
function mergeNotifications(input: Partial<NotificationConfig> | undefined): NotificationConfig {
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
      typeof input.dailyDigest === "boolean" ? input.dailyDigest : DEFAULT_NOTIFICATIONS.dailyDigest,
    dailyDigestThresholdUsd:
      typeof input.dailyDigestThresholdUsd === "number" && input.dailyDigestThresholdUsd >= 0
        ? input.dailyDigestThresholdUsd
        : DEFAULT_NOTIFICATIONS.dailyDigestThresholdUsd,
  };
}
