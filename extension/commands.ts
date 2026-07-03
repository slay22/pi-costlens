/**
 * `/feature` slash command.
 *
 * Phase 2 implements:
 *   /feature help
 *   /feature status    (with cap warning)
 *   /feature list
 *   /feature close [note]
 *   /feature cancel [note]
 *   /feature rename <name>
 *   /feature set-cap <usd>     (0 or negative to clear)
 *   /feature reopen
 *
 * Phase 5 will add: dashboard, open, note, tag, merge, search, export.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DatabaseSync } from "node:sqlite";
import {
  getCurrentFeatureId,
  getFeature,
  listFeatures,
  closeFeature,
  cancelFeature,
  renameFeature,
  setCap,
  reopenFeature,
  LifecycleError,
  type Feature,
} from "./lifecycle.js";

export type CommandDeps = {
  getActiveFeatureId: () => string | null;
  getDb: () => DatabaseSync;
  detectGitContext: (cwd: string) => Promise<{ isRepo: boolean; branch: string | null; isMainBranch: boolean }>;
  refreshFooter: (ctx: ExtensionContext) => void;
};

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand("feature", {
    description: "Costlens: manage features and view costs. Try /feature help",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      const sub = trimmed.split(/\s+/, 1)[0] || "help";
      const rest = trimmed.slice(sub.length).trim();

      try {
        switch (sub) {
          case "help":
            return showHelp(ctx);
          case "status":
            return showStatus(ctx, deps);
          case "list":
            return showList(ctx, deps);
          case "close":
            return doClose(ctx, deps, rest);
          case "cancel":
            return doCancel(ctx, deps, rest);
          case "rename":
            return doRename(ctx, deps, rest);
          case "set-cap":
          case "setcap":
            return doSetCap(ctx, deps, rest);
          case "reopen":
            return doReopen(ctx, deps);
          default:
            await ctx.ui.notify(
              `Costlens: unknown subcommand "${sub}". Try /feature help`,
              "warning"
            );
        }
      } catch (err) {
        if (err instanceof LifecycleError) {
          await ctx.ui.notify(`Costlens: ${err.message}`, "warning");
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.ui.notify(`Costlens error: ${msg}`, "error");
      }
    },
  });
}

async function showHelp(ctx: ExtensionContext): Promise<void> {
  const text =
    `Costlens — feature-based cost tracking (Phase 3)

View:
  /feature help                   This help
  /feature status                 Current feature detail (cost, cap, model breakdown)
  /feature list                   All features, sorted by recent activity

Manage the current feature:
  /feature close [note]           Mark done; cost frozen (note optional)
  /feature cancel [note]          Mark abandoned; cost frozen
  /feature reopen                 Re-open a closed/cancelled feature
  /feature rename <name>          Rename the feature (id & branch stay the same)
  /feature set-cap <usd>          Soft cap; pass 0 to clear
                                  Warns in the footer at 80% and over 100%

Examples:
  /feature close shipped to prod
  /feature rename Auth refactor
  /feature set-cap 5
  /feature set-cap 0              # clear the cap

Coming in Phase 4: dashboard (Bun server on localhost:7331)
Phase 5: tags, notes, merge, search, export

See PLAN.md for the full roadmap.`;
  await ctx.ui.notify(text, "info");
}

function capWarning(feature: Feature): string | null {
  if (feature.cap_usd == null) return null;
  if (feature.total_cost_usd > feature.cap_usd) {
    return `  ⚠ over cap by $${(feature.total_cost_usd - feature.cap_usd).toFixed(2)}`;
  }
  const pct = (feature.total_cost_usd / feature.cap_usd) * 100;
  if (pct >= 80) {
    return `  ! ${pct.toFixed(0)}% of $${feature.cap_usd.toFixed(2)} cap`;
  }
  return null;
}

async function showStatus(ctx: ExtensionContext, deps: CommandDeps): Promise<void> {
  const featureId = getCurrentFeatureId(ctx);
  if (!featureId) {
    await ctx.ui.notify("Costlens: ephemeral session, no feature tracked.", "info");
    return;
  }
  const feature = getFeature(featureId);
  if (!feature) {
    await ctx.ui.notify(`Costlens: feature "${featureId}" not found in ledger.`, "warning");
    return;
  }

  const db = deps.getDb();
  const models = db
    .prepare(
      `SELECT
         model,
         COUNT(*)             AS turns,
         SUM(cost_usd)        AS cost,
         SUM(input_tokens)    AS input_tokens,
         SUM(output_tokens)   AS output_tokens
       FROM messages
       WHERE feature_id = ?
       GROUP BY model
       ORDER BY cost DESC`
    )
    .all(featureId) as Array<{
      model: string;
      turns: number;
      cost: number;
      input_tokens: number;
      output_tokens: number;
    }>;

  const lines: string[] = [];
  lines.push(`● ${feature.name}  (${feature.status})`);
  if (feature.branch) lines.push(`  branch: ${feature.branch}`);
  const capLine = feature.cap_usd
    ? ` / $${feature.cap_usd.toFixed(2)} cap`
    : "";
  lines.push(`  cost:    $${feature.total_cost_usd.toFixed(4)}${capLine}`);
  const warn = capWarning(feature);
  if (warn) lines.push(warn);
  lines.push(
    `  tokens:  in ${feature.total_input} · out ${feature.total_output}` +
      ` · cache r ${feature.total_cache_read} · w ${feature.total_cache_write}`
  );
  lines.push(`  turns:   ${feature.turn_count}`);
  lines.push(`  pricing: ${feature.pricing_conf}`);
  if (models.length > 0) {
    lines.push(`  by model:`);
    for (const m of models) {
      lines.push(
        `    ${m.model.padEnd(28)} ${String(m.turns).padStart(3)}t  $${m.cost.toFixed(4)}` +
          `  in ${m.input_tokens} · out ${m.output_tokens}`
      );
    }
  }
  await ctx.ui.notify(lines.join("\n"), "info");
}

async function showList(ctx: ExtensionContext, deps: CommandDeps): Promise<void> {
  const features = listFeatures();
  if (features.length === 0) {
    await ctx.ui.notify("Costlens: no features yet. Start one with /feature on a non-main branch.", "info");
    return;
  }
  // Compact table.
  const lines: string[] = [];
  lines.push(
    "feature".padEnd(34) +
      "status".padEnd(11) +
      "turns".padStart(5) +
      "  cost".padStart(11) +
      "  cap".padStart(8) +
      "  last"
  );
  lines.push("-".repeat(80));
  for (const f of features) {
    const cap = f.cap_usd ? `$${f.cap_usd.toFixed(2)}` : "-";
    const last = f.last_activity_at
      ? new Date(f.last_activity_at).toISOString().slice(0, 16).replace("T", " ")
      : "-";
    const over = f.cap_usd && f.total_cost_usd > f.cap_usd ? "!" : " ";
    lines.push(
      (f.id === "unassigned" ? "unassigned" : f.name).padEnd(34).slice(0, 34) +
        ` ${f.status.padEnd(10)}` +
        String(f.turn_count).padStart(5) +
        over +
        "  $" +
        f.total_cost_usd.toFixed(4).padStart(8) +
        "  " +
        cap.padStart(7) +
        "  " +
        last
    );
  }
  await ctx.ui.notify(lines.join("\n"), "info");
  // touch deps to silence unused
  void deps;
}

async function doClose(ctx: ExtensionContext, deps: CommandDeps, note: string): Promise<void> {
  const id = getCurrentFeatureId(ctx);
  if (!id) {
    await ctx.ui.notify("Costlens: no active feature to close.", "warning");
    return;
  }
  const f = closeFeature(id, note);
  deps.refreshFooter(ctx);
  await ctx.ui.notify(
    `Costlens: closed "${f.name}" as done. Cost frozen at $${f.total_cost_usd.toFixed(4)} across ${f.turn_count} turn${f.turn_count === 1 ? "" : "s"}.` +
      (note ? `\n  note: ${note}` : ""),
    "info"
  );
}

async function doCancel(ctx: ExtensionContext, deps: CommandDeps, note: string): Promise<void> {
  const id = getCurrentFeatureId(ctx);
  if (!id) {
    await ctx.ui.notify("Costlens: no active feature to cancel.", "warning");
    return;
  }
  const f = cancelFeature(id, note);
  deps.refreshFooter(ctx);
  await ctx.ui.notify(
    `Costlens: cancelled "${f.name}" as abandoned. Cost frozen at $${f.total_cost_usd.toFixed(4)} across ${f.turn_count} turn${f.turn_count === 1 ? "" : "s"}.` +
      (note ? `\n  note: ${note}` : ""),
    "info"
  );
}

async function doRename(ctx: ExtensionContext, deps: CommandDeps, rest: string): Promise<void> {
  if (!rest) {
    await ctx.ui.notify("Costlens: usage: /feature rename <new-name>", "warning");
    return;
  }
  const id = getCurrentFeatureId(ctx);
  if (!id) {
    await ctx.ui.notify("Costlens: no active feature to rename.", "warning");
    return;
  }
  const f = renameFeature(id, rest);
  deps.refreshFooter(ctx);
  await ctx.ui.notify(`Costlens: renamed to "${f.name}" (id still "${f.id}").`, "info");
}

async function doSetCap(ctx: ExtensionContext, deps: CommandDeps, rest: string): Promise<void> {
  const id = getCurrentFeatureId(ctx);
  if (!id) {
    await ctx.ui.notify("Costlens: no active feature to set a cap on.", "warning");
    return;
  }
  const num = Number(rest);
  if (rest === "" || isNaN(num) || num < 0) {
    await ctx.ui.notify("Costlens: usage: /feature set-cap <usd>   (0 or negative to clear)", "warning");
    return;
  }
  const f = setCap(id, num === 0 ? null : num);
  deps.refreshFooter(ctx);
  if (f.cap_usd == null) {
    await ctx.ui.notify(`Costlens: cap cleared for "${f.name}".`, "info");
  } else {
    await ctx.ui.notify(
      `Costlens: cap set to $${f.cap_usd.toFixed(2)} for "${f.name}" (currently $${f.total_cost_usd.toFixed(4)}).`,
      "info"
    );
  }
}

async function doReopen(ctx: ExtensionContext, deps: CommandDeps): Promise<void> {
  const id = getCurrentFeatureId(ctx);
  if (!id) {
    await ctx.ui.notify("Costlens: no active feature to reopen.", "warning");
    return;
  }
  const f = reopenFeature(id);
  deps.refreshFooter(ctx);
  await ctx.ui.notify(`Costlens: reopened "${f.name}" (status: ${f.status}).`, "info");
}
