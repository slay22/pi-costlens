#!/usr/bin/env node
/**
 * Prepack hook for pi-costlens.
 *
 * Phase 9 step 6: the published pi-costlens tarball needs README.md
 * and LICENSE at its root, but those files live at the monorepo
 * root (one level up + ../../). npm's `files` field doesn't allow
 * `..` paths. So before `pnpm pack` (or `pnpm publish`) copies
 * files into the tarball, this script copies them in from the
 * monorepo root.
 *
 * `postpack` (in package.json) cleans them up after `pnpm pack` so
 * the working tree doesn't have stray copies. Note: `postpack`
 * does NOT run after `pnpm publish`, only after `pnpm pack`, so
 * for a real `pnpm publish` flow, the maintainer should run a
 * `git status` after publishing to confirm the working tree is
 * clean.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// packages/pi/scripts → ../../ (monorepo root)
const monorepoRoot = join(here, "..", "..", "..");
const packageDir = join(here, "..");

const files = ["README.md", "LICENSE", "CHANGELOG.md"];

for (const name of files) {
  const src = join(monorepoRoot, name);
  const dst = join(packageDir, name);
  if (!existsSync(src)) {
    // CHANGELOG.md may not exist for the very first publish; skip
    // quietly. The other two are required.
    if (name === "CHANGELOG.md") {
      console.warn(`costlens prepack: ${src} not found, skipping`);
      continue;
    }
    console.error(`costlens prepack: required file not found: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, dst);
  console.log(`costlens prepack: copied ${name}`);
}
