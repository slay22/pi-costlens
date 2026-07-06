/**
 * Costlens config persistence.
 *
 * `~/.pi/costlens/config.json` holds runtime-tweakable settings. The
 * server and the extension both read it; whichever writes last wins.
 * Missing or malformed files fall back to defaults silently — never
 * crash the extension over a config issue.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

export function writeConfig(config: CostlensConfig): void {
  mkdirSync(COSTLENS_HOME, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}
