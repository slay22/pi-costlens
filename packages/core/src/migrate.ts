/**
 * Legacy data migration: `~/.pi/costlens/` → `~/.costlens/`.
 *
 * Phase 9 step 3 (MULTI-TOOL.md §6). Every pre-step-3 user has data
 * at `~/.pi/costlens/`. The new path is tool-agnostic
 * (`~/.costlens/`) — every adapter (pi, opencode, claude-code) writes
 * to the same directory. This module handles the one-shot rename
 * lazily, on first read.
 *
 * ## Decision logic
 *
 * 1. If the new path has a `ledger.db`:
 *    - If `.migrated-from-pi` exists, the migration already ran.
 *      Report `already_migrated` (the flag's `at` field is the
 *      migration time; useful for the "Welcome to v2" banner).
 *    - Otherwise, report `new_path_exists` (the user has been
 *      running v2 already and created the directory manually).
 * 2. Else if `COSTLENS_HOME` is unset AND the legacy path has a
 *    `ledger.db`:
 *    - Rename `~/.pi/costlens` → `~/.costlens` (the directory move
 *      brings `ledger.db` and `config.json` along).
 *    - Write `.migrated-from-pi` with `{ from: "pi-costlens", at }`.
 *    - Report `migrated`.
 * 3. Else:
 *    - Create the new path (mkdir -p) for a fresh install.
 *    - Report `no_old_no_new`.
 *
 * ## Why lazy, not postinstall
 *
 * Postinstall scripts are a security concern; some package managers
 * (yarn pnp, bun) handle them differently. Lazy-on-read is
 * universal, idempotent, and the first-message-after-upgrade
 * slowdown is imperceptible (one fs.stat + at most one rename).
 *
 * ## `COSTLENS_HOME`
 *
 * The env var from Phase 4 lets power users point costlens at a
 * non-default directory. Per §6, the migration only runs against
 * the legacy default `~/.pi/costlens/` — when `COSTLENS_HOME` is
 * set, the user has taken control of the path and the migration
 * is a no-op (the new and legacy paths collapse to one). Rollback
 * instructions in MULTI-TOOL.md §15.
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What the migration did. The dashboard's "Welcome to v2" banner
 * keys off `migrated` / `already_migrated`; the extension's
 * first-run check could log `migrated` to surface that the rename
 * happened.
 */
export type MigrationResult =
  /** The legacy directory was just renamed into place. */
  | { kind: "migrated"; from: string; to: string; at: string }
  /** New path exists, and `.migrated-from-pi` is present from a prior run. */
  | { kind: "already_migrated"; from: string; at: string }
  /** New path exists with data; no flag (e.g. fresh v2 install). */
  | { kind: "new_path_exists" }
  /** Neither path had data; new path was created empty. */
  | { kind: "no_old_no_new" };

export const FLAG_FILENAME = ".migrated-from-pi";

/** Read the migration flag, or `null` if absent / malformed. */
export function readMigrationFlag(newHome: string): { from: string; at: string } | null {
  const flagPath = join(newHome, FLAG_FILENAME);
  if (!existsSync(flagPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(flagPath, "utf8")) as {
      from?: unknown;
      at?: unknown;
    };
    if (typeof parsed.from === "string" && typeof parsed.at === "string") {
      return { from: parsed.from, at: parsed.at };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Compute the new + legacy home dirs.
 *
 * - `COSTLENS_HOME` set: new = `$COSTLENS_HOME/costlens`, legacy = null
 *   (the user has opted out of the migration by setting the env var).
 * - `COSTLENS_HOME` unset: new = `~/.costlens`, legacy = `~/.pi/costlens`.
 */
export function resolveMigrationPaths(env: Record<string, string | undefined> = process.env): {
  newHome: string;
  legacyHome: string | null;
} {
  if (env.COSTLENS_HOME) {
    return { newHome: join(env.COSTLENS_HOME, "costlens"), legacyHome: null };
  }
  return {
    newHome: join(homedir(), ".costlens"),
    legacyHome: join(homedir(), ".pi", "costlens"),
  };
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

/**
 * Run the migration if needed. Idempotent: safe to call on every
 * `setCoreDb()` / server startup. The work is bounded to a few
 * filesystem ops (stat, mkdir, optionally rename + flag write).
 *
 * @param opts.newHome    the target directory (typically `~/.costlens/`)
 * @param opts.legacyHome the source directory (`~/.pi/costlens/`) or
 *                        `null` to skip the migration entirely
 * @param opts.now        override "now" for tests; defaults to a new
 *                        ISO timestamp
 */
export function ensureMigrated(opts: {
  newHome: string;
  legacyHome: string | null;
  now?: string;
}): MigrationResult {
  const { newHome, legacyHome } = opts;
  const now = opts.now ?? new Date().toISOString();
  const newDb = join(newHome, "ledger.db");
  const flagPath = join(newHome, FLAG_FILENAME);

  // Case 1: new path already has data. Distinguish "migrated in a
  // prior run" (flag present) from "fresh v2 install" (no flag).
  if (existsSync(newDb)) {
    const flag = readMigrationFlag(newHome);
    if (flag) return { kind: "already_migrated", from: flag.from, at: flag.at };
    return { kind: "new_path_exists" };
  }

  // Case 2: legacy path has data AND the user hasn't set COSTLENS_HOME.
  // Rename the whole directory; the ledger + config + any other
  // files come along for free.
  if (legacyHome && existsSync(join(legacyHome, "ledger.db"))) {
    mkdirSync(newHome, { recursive: true });
    renameSync(legacyHome, newHome);
    writeFileSync(
      flagPath,
      JSON.stringify({ from: "pi-costlens", at: now }, null, 2) + "\n"
    );
    return { kind: "migrated", from: legacyHome, to: newHome, at: now };
  }

  // Case 3: neither path has data. Fresh install — create the new
  // path so subsequent open() calls don't fail.
  mkdirSync(newHome, { recursive: true });
  return { kind: "no_old_no_new" };
}

/**
 * Convenience wrapper: resolves the paths from `process.env` and
 * runs the migration. The extension's `initDb()` and the server's
 * startup call this; tests pass the paths explicitly.
 */
export function ensureMigratedFromEnv(
  env: Record<string, string | undefined> = process.env
): MigrationResult {
  const { newHome, legacyHome } = resolveMigrationPaths(env);
  return ensureMigrated({ newHome, legacyHome });
}
