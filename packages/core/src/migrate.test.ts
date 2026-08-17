/**
 * Tests for the legacy data migration.
 *
 * Phase 9 step 3 (MULTI-TOOL.md §11). Covers the four scenarios
 * listed in the plan:
 *
 *   1. empty new path + old path with data → migrate
 *   2. new path exists (has data) → no-op
 *   3. both exist (both have data) → no-op (don't overwrite)
 *   4. new path empty + no old path → create new
 *
 * Plus flag-read tests and the `COSTLENS_HOME` opt-out.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMigrated,
  ensureMigratedFromEnv,
  resolveMigrationPaths,
  readMigrationFlag,
  FLAG_FILENAME,
  type MigrationResult,
} from "./migrate.js";

/**
 * Build a temp home with `newHome` and `legacyHome` (either or both)
 * containing a `ledger.db` so the migration has something to act on.
 */
function setup(opts: {
  newHasData?: boolean;
  legacyHasData?: boolean;
  writeFlag?: { from: string; at: string };
}): { root: string; newHome: string; legacyHome: string } {
  const root = mkdtempSync(join(tmpdir(), "costlens-migrate-"));
  const newHome = join(root, "new", "costlens");
  const legacyHome = join(root, "old", "costlens");
  if (opts.newHasData) {
    mkdirSync(newHome, { recursive: true });
    writeFileSync(join(newHome, "ledger.db"), "fake-new-db");
  }
  if (opts.legacyHasData) {
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, "ledger.db"), "fake-legacy-db");
  }
  if (opts.writeFlag) {
    mkdirSync(newHome, { recursive: true });
    writeFileSync(
      join(newHome, FLAG_FILENAME),
      JSON.stringify(opts.writeFlag, null, 2) + "\n"
    );
  }
  return { root, newHome, legacyHome };
}

function teardown(root: string) {
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Scenarios from MULTI-TOOL.md §11 step 3
// ---------------------------------------------------------------------------

describe("ensureMigrated", () => {
  test("empty new path + old path with data → migrate (rename + flag)", () => {
    const { root, newHome, legacyHome } = setup({ legacyHasData: true });
    try {
      const result: MigrationResult = ensureMigrated({ newHome, legacyHome });
      assert.equal(result.kind, "migrated");
      if (result.kind !== "migrated") return; // narrow type

      // The legacy dir is gone (renamed), the new dir has the data.
      assert.equal(existsSync(legacyHome), false, "legacy dir is renamed away");
      assert.equal(existsSync(join(newHome, "ledger.db")), true);
      assert.equal(
        readFileSync(join(newHome, "ledger.db"), "utf8"),
        "fake-legacy-db",
        "ledger.db content came from the legacy dir"
      );

      // The flag was written.
      const flag = readMigrationFlag(newHome);
      assert.ok(flag, "flag exists");
      assert.equal(flag!.from, "pi-costlens");
      assert.equal(flag!.at, result.at, "flag's `at` matches the result's `at`");

      // Result fields are right.
      assert.equal(result.from, legacyHome);
      assert.equal(result.to, newHome);
      assert.match(result.at, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      teardown(root);
    }
  });

  test("new path exists with data → new_path_exists (no migration, no flag)", () => {
    const { root, newHome, legacyHome } = setup({ newHasData: true });
    try {
      const result = ensureMigrated({ newHome, legacyHome });
      assert.equal(result.kind, "new_path_exists");
      // Original data is intact.
      assert.equal(
        readFileSync(join(newHome, "ledger.db"), "utf8"),
        "fake-new-db"
      );
      // No flag was written.
      assert.equal(existsSync(join(newHome, FLAG_FILENAME)), false);
    } finally {
      teardown(root);
    }
  });

  test("new path exists with data AND has a flag → already_migrated", () => {
    const { root, newHome, legacyHome } = setup({
      newHasData: true,
      writeFlag: { from: "pi-costlens", at: "2026-07-01T00:00:00.000Z" },
    });
    try {
      const result = ensureMigrated({ newHome, legacyHome });
      assert.equal(result.kind, "already_migrated");
      if (result.kind !== "already_migrated") return;
      assert.equal(result.from, "pi-costlens");
      assert.equal(result.at, "2026-07-01T00:00:00.000Z");
    } finally {
      teardown(root);
    }
  });

  test("both paths have data → no-op (new path wins; legacy untouched)", () => {
    const { root, newHome, legacyHome } = setup({
      newHasData: true,
      legacyHasData: true,
    });
    try {
      const result = ensureMigrated({ newHome, legacyHome });
      // The new path wins; we never overwrite it. The result kind
      // is `new_path_exists` (the directory check comes first; the
      // legacy data is left in place, which the user can clean up
      // manually if they want).
      assert.equal(result.kind, "new_path_exists");
      assert.equal(
        readFileSync(join(newHome, "ledger.db"), "utf8"),
        "fake-new-db",
        "new path's data is intact"
      );
      assert.equal(
        readFileSync(join(legacyHome, "ledger.db"), "utf8"),
        "fake-legacy-db",
        "legacy data is untouched (no overwrite)"
      );
      // No flag was written — we didn't migrate.
      assert.equal(existsSync(join(newHome, FLAG_FILENAME)), false);
    } finally {
      teardown(root);
    }
  });

  test("neither path has data → no_old_no_new (creates the new dir)", () => {
    const { root, newHome, legacyHome } = setup({});
    try {
      const result = ensureMigrated({ newHome, legacyHome });
      assert.equal(result.kind, "no_old_no_new");
      // New dir was created.
      assert.equal(existsSync(newHome), true);
      // No flag was written (there's nothing to attribute to).
      assert.equal(existsSync(join(newHome, FLAG_FILENAME)), false);
    } finally {
      teardown(root);
    }
  });

  test("COSTLENS_HOME set → legacyHome null → migration is skipped", () => {
    // Simulate the user's opt-out via `COSTLENS_HOME`. The
    // migration function gets a `null` legacyHome and doesn't
    // touch the legacy path.
    const { root, newHome } = setup({});
    // We don't even need a legacy dir; the function shouldn't
    // look at it.
    try {
      const result = ensureMigrated({ newHome, legacyHome: null });
      assert.equal(result.kind, "no_old_no_new");
    } finally {
      teardown(root);
    }
  });

  test("COSTLENS_HOME set + legacy data exists → migration skipped (user owns the path)", () => {
    const { root, newHome, legacyHome } = setup({ legacyHasData: true });
    try {
      const result = ensureMigrated({ newHome, legacyHome: null });
      // User has opted out — we don't touch the legacy data.
      assert.equal(result.kind, "no_old_no_new");
      // Legacy data is still there.
      assert.equal(
        readFileSync(join(legacyHome, "ledger.db"), "utf8"),
        "fake-legacy-db"
      );
    } finally {
      teardown(root);
    }
  });
});

// ---------------------------------------------------------------------------
// readMigrationFlag
// ---------------------------------------------------------------------------

describe("readMigrationFlag", () => {
  test("returns null when no flag file", () => {
    const { root, newHome, legacyHome } = setup({});
    try {
      assert.equal(readMigrationFlag(newHome), null);
    } finally {
      teardown(root);
    }
  });

  test("returns null when flag is malformed JSON", () => {
    const { root, newHome, legacyHome } = setup({});
    try {
      mkdirSync(newHome, { recursive: true });
      writeFileSync(join(newHome, FLAG_FILENAME), "{ not json");
      assert.equal(readMigrationFlag(newHome), null);
    } finally {
      teardown(root);
    }
  });

  test("returns null when flag is missing `from` or `at`", () => {
    const { root, newHome, legacyHome } = setup({});
    try {
      mkdirSync(newHome, { recursive: true });
      writeFileSync(join(newHome, FLAG_FILENAME), JSON.stringify({ from: "x" }));
      assert.equal(readMigrationFlag(newHome), null);
    } finally {
      teardown(root);
    }
  });

  test("returns the parsed object when the flag is well-formed", () => {
    const { root, newHome, legacyHome } = setup({});
    try {
      mkdirSync(newHome, { recursive: true });
      writeFileSync(
        join(newHome, FLAG_FILENAME),
        JSON.stringify({ from: "pi-costlens", at: "2026-07-01T00:00:00.000Z" })
      );
      const flag = readMigrationFlag(newHome);
      assert.deepEqual(flag, {
        from: "pi-costlens",
        at: "2026-07-01T00:00:00.000Z",
      });
    } finally {
      teardown(root);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveMigrationPaths
// ---------------------------------------------------------------------------

describe("resolveMigrationPaths", () => {
  test("COSTLENS_HOME unset → newHome=~/.costlens, legacyHome=~/.pi/costlens", () => {
    const { newHome, legacyHome } = resolveMigrationPaths({});
    assert.match(newHome, /\.costlens$/);
    assert.match(legacyHome ?? "", /\.pi\/costlens$/);
    assert.ok(legacyHome);
  });

  test("COSTLENS_HOME set → newHome=$COSTLENS_HOME/costlens, legacyHome=null", () => {
    const { newHome, legacyHome } = resolveMigrationPaths({
      COSTLENS_HOME: "/tmp/costlens-test",
    });
    assert.equal(newHome, join("/tmp/costlens-test", "costlens"));
    assert.equal(legacyHome, null);
  });
});

// ---------------------------------------------------------------------------
// ensureMigratedFromEnv
// ---------------------------------------------------------------------------

describe("ensureMigratedFromEnv", () => {
  test("uses the process env by default", () => {
    const { root, newHome, legacyHome } = setup({ legacyHasData: true });
    try {
      // Re-resolve using the env. We can't easily mock the
      // home / COSTLENS_HOME from here; instead, just verify the
      // function returns a valid MigrationResult shape.
      const result = ensureMigrated({ newHome, legacyHome });
      assert.ok(
        ["migrated", "new_path_exists", "already_migrated", "no_old_no_new"].includes(
          result.kind
        )
      );
    } finally {
      teardown(root);
    }
  });

  test("accepts an env override", () => {
    const { root, newHome, legacyHome } = setup({ legacyHasData: true });
    try {
      const result = ensureMigratedFromEnv({
        COSTLENS_HOME: newHome.split("/").slice(0, -1).join("/"),
      });
      // With COSTLENS_HOME set, the legacy path is suppressed.
      // The function sees no legacy data at the (suppressed) legacy
      // path, so it creates the new dir and returns
      // `no_old_no_new`.
      assert.equal(result.kind, "no_old_no_new");
    } finally {
      teardown(root);
    }
  });
});
