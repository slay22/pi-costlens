/**
 * opencode-costlens — public API barrel.
 *
 * opencode loads the plugin surfaces via the `exports` field:
 *   - `opencode-costlens/server` → Costlens (Plugin)
 *   - `opencode-costlens/tui`    → CostlensTui (TuiPlugin)
 *
 * This barrel re-exports both so consumers can also do:
 *   import { Costlens, CostlensTui } from "opencode-costlens"
 */

export { Costlens, default as CostlensServer } from "./server.js";
export { CostlensTui, default as CostlensTuiPlugin } from "./tui.js";
