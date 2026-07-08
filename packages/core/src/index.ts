/**
 * @costlens/core — tool-agnostic cost layer.
 *
 * This is the public API surface for the data plane. Every tool
 * adapter (pi, opencode, claude-code) imports from here. The
 * adapter is responsible for:
 *
 *   1. Opening its SQLite connection (`node:sqlite` for the
 *      extension, `bun:sqlite` for the dashboard server).
 *   2. Calling `setCoreDb(connection)` so core's `getCoreDb()`
 *      returns the same handle.
 *   3. Calling `applySchema(db)` once at startup (idempotent).
 *   4. Translating tool-specific events into the data operations
 *      exposed here.
 *
 * Adapters MUST NOT import `node:sqlite` or `bun:sqlite` from
 * core; core is driver-agnostic via the `CoreDatabase` /
 * `CoreStatement` structural types in `./types.ts`.
 *
 * See MULTI-TOOL.md §4 for the architecture.
 */

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export const COSTLENS_CORE_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  CoreDatabase,
  CoreStatement,
  Feature,
  FeatureSummary,
  Message,
  Note,
  SubagentRun,
  SubagentSummary,
  ToolCall,
  ToolCallSummary,
  Overview,
  NotificationConfig,
  CostlensConfig,
  GitContext,
  SessionCtx,
} from "./types.js";

export { LifecycleError } from "./types.js";

// ---------------------------------------------------------------------------
// DB layer
// ---------------------------------------------------------------------------

export {
  setCoreDb,
  getCoreDb,
  closeCoreDb,
  applySchema,
  SCHEMA_VERSION,
  COSTLENS_DIR,
  DB_PATH,
  LEGACY_DB_DIR,
  getCostlensHome,
  getLegacyHome,
  getDbPath,
  ensureCostlensHome,
  getLegacyDbPath,
  // Reads
  getFeature,
  listFeatures,
  getAllFeatures,
  getSessionFeatureId,
  getTags,
  getAllTags,
  getNotes,
  getMessages,
  getRecentModels,
  getSubagentRuns,
  getSubagentSummary,
  getTopSubagents,
  getToolCalls,
  getToolCallCounts,
  searchFeatures,
  getOverview,
  exportLedger,
  exportLedgerCsv,
  type LedgerExport,
} from "./db.js";

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export {
  // Module state
  getActiveFeatureId,
  getActiveFeatureId as getCurrentActiveFeatureId, // alias (kept for clarity)
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
  // Sub-agent / tool-call writes
  insertSubagentRun,
  updateFeatureSubagentCost,
  insertToolCall,
  // Message bookkeeping
  recordMessageAndUpdateFeature,
  type SubagentRunInsert,
  type MessageInsert,
} from "./lifecycle.js";

// ---------------------------------------------------------------------------
// Pricing confidence
// ---------------------------------------------------------------------------

export {
  computePricingConfidence,
  type PricingConfidence,
} from "./pricing.js";

// ---------------------------------------------------------------------------
// Config IO
// ---------------------------------------------------------------------------

export {
  readConfig,
  writeConfig,
  getConfigPath,
  getDefaultThresholds,
} from "./config.js";

// ---------------------------------------------------------------------------
// Notifications (tool-agnostic: OS native, webhook, digest, threshold)
// ---------------------------------------------------------------------------

export {
  sendNative,
  postWebhook,
  computeDailyDigest,
  utcYesterdayDate,
  checkThresholdsAndFire,
  seedFiredFromCurrentCosts,
  clearFiredForFeature,
  _resetFiredForTest,
  levelForThreshold,
  emojiForLevel,
  appleScriptQuote,
  type Level,
  type Digest,
  type ThresholdFiring,
} from "./notifications.js";

// ---------------------------------------------------------------------------
// Migration (pi-costlens → @costlens/core, ~/.pi/costlens → ~/.costlens)
// ---------------------------------------------------------------------------

export {
  ensureMigrated,
  ensureMigratedFromEnv,
  resolveMigrationPaths,
  readMigrationFlag,
  FLAG_FILENAME,
  type MigrationResult,
} from "./migrate.js";

// ---------------------------------------------------------------------------
// Server (Bun dashboard) — exported so the extension's `startServer`
// helper can spawn the same code, and so the bun-test server tests
// can import the handlers without re-implementing them.
// ---------------------------------------------------------------------------

export {
  findFreePort,
  DEFAULT_PORT,
  PORT_RANGE_START,
  PORT_RANGE_END,
} from "./server/port.js";

export {
  handleFeatures,
  handleFeature,
  handleFeatureTags,
  handleFeatureNotes,
  handleMessages,
  handleOverview,
  handleAllTags,
  handleExportCsv,
  handleExportJson,
  handleHealth,
  handleFeatureSubagents,
  handleFeatureSubagentRuns,
  handleFeatureTools,
  handleTopSubagents,
  handleClose,
  handleCancel,
  handleMerge,
  handleReopen,
  handleSetCap,
  handleAddTag,
  handleRemoveTag,
  handleAttachNote,
  type RouteContext,
} from "./server/api.js";
