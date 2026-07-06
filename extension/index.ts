/**
 * Costlens — pi extension entry point.
 *
 * Loaded by pi via jiti from `~/.pi/agent/extensions/costlens/index.ts`
 * (or via the `extensions` field in settings.json).
 *
 * Responsibilities:
 *   - Lazy-init the SQLite ledger
 *   - Register lifecycle hooks
 *   - Register the `/feature` slash command
 *   - Render the status footer
 *
 * Phase 2 adds:
 *   - Y/n prompt for fresh branches at session_start
 *   - Closed features on the current branch notify (don't auto-resume)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initDb, closeDb, getDb } from "./db.js";
import { registerHooks } from "./hooks.js";
import { registerCommands } from "./commands.js";
import { detectGitContext } from "./git.js";
import {
  ensureFeatureForSession,
  getActiveFeatureId,
  setActiveFeature,
  getFeature,
} from "./lifecycle.js";
import { renderFooter, clearFooter } from "./footer.js";
import { stopServer } from "./server.js";

export default function (pi: ExtensionAPI) {
  // Open the DB once the first session starts. The factory itself must not
  // start background resources per the pi extension guidelines.
  let dbReady = false;

  pi.on("session_start", async (_event, ctx) => {
    if (!dbReady) {
      initDb();
      dbReady = true;
    }

    // Detect branch and resolve the active feature for this session.
    const git = await detectGitContext(ctx.cwd);
    const featureId = await ensureFeatureForSession(
      {
        cwd: ctx.cwd,
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        git,
      },
      async () => {
        // Y/n prompt. Defaults to yes. Skipped if no UI.
        if (!ctx.hasUI) return true;
        const branchName = git.branch ?? "(no branch)";
        return await ctx.ui.confirm(
          "Costlens",
          `Start a feature for branch "${branchName}"?\n` +
            `Costs will be booked to a new feature.\n` +
            `(Y / n)`
        );
      }
    );
    setActiveFeature(featureId, git);

    // If the user is on a branch with a closed feature, warn them.
    if (ctx.hasUI && git.branch && featureId === "unassigned") {
      const closed = getFeature(git.branch);
      if (closed && closed.status !== "open") {
        await ctx.ui.notify(
          `Costlens: feature "${closed.name}" is ${closed.status} on this branch. ` +
            `New costs will go to \`unassigned\`. Use /feature reopen to resume.`,
          "info"
        );
      }
    }

    renderFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) clearFooter(ctx);
    // Stop the dashboard server if it's a child of this session.
    // Detached servers are left running.
    try {
      await stopServer();
    } catch {
      // best-effort
    }
    closeDb();
    dbReady = false;
  });

  // After each turn, refresh the footer so cost/turn count stays current.
  pi.on("turn_end", async (_event, ctx) => {
    renderFooter(ctx);
  });

  // Capture every assistant message's cost/tokens.
  registerHooks(pi);

  // Register `/feature` slash command.
  registerCommands(pi, {
    getActiveFeatureId: () => getActiveFeatureId(),
    getDb: () => getDb(),
    detectGitContext,
    refreshFooter: (ctx) => renderFooter(ctx),
  });
}
