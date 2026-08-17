/**
 * Costlens config persistence — pi adapter shim.
 *
 * Phase 9 step 2: re-exports `readConfig`, `writeConfig`, etc.
 * from `@costlens/core/config`. Tool-agnostic; lives in core.
 *
 * Note: the file path is still `~/.pi/costlens/config.json` for
 * pre-step-3 users. Step 3 of MULTI-TOOL.md (lazy migration to
 * `~/.costlens/`) is the next step.
 */

export {
  readConfig,
  writeConfig,
  getConfigPath,
  getDefaultThresholds,
  type CostlensConfig,
  type NotificationConfig,
} from "@costlens/core";
