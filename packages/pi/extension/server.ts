/**
 * Dashboard server lifecycle.
 *
 * `startServer` spawns the Bun server (`server/index.ts`) as a child
 * process and waits for it to become healthy. `stopServer` kills the
 * child (or, if `detach: true`, the recorded PID).
 *
 * Two modes:
 *   - default: child is tied to the extension's lifetime. Killed on
 *     `session_shutdown`.
 *   - detach:  child is detached. PID is recorded in `server.pid`
 *     and the child is unref'd so it survives pi exit. Killed via
 *     `/feature dashboard stop` or the user killing the PID.
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readConfig, getConfigPath } from "./config.js";
import { findFreePort } from "@costlens/core";

// `getCostlensHome` is no longer exported from ./config.js
// (step 2 moved it to @costlens/core's db module). The PID file
// lives at the legacy `~/.pi/costlens/` path until step 3 migrates
// it. Compute it from the config file path to avoid a circular
// re-export through the config shim.
import { dirname as _dirname } from "node:path";
const COSTLENS_HOME = _dirname(getConfigPath());
const SERVER_PID_PATH = join(COSTLENS_HOME, "server.pid");

const execFileAsync = promisify(execFile);

let _child: ChildProcess | null = null;
let _handle: ServerHandle | null = null;

export type ServerHandle = {
  pid: number;
  port: number;
  detach: boolean;
  startedAt: string;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealth(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/**
 * Resolve the path to the dashboard server entry point.
 *
 * Phase 9 step 2: the server moved from
 * `packages/pi/server/index.ts` to `packages/core/src/server/index.ts`.
 * The path layout is now:
 *
 *   extension/server.ts    -> packages/pi/extension/server.ts
 *   core/src/server/index.ts  -> packages/core/src/server/index.ts
 *
 * So from `packages/pi/extension/server.ts`, the relative path is
 * `../../core/src/server/index.ts`. We resolve via `import.meta.url`
 * so jiti's loader doesn't hard-code a path.
 */
function serverScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "core", "src", "server", "index.ts");
}

export async function startServer(opts: { detach: boolean }): Promise<ServerHandle> {
  // If a detached server is already running, reuse it.
  if (existsSync(SERVER_PID_PATH)) {
    const pidRaw = readFileSync(SERVER_PID_PATH, "utf8").trim();
    const pid = Number(pidRaw);
    if (pid && isAlive(pid)) {
      const config = readConfig();
      const handle: ServerHandle = {
        pid,
        port: config.port,
        detach: true,
        startedAt: new Date().toISOString(),
      };
      _handle = handle;
      return handle;
    }
    unlinkSync(SERVER_PID_PATH);
  }

  // If we already have a non-detached child, return it.
  if (_child && _handle && !_handle.detach) {
    return _handle;
  }

  const config = readConfig();
  // Find a free port starting from the configured one. If the
  // configured port is taken, fall through to the next free port in
  // 7331..7399 so a half-orphaned server doesn't block the user.
  const port = await findFreePort(config.port);
  if (port == null) {
    throw new Error(
      `No free port found in 7331..7399 starting from ${config.port}. ` +
        `Use /feature set-port <N> to pick a different one.`
    );
  }

  const scriptPath = serverScriptPath();
  const child = spawn("bun", [scriptPath], {
    env: {
      ...process.env,
      // Phase 9 step 3: pass the parent of the new home. With
      // `COSTLENS_HOME=~`, the child resolves its costlens dir as
      // `~/.costlens` (the new path) — the migration runs at the
      // child's startup and the legacy `~/.pi/costlens/` data is
      // moved into place if needed.
      COSTLENS_HOME: process.env.COSTLENS_HOME ?? homedir(),
      COSTLENS_PORT: String(port),
    },
    detached: opts.detach,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Tee the child's output to our stderr for debugging. In a TUI this
  // is invisible; in print mode it shows up in the log.
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[costlens-server] ${chunk}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[costlens-server] ${chunk}`);
  });
  child.on("exit", (code) => {
    if (_handle && _handle.pid === child.pid) {
      _child = null;
      _handle = null;
    }
    process.stderr.write(`[costlens-server] exited with code ${code}\n`);
  });

  const handle: ServerHandle = {
    pid: child.pid ?? 0,
    port,
    detach: opts.detach,
    startedAt: new Date().toISOString(),
  };
  _child = child;
  _handle = handle;

  if (opts.detach) {
    mkdirSync(COSTLENS_HOME, { recursive: true });
    writeFileSync(SERVER_PID_PATH, String(child.pid));
    child.unref();
  }

  const ok = await waitForHealth(port);
  if (!ok) {
    // Clean up the child we just spawned.
    try { child.kill("SIGKILL"); } catch {}
    _child = null;
    _handle = null;
    throw new Error(
      `Server did not become healthy on port ${port} within 5s. Check that bun is on PATH.`
    );
  }

  // If we landed on a port other than the configured one, tell the
  // user so they can update their config.
  if (port !== config.port) {
    process.stderr.write(
      `[costlens-server] preferred port ${config.port} was taken; using ${port}\n`
    );
  }

  return handle;
}

export async function stopServer(): Promise<{ stopped: boolean; pid?: number }> {
  // Non-detached child
  if (_child && _handle && !_handle.detach) {
    const pid = _child.pid;
    _child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { _child?.kill("SIGKILL"); } catch {}
        resolve();
      }, 2000);
      _child!.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    _child = null;
    _handle = null;
    return { stopped: true, pid };
  }

  // Detached child via PID file
  if (existsSync(SERVER_PID_PATH)) {
    const pid = Number(readFileSync(SERVER_PID_PATH, "utf8").trim());
    if (pid && isAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      // Give it 2s, then SIGKILL
      await new Promise((r) => setTimeout(r, 2000));
      if (isAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    unlinkSync(SERVER_PID_PATH);
    if (_handle?.detach) {
      _handle = null;
    }
    return { stopped: true, pid };
  }

  return { stopped: false };
}

export function getCurrentServer(): ServerHandle | null {
  return _handle;
}

/**
 * Open a URL in the user's default browser.
 * Respects $BROWSER, then falls back to platform defaults.
 */
export async function openBrowser(url: string): Promise<void> {
  const custom = process.env.BROWSER;
  if (custom) {
    await execFileAsync(custom, [url], { timeout: 5000 });
    return;
  }
  const cmd = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
    ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  await execFileAsync(cmd, args, { timeout: 5000 });
}
