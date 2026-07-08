/** @jsxImportSource solid-js */
/**
 * opencode-costlens — TUI plugin.
 *
 * Loaded as `opencode-costlens/tui` by the opencode TUI process.
 * The TUI runs in a separate Bun process from the server; they share
 * the SQLite ledger on disk (WAL mode allows concurrent reads).
 *
 * v1.0 scope:
 *   ✓ home_footer slot: shows current session cost + feature name
 *   ✓ /costlens command: opens the dashboard in the browser
 *   ✗ notifications (v1.5)
 *   ✗ tags/notes/search/export commands (v1.6)
 *
 * API source: sst/opencode packages/plugin/src/tui.ts (2026-07-08).
 * The TuiPlugin receives `api` with:
 *   api.state.session.get(id)  → reactive session (cost, tokens, messages)
 *   api.ui.Slot(opts, fn)      → render into a named TUI slot (Solid JSX)
 *   api.ui.toast(opts)         → ephemeral in-app notification
 *   api.command.register(fn)   → add slash-command entries
 *   api.lifecycle.onDispose(fn)→ cleanup hook
 *   api.tuiConfig.path.directory → project directory
 *
 * TODO: replace inline type stubs with:
 *   `import type { TuiPlugin } from "@opencode-ai/plugin/tui"` once
 *   a stable published version is available.
 */

import { createSignal, createMemo, onCleanup } from "solid-js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "@costlens/core";

// ---------------------------------------------------------------------------
// Minimal TUI type stubs
// ---------------------------------------------------------------------------

type TuiApi = {
  state: {
    /** Reactive map of sessionID → session data. */
    session: {
      get(id: string): { cost?: number; tokens?: { input?: number; output?: number } } | undefined;
      list(): Array<{ id: string; cost?: number }>;
    };
    /** The currently active (most recent) session ID, or null. */
    activeSession?: () => string | null;
  };
  ui: {
    Slot(
      opts: { name: string },
      render: () => unknown
    ): void;
    toast(opts: {
      variant: "info" | "success" | "error" | "warning";
      message: string;
      duration?: number;
    }): void;
  };
  command: {
    register(
      fn: () => Array<{
        title: string;
        value: string;
        slash?: { name: string; description?: string };
        onSelect?: () => void | Promise<void>;
      }>
    ): void;
  };
  lifecycle: {
    onDispose(fn: () => void): void;
  };
  tuiConfig: {
    path: { directory: string };
  };
  event: {
    on(type: string, fn: (payload: unknown) => void): () => void;
  };
};

type TuiPlugin = (api: TuiApi) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the core server entry point relative to this file. */
function serverScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // opencode/src/ → packages/ → workspace root → packages/core/src/server/
  return join(here, "..", "..", "core", "src", "server", "index.ts");
}

async function waitForHealth(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let _serverChild: ReturnType<typeof spawn> | null = null;
let _serverPort = 0;

async function startDashboard(): Promise<{ port: number } | null> {
  if (_serverChild && _serverPort) return { port: _serverPort };
  const cfg = readConfig();
  const port = cfg.port;
  const script = serverScriptPath();
  if (!existsSync(script)) {
    console.error("[costlens] server script not found:", script);
    return null;
  }
  _serverChild = spawn("bun", [script], {
    env: { ...process.env, COSTLENS_PORT: String(port) },
    stdio: "ignore",
    detached: false,
  });
  const ok = await waitForHealth(port);
  if (!ok) {
    _serverChild.kill();
    _serverChild = null;
    return null;
  }
  _serverPort = port;
  return { port };
}

async function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "cmd"
    : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

// ---------------------------------------------------------------------------
// TUI plugin export
// ---------------------------------------------------------------------------

/**
 * The opencode TUI plugin. Loaded as `opencode-costlens/tui`.
 *
 * Usage: same `opencode.json` entry as the server plugin — opencode
 * loads both `./server` and `./tui` from a single plugin declaration.
 */
export const CostlensTui: TuiPlugin = (api) => {
  // Reactive signal: last known total cost for the active session.
  // Refreshed every time session.idle fires (i.e. after each turn).
  const [sessionCost, setSessionCost] = createSignal<number | null>(null);
  const [featureName, setFeatureName] = createSignal<string>("");

  // Watch session.idle to refresh the cost signal.
  const off = api.event.on("session.idle", (payload: unknown) => {
    const p = payload as { sessionID?: string } | undefined;
    if (!p?.sessionID) return;
    const s = api.state.session.get(p.sessionID);
    if (s?.cost != null) setSessionCost(s.cost);
    // Feature name: opencode doesn't expose the feature id directly;
    // we show the active session cost and let the dashboard provide
    // the full feature breakdown.
  });
  api.lifecycle.onDispose(() => {
    off();
    if (_serverChild) { _serverChild.kill(); _serverChild = null; }
  });

  // Footer slot: "● costlens $X.XXXX" (updates after each turn).
  try {
    api.ui.Slot({ name: "home_footer" }, () => {
      const cost = sessionCost();
      if (cost == null) return null;
      const c = cost.toFixed(4);
      const bullet = cost > 0 ? "●" : "○";
      // JSX — rendered by Solid inside the opencode TUI.
      // `text` is a built-in @opentui/solid primitive element.
      // @ts-ignore — `text` from @opentui/solid; not importable as a type here
      return <text>{`${bullet} costlens $${c}`}</text>;
    });
  } catch {
    // Graceful degradation: if the Slot API fails (e.g. wrong element
    // type), the footer is absent but capture still works.
  }

  // /costlens command: spawns the dashboard server + opens browser.
  api.command.register(() => [
    {
      title: "Costlens — open dashboard",
      value: "costlens.dashboard",
      slash: { name: "costlens", description: "Open the costlens cost dashboard" },
      onSelect: async () => {
        api.ui.toast({ variant: "info", message: "costlens: starting dashboard…" });
        const result = await startDashboard();
        if (!result) {
          api.ui.toast({
            variant: "error",
            message: "costlens: failed to start server (bun not found?)",
          });
          return;
        }
        const url = `http://localhost:${result.port}/`;
        await openBrowser(url);
        api.ui.toast({ variant: "success", message: `costlens: opened ${url}` });
      },
    },
  ]);
};

export default CostlensTui;
