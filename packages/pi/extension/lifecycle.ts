/**
 * Feature lifecycle — pi adapter shim.
 *
 * Phase 9 step 2: the data plane (close, cancel, merge, reopen,
 * cap, tags, notes, sub-agent, tool calls, search, export, the
 * active-feature cache) lives in `@costlens/core/lifecycle`. The
 * read functions (getFeature, getMessages, searchFeatures,
 * exportLedger, etc.) live in `@costlens/core/db`. This file
 * re-exports both so existing call sites
 * (`import { ... } from "./lifecycle.js"`) keep working unchanged.
 *
 * See MULTI-TOOL.md §11 step 2 for the consolidation. The pi
 * extension is now a thin adapter that maps `message_end` events
 * into core's `recordMessageAndUpdateFeature` calls.
 */

export {
  // Module state (used by footer + commands)
  getActiveFeatureId,
  getActiveGit,
  setActiveFeature,
  _resetForTest,
  // Branch mapping
  featureIdFor,
  ensureFeatureForSession,
  UNASSIGNED_ID,
  // State mutations
  closeFeature,
  cancelFeature,
  mergeFeature,
  reopenFeature,
  renameFeature,
  setCap,
  // Notes
  attachNote,
  // Tags
  addTag,
  removeTag,
  listTags,
  // Sub-agent + tool-call writes
  insertSubagentRun,
  updateFeatureSubagentCost,
  insertToolCall,
  // Message bookkeeping
  recordMessageAndUpdateFeature,
  // Errors
  LifecycleError,
  // Reads (from core/db.ts; re-exported here so call sites that
  // import from "./lifecycle.js" don't have to change)
  getFeature,
  getMessages,
  getRecentModels,
  getNotes,
  getTags,
  getAllTags as listAllTags,
  getNotes as listNotes,
  getSubagentRuns,
  getSubagentSummary,
  getTopSubagents,
  getToolCalls,
  getToolCallCounts,
  searchFeatures,
  listFeatures,
  getAllFeatures,
  getOverview,
  exportLedger,
  exportLedgerCsv,
  getSessionFeatureId,
  // Types
  type SubagentRun,
  type SubagentRunInsert,
  type SubagentSummary,
  type ToolCall,
  type ToolCallSummary,
  type Message,
  type MessageInsert,
  type Feature,
  type Overview,
  type SessionCtx,
  type GitContext,
  type LedgerExport,
} from "@costlens/core";

// Re-export the legacy alias the extension uses: the old API took
// `ctx: { sessionManager: { getSessionFile() } }`; the new API takes
// just the session file. We keep a thin shim so the call sites in
// `extension/index.ts` and `extension/hooks.ts` don't have to change.
import { getSessionFeatureId } from "@costlens/core";

/**
 * @deprecated Use `getSessionFeatureId(sessionFile)` from `@costlens/core`
 * directly. This shim exists so legacy call sites continue to work.
 */
export function getCurrentFeatureId(
  ctx: { sessionManager: { getSessionFile(): string | undefined } }
): string | null {
  return getSessionFeatureId(ctx.sessionManager.getSessionFile());
}
