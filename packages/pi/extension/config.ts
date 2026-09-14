/**
 * Costlens config persistence — pi adapter shim.
 *
 * Phase 9 step 2: re-exports `readConfig`, `writeConfig`, etc.
 * from `@costlens/core/config`. Tool-agnostic; lives in core.
 *
 * Note: the file lives at `~/.costlens/config.json`; step 3 of
 * MULTI-TOOL.md moved it off the legacy `~/.pi/costlens/` path
 * (with a lazy directory migration for pre-2.0.0 users).
 */

export {
  readConfig,
  writeConfig,
  getConfigPath,
  getDefaultThresholds,
  type CostlensConfig,
  type NotificationConfig,
} from "@costlens/core";
