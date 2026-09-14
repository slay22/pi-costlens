/**
 * Guards the dashboard's static assets.
 *
 * Why this exists: `feature.js` could not parse for two months. A merge
 * (phase 7 × phase 7.5) was committed **with its conflict markers**, and
 * a constructor in the same file used TypeScript parameter properties
 * (`constructor(public code, …)`) in a `.js` file. The browser rejected
 * the whole script, so `/feature/<id>` rendered its static defaults
 * forever — clicking a row "showed nothing" — while the overview page
 * (a different file) looked perfectly fine.
 *
 * Compiling each asset with `vm.Script` catches that entire class:
 * conflict markers, stray TypeScript, unbalanced braces, anything.
 * Nothing else in the suite touches these files, because they never
 * pass through the TypeScript compiler.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, "web");

const FILES = readdirSync(WEB_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);
const SCRIPTS = FILES.filter((f) => f.endsWith(".js"));

test("the web asset directory is actually being scanned", () => {
  // A silent zero-file scan would make the guards below vacuous.
  assert.ok(SCRIPTS.length >= 2, `expected several scripts, found ${SCRIPTS.length}`);
  assert.ok(FILES.includes("feature.js"), "feature.js must be present");
});

test("every dashboard script parses as plain JavaScript", () => {
  for (const file of SCRIPTS) {
    const source = readFileSync(join(WEB_DIR, file), "utf8");
    assert.doesNotThrow(
      () => new Script(source, { filename: file }),
      `${file} must parse — it is served to the browser verbatim`
    );
  }
});

test("no dashboard asset carries committed conflict markers", () => {
  const markers = ["<<<<<<< ", ">>>>>>> "];
  for (const file of FILES) {
    const source = readFileSync(join(WEB_DIR, file), "utf8");
    for (const marker of markers) {
      const line = source
        .split("\n")
        .findIndex((l) => l.startsWith(marker));
      assert.equal(
        line,
        -1,
        `${file}:${line + 1} has a ${marker.trim()} conflict marker`
      );
    }
    assert.ok(
      !source.split("\n").some((l) => l.trim() === "======="),
      `${file} has a conflict separator`
    );
  }
});
