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
import { getCostlensHome, readConfig } from "./config.js";

const execFileAsync = promisify(execFile);

const SERVER_PID_PATH = join(getCostlensHome(), "server.pid");

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

/** Resolve the path to `server/index.ts` relative to this module. */
function serverScriptPath(): string {
  // extension/server.ts -> ../server/index.ts
  // import.meta.url is the URL of this module.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "server", "index.ts");
}

async function portInUse(port: number): Promise<boolean> {
  try {
    await execFileAsync("lsof", ["-ti", `tcp:${port}`], { timeout: 1000 });
    return true;
  } catch {
    return false;
  }
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
  if (await portInUse(config.port)) {
    throw new Error(
      `Port ${config.port} is already in use. Either /feature set-port <N> to change it, or stop the other process.`
    );
  }

  const scriptPath = serverScriptPath();
  const child = spawn("bun", [scriptPath], {
    env: {
      ...process.env,
      COSTLENS_HOME: process.env.COSTLENS_HOME ?? join(homedir(), ".pi"),
      COSTLENS_PORT: String(config.port),
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
    port: config.port,
    detach: opts.detach,
    startedAt: new Date().toISOString(),
  };
  _child = child;
  _handle = handle;

  if (opts.detach) {
    mkdirSync(getCostlensHome(), { recursive: true });
    writeFileSync(SERVER_PID_PATH, String(child.pid));
    child.unref();
  }

  const ok = await waitForHealth(config.port);
  if (!ok) {
    // Clean up the child we just spawned.
    try { child.kill("SIGKILL"); } catch {}
    _child = null;
    _handle = null;
    throw new Error(
      `Server did not become healthy on port ${config.port} within 5s. Check that bun is on PATH.`
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
