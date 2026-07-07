/**
 * @costlens/core — tool-agnostic cost layer.
 *
 * Phase 9 step 1 (MULTI-TOOL.md): this package is a STUB. The actual
 * data plane (DB schema, lifecycle, search, export, server) will be
 * extracted here in step 2 of the plan.
 *
 * What lives here eventually:
 *   - `db/`:         schema, openDb, queries (the single source of truth for
 *                     the SQLite ledger)
 *   - `server/`:     Bun.serve(), HTML/JS, uPlot (the tool-agnostic dashboard)
 *   - `lifecycle.ts`: close/cancel/merge/reopen/setCap/tags/notes (the data parts)
 *   - `config.ts`:   config file format + IO
 *   - `migrate.ts`:  one-shot data migration (~/.pi/costlens/ → ~/.costlens/)
 *   - `pricing.ts`:  pricing confidence calc
 *   - `search.ts`:   search features
 *   - `export.ts`:   CSV / JSON export
 *
 * What does NOT live here (stays in each adapter):
 *   - Hooks into a tool's event system (pi `message_end`, opencode events, …)
 *   - Tool-specific UI (footer rendering, slash command syntax)
 *   - Tool-specific deployment glue (where the dashboard binary lives)
 */

export const COSTLENS_CORE_VERSION = "0.0.0-stub";

/**
 * Placeholder public API. The real exports land in step 2.
 *
 * Adapters will import things like:
 *   import { openDb, insertMessage, ensureFeatureForSession } from "@costlens/core";
 *
 * That import is intentionally NOT yet wired in — pi-costlens still
 * imports from its local `extension/` and `server/` modules. Step 2
 * rewires those imports through this package.
 */
export const __phase9_scaffold_only = true;
