/**
 * Smoke test for the @costlens/core public API.
 *
 * Phase 9 step 2: the data plane has been extracted from pi-costlens
 * into this package. The placeholder test from step 1 is replaced
 * with a real smoke test that verifies the public API surface.
 * Full test coverage (db, lifecycle, config, pricing, server) lands
 * in the .test.ts files next to each module.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "./index.js";

test("core exports the version", () => {
  assert.equal(typeof core.COSTLENS_CORE_VERSION, "string");
  assert.match(core.COSTLENS_CORE_VERSION, /^\d+\.\d+\.\d+/);
});

test("core exports the public API surface", () => {
  // Read functions from db.ts
  assert.equal(typeof core.getCoreDb, "function");
  assert.equal(typeof core.setCoreDb, "function");
  assert.equal(typeof core.closeCoreDb, "function");
  assert.equal(typeof core.applySchema, "function");
  assert.equal(typeof core.getFeature, "function");
  assert.equal(typeof core.listFeatures, "function");
  assert.equal(typeof core.getAllFeatures, "function");
  assert.equal(typeof core.getSessionFeatureId, "function");
  assert.equal(typeof core.getNotes, "function");
  assert.equal(typeof core.getTags, "function");
  assert.equal(typeof core.getAllTags, "function");
  assert.equal(typeof core.getMessages, "function");
  assert.equal(typeof core.getRecentModels, "function");
  assert.equal(typeof core.getSubagentRuns, "function");
  assert.equal(typeof core.getSubagentSummary, "function");
  assert.equal(typeof core.getTopSubagents, "function");
  assert.equal(typeof core.getToolCalls, "function");
  assert.equal(typeof core.getToolCallCounts, "function");
  assert.equal(typeof core.searchFeatures, "function");
  assert.equal(typeof core.getOverview, "function");
  assert.equal(typeof core.exportLedger, "function");
  assert.equal(typeof core.exportLedgerCsv, "function");

  // Lifecycle writes
  assert.equal(typeof core.closeFeature, "function");
  assert.equal(typeof core.cancelFeature, "function");
  assert.equal(typeof core.mergeFeature, "function");
  assert.equal(typeof core.reopenFeature, "function");
  assert.equal(typeof core.renameFeature, "function");
  assert.equal(typeof core.setCap, "function");
  assert.equal(typeof core.attachNote, "function");
  assert.equal(typeof core.addTag, "function");
  assert.equal(typeof core.removeTag, "function");
  assert.equal(typeof core.listTags, "function");
  assert.equal(typeof core.insertSubagentRun, "function");
  assert.equal(typeof core.updateFeatureSubagentCost, "function");
  assert.equal(typeof core.insertToolCall, "function");
  assert.equal(typeof core.recordMessageAndUpdateFeature, "function");
  assert.equal(typeof core.ensureFeatureForSession, "function");
  assert.equal(typeof core.featureIdFor, "function");

  // Module state
  assert.equal(typeof core.getActiveFeatureId, "function");
  assert.equal(typeof core.getActiveGit, "function");
  assert.equal(typeof core.setActiveFeature, "function");

  // Pricing
  assert.equal(typeof core.computePricingConfidence, "function");

  // Config
  assert.equal(typeof core.readConfig, "function");
  assert.equal(typeof core.writeConfig, "function");
  assert.equal(typeof core.getConfigPath, "function");
  assert.equal(typeof core.getDefaultThresholds, "function");

  // Server
  assert.equal(typeof core.findFreePort, "function");
  assert.equal(typeof core.DEFAULT_PORT, "number");
  assert.equal(typeof core.handleFeatures, "function");
  assert.equal(typeof core.handleHealth, "function");
  assert.equal(typeof core.handleOverview, "function");
  assert.equal(typeof core.handleClose, "function");
  assert.equal(typeof core.handleCancel, "function");
  assert.equal(typeof core.handleMerge, "function");
  assert.equal(typeof core.handleReopen, "function");
  assert.equal(typeof core.handleSetCap, "function");
  assert.equal(typeof core.handleAddTag, "function");
  assert.equal(typeof core.handleRemoveTag, "function");
  assert.equal(typeof core.handleAttachNote, "function");

  // Constants
  assert.equal(typeof core.SCHEMA_VERSION, "number");
  assert.equal(typeof core.COSTLENS_DIR, "string");
  assert.equal(typeof core.DB_PATH, "string");
  assert.equal(core.UNASSIGNED_ID, "unassigned");
});

test("core exports LifecycleError as a class", () => {
  const err = new core.LifecycleError("NOT_FOUND", "test message");
  assert.equal(err.code, "NOT_FOUND");
  assert.equal(err.message, "test message");
  assert.equal(err.name, "LifecycleError");
  assert.ok(err instanceof Error);
});

test("core errors can be caught by code", () => {
  try {
    throw new core.LifecycleError("BAD_REQUEST", "bad");
  } catch (e) {
    assert.ok(e instanceof core.LifecycleError);
    assert.equal((e as core.LifecycleError).code, "BAD_REQUEST");
  }
});
