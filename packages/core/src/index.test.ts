/**
 * Smoke test for the @costlens/core scaffold.
 *
 * Step 1 of MULTI-TOOL.md: this package is a stub. The real test suite
 * lands in step 2 once the data plane has been extracted. For now, we
 * verify the package loads and the placeholder export is correct.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { COSTLENS_CORE_VERSION, __phase9_scaffold_only } from "./index.js";

test("core scaffold loads and exposes its placeholder API", () => {
  assert.equal(typeof COSTLENS_CORE_VERSION, "string");
  assert.match(COSTLENS_CORE_VERSION, /^0\.0\.0-stub$/);
  assert.equal(__phase9_scaffold_only, true);
});

test("core has no real data plane yet (step 2 will add it)", () => {
  // Sanity: nothing else is exported. The real surface area arrives in
  // step 2 (db, lifecycle, server, etc.). Keeping the assertion loose
  // on purpose — step 2 changes the export shape and this test gets
  // replaced.
  assert.ok(true);
});
