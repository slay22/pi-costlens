/**
 * The dashboard server runs as a *child process* and resolves its own
 * database directory from the environment. If the parent hands it a
 * `COSTLENS_HOME` that the child interprets differently, the server
 * exits immediately with:
 *
 *     Costlens DB not found at /Users/<me>/costlens/ledger.db
 *
 * That is exactly what happened when the spawn injected `homedir()`:
 * core reads `COSTLENS_HOME` as the **parent** of the `costlens/`
 * directory (`$COSTLENS_HOME/costlens`) and only falls back to the
 * dotted `~/.costlens` when the variable is unset — so `$HOME`
 * resolved to `~/costlens` (no dot).
 *
 * The invariant these tests pin: the child's resolved directory must
 * equal the extension's own, for both env shapes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { serverChildEnv } from "../extension/server.js";
import { getConfigPath } from "../extension/config.js";

/**
 * Core's resolution, mirrored on purpose: this is the contract the
 * child process implements (`packages/core/src/db.ts`).
 */
function childHome(env: NodeJS.ProcessEnv): string {
  return env.COSTLENS_HOME
    ? join(env.COSTLENS_HOME, "costlens")
    : join(homedir(), ".costlens");
}

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.COSTLENS_HOME;
  if (value === undefined) delete process.env.COSTLENS_HOME;
  else process.env.COSTLENS_HOME = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.COSTLENS_HOME;
    else process.env.COSTLENS_HOME = prev;
  }
}

test("COSTLENS_HOME unset: child resolves the same dir as the extension", () => {
  withEnv(undefined, () => {
    // An empty base env: the spawn must not synthesize COSTLENS_HOME.
    const env = serverChildEnv(7331, {});
    assert.equal(
      env.COSTLENS_HOME,
      undefined,
      "must not inject a COSTLENS_HOME — it would defeat the dotted default"
    );
    assert.equal(childHome(env), dirname(getConfigPath()));
    assert.equal(childHome(env), join(homedir(), ".costlens"));
  });
});

test("COSTLENS_HOME set: passed through untouched so parent and child agree", () => {
  withEnv("/tmp/costlens-custom", () => {
    const env = serverChildEnv(7331);
    assert.equal(env.COSTLENS_HOME, "/tmp/costlens-custom");
    assert.equal(childHome(env), dirname(getConfigPath()));
    assert.equal(childHome(env), "/tmp/costlens-custom/costlens");
  });
});

test("the port is always exported to the child", () => {
  assert.equal(serverChildEnv(7399, {}).COSTLENS_PORT, "7399");
  assert.equal(serverChildEnv(7331).COSTLENS_PORT, "7331");
});
