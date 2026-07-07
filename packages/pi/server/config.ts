/**
 * Costlens config for the server (Bun).
 *
 * Mirrors `extension/config.ts` — both read the same file at
 * `~/.pi/costlens/config.json`. They use the same simple JSON parse +
 * defaults, no schema validation library.
 *
 * Missing or malformed file → defaults. Never throws.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const COSTLENS_HOME = process.env.COSTLENS_HOME
  ? join(process.env.COSTLENS_HOME, "costlens")
  : join(homedir(), ".pi", "costlens");
const CONFIG_PATH = join(COSTLENS_HOME, "config.json");

export type CostlensConfig = {
  port: number;
};

const DEFAULTS: CostlensConfig = { port: 7331 };

export function getCostlensHome(): string {
  return COSTLENS_HOME;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function readConfig(): CostlensConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<CostlensConfig>;
    return {
      port: typeof parsed.port === "number" && parsed.port > 0 ? parsed.port : DEFAULTS.port,
    };
  } catch {
    return { ...DEFAULTS };
  }
}
