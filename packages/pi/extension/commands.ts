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
 * Phase 4 adds: dashboard, open, set-port.
 *
 * Phase 5 adds:
 *   /feature note <text>
 *   /feature tag add|remove <t>
 *   /feature tag list
 *   /feature merge
 *   /feature search <query>
 *   /feature export csv|json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CoreDatabase } from "@costlens/core";
import {
  getCurrentFeatureId,
  getFeature,
  listFeatures,
  closeFeature,
  cancelFeature,
  renameFeature,
  setCap,
  reopenFeature,
  mergeFeature,
  addTag,
  removeTag,
  listTags,
  searchFeatures,
  attachNote,
  getNotes,
  exportLedger,
  exportLedgerCsv,
  getSubagentSummary,
  LifecycleError,
  type Feature,
} from "./lifecycle.js";
import { readConfig, writeConfig, getDefaultThresholds } from "./config.js";
import { startServer, stopServer, openBrowser } from "./server.js";
import { notify as sendNotify } from "./notifications.js";

export type CommandDeps = {
  getActiveFeatureId: () => string | null;
  getDb: () => CoreDatabase;
  detectGitContext: (cwd: string) => Promise<{ isRepo: boolean; branch: string | null; isMainBranch: boolean }>;
  refreshFooter: (ctx: ExtensionContext) => void;
  /** Phase 6: called after a feature is reopened, so the notifications module can clear its debounce. */
  onReopen?: (featureId: string) => void;
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
          case "merge":
            return doMerge(ctx, deps, rest);
          case "rename":
            return doRename(ctx, deps, rest);
          case "set-cap":
          case "setcap":
            return doSetCap(ctx, deps, rest);
          case "reopen":
            return doReopen(ctx, deps);
          case "tag":
            return doTag(ctx, deps, rest);
          case "note":
            return doNote(ctx, deps, rest);
          case "search":
            return doSearch(ctx, deps, rest);
          case "export":
            return doExport(ctx, deps, rest);
          case "notify-test":
            return doNotifyTest(ctx, deps, rest);
          case "notify-config":
            return doNotifyConfig(ctx, deps, rest);
          case "dashboard":
            return doDashboard(ctx, deps, rest);
          case "open":
            return doOpen(ctx, deps, rest);
          case "set-port":
          case "setport":
            return doSetPort(ctx, deps, rest);
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
    `Costlens — feature-based cost tracking (Phase 7)

View:
  /feature help                   This help
  /feature status                 Current feature detail (cost, cap, model breakdown, tags)
  /feature list                   All features (name, status, tags, cost, last)
  /feature search <query>         Find features by id/name fragment

Manage the current feature:
  /feature close [note]           Mark done; cost frozen
  /feature cancel [note]          Mark abandoned; cost frozen
  /feature merge [note]           Mark merged; cost frozen (third "ended" state)
  /feature reopen                 Re-open a closed/cancelled/merged feature
  /feature rename <name>          Rename the feature (id & branch stay the same)
  /feature set-cap <usd>          Soft cap; pass 0 to clear
                                  Notifies (in-pi + native + optional webhook) at
                                  50% / 80% / 100% / 110% of cap
  /feature note <text>            Attach a note (timestamped, standalone)
  /feature tag add <t>            Tag the current feature (free-form, lowercased)
  /feature tag remove <t>         Remove a tag
  /feature tag list               List tags on the current feature

Export (stdout):
  /feature export json            Full ledger as JSON
  /feature export csv             Full ledger as CSV (5 sections)

Notifications (Phase 6):
  /feature notify-test            Fire a test notification (in-pi + native)
  /feature notify-config          Print current notification config
  /feature notify-config on|off   Master switch
  /feature notify-config webhook <url>|clear
  /feature notify-config daily-digest on|off
  /feature notify-config daily-threshold <usd>
  /feature notify-config thresholds <list>   e.g. 0.5,0.8,1.0,1.1

Dashboard:
  /feature dashboard              Start server + open browser to overview
  /feature dashboard --detach     Start server that survives pi exit
  /feature dashboard stop         Kill the running server
  /feature open <name>            Open feature detail page
  /feature set-port <N>           Set the dashboard port (1..65535)

Examples:
  /feature tag add client:acme
  /feature note handed off to jane
  /feature close shipped to prod
  /feature rename Auth refactor
  /feature set-cap 5
  /feature search auth
  /feature notify-test
  /feature notify-config webhook https://hooks.slack.com/...
  /feature notify-config daily-digest off
  /feature export json > backup.json
  /feature dashboard

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

  const tags = listTags(featureId);
  const notes = getNotes(featureId);
  const subagentSummary = getSubagentSummary(featureId);

  const lines: string[] = [];
  lines.push(`● ${feature.name}  (${feature.status})`);
  if (feature.branch) lines.push(`  branch: ${feature.branch}`);
  // Phase 7: parent + agents cost breakdown. The cap is against the
  // sum of the two (matches the "you've actually spent $X" intuition).
  const capLine = feature.cap_usd
    ? ` / $${feature.cap_usd.toFixed(2)} cap`
    : "";
  const parentCost = feature.total_cost_usd;
  const agentCost = feature.subagent_cost_usd;
  const totalCost = parentCost + agentCost;
  if (agentCost > 0) {
    lines.push(`  cost:    $${totalCost.toFixed(4)}${capLine}`);
    lines.push(
      `    parent: $${parentCost.toFixed(4)}  (${feature.turn_count} turns)`
    );
    lines.push(`    agents: $${agentCost.toFixed(4)}  (${subagentSummary.length} agent types)`);
  } else {
    lines.push(`  cost:    $${parentCost.toFixed(4)}${capLine}`);
  }
  const warn = capWarning({ ...feature, total_cost_usd: totalCost });
  if (warn) lines.push(warn);
  lines.push(
    `  tokens:  in ${feature.total_input} · out ${feature.total_output}` +
      ` · cache r ${feature.total_cache_read} · w ${feature.total_cache_write}`
  );
  lines.push(`  turns:   ${feature.turn_count}`);
  // Pricing confidence badge (Phase 5): flag uncertainty prominently.
  const confBadge = feature.pricing_conf === "complete"
    ? "complete"
    : `complete? (${feature.pricing_conf})`;
  lines.push(`  pricing: ${confBadge}`);
  if (tags.length > 0) {
    lines.push(`  tags:    ${tags.join(", ")}`);
  }
  if (notes.length > 0) {
    lines.push(`  notes:`);
    for (const n of notes) {
      const ts = n.created_at.replace("T", " ").slice(0, 19);
      lines.push(`    [${ts}]  ${n.body}`);
    }
  }
  if (models.length > 0) {
    lines.push(`  by model:`);
    for (const m of models) {
      lines.push(
        `    ${m.model.padEnd(28)} ${String(m.turns).padStart(3)}t  $${m.cost.toFixed(4)}` +
          `  in ${m.input_tokens} · out ${m.output_tokens}`
      );
    }
  }
  if (subagentSummary.length > 0) {
    lines.push(`  sub-agents:`);
    for (const s of subagentSummary) {
      const perRun = s.runs > 0 ? s.cost / s.runs : 0;
      lines.push(
        `    ${s.agent.padEnd(18)} ${String(s.runs).padStart(2)}\u00d7  $${s.cost.toFixed(4)}` +
          `  (avg $${perRun.toFixed(4)}/run, in ${s.input_tokens} / out ${s.output_tokens} / ${s.turns} turns)`
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
  // Pull tags for each feature in a single query, indexed by id.
  const tagRows = deps
    .getDb()
    .prepare(`SELECT feature_id, tag FROM tags ORDER BY feature_id, tag`)
    .all() as Array<{ feature_id: string; tag: string }>;
  const tagsByFeature = new Map<string, string[]>();
  for (const r of tagRows) {
    const arr = tagsByFeature.get(r.feature_id) ?? [];
    arr.push(r.tag);
    tagsByFeature.set(r.feature_id, arr);
  }
  // Compact table.
  const lines: string[] = [];
  lines.push(
    "feature".padEnd(28) +
      "status".padEnd(10) +
      "tags".padEnd(22) +
      "turns".padStart(5) +
      "  cost".padStart(11) +
      "  cap".padStart(8) +
      "  last"
  );
  lines.push("-".repeat(96));
  for (const f of features) {
    const cap = f.cap_usd ? `$${f.cap_usd.toFixed(2)}` : "-";
    const last = f.last_activity_at
      ? new Date(f.last_activity_at).toISOString().slice(0, 16).replace("T", " ")
      : "-";
    const over = f.cap_usd && f.total_cost_usd > f.cap_usd ? "!" : " ";
    const tags = tagsByFeature.get(f.id) ?? [];
    const tagsStr = tags.length === 0 ? "—" : tags.join(", ");
    const name = (f.id === "unassigned" ? "unassigned" : f.name).padEnd(28).slice(0, 28);
    lines.push(
      name +
        ` ${f.status.padEnd(9)}` +
        tagsStr.padEnd(22).slice(0, 22) +
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

async function doMerge(ctx: ExtensionContext, deps: CommandDeps, note: string): Promise<void> {
  const id = getCurrentFeatureId(ctx);
  if (!id) {
    await ctx.ui.notify("Costlens: no active feature to merge.", "warning");
    return;
  }
  const f = mergeFeature(id, note);
  deps.refreshFooter(ctx);
  await ctx.ui.notify(
    `Costlens: merged "${f.name}". Cost frozen at $${f.total_cost_usd.toFixed(4)} across ${f.turn_count} turn${f.turn_count === 1 ? "" : "s"}. ` +
      `Use /feature reopen to continue tracking on the same id.` +
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
  // Phase 6: clear the notification debounce for this feature so a
  // reopened feature can fire again as it crosses new thresholds.
  deps.onReopen?.(id);
  await ctx.ui.notify(`Costlens: reopened "${f.name}" (status: ${f.status}).`, "info");
}

async function doTag(ctx: ExtensionContext, _deps: CommandDeps, rest: string): Promise<void> {
  const id = getCurrentFeatureId(ctx);
  if (!id) {
    await ctx.ui.notify("Costlens: no active feature to tag.", "warning");
    return;
  }
  // Tokenise: first word is the subaction, rest is the tag (which may
  // contain spaces — we re-join everything after the first word).
  const trimmed = rest.trim();
  if (!trimmed) {
    await ctx.ui.notify(
      `Costlens: usage: /feature tag add|remove|list [tag]`,
      "warning"
    );
    return;
  }
  const space = trimmed.search(/\s/);
  const action = space === -1 ? trimmed : trimmed.slice(0, space);
  const tagInput = space === -1 ? "" : trimmed.slice(space + 1).trim();
  switch (action) {
    case "list": {
      const tags = listTags(id);
      if (tags.length === 0) {
        await ctx.ui.notify(`Costlens: no tags on "${id}". Add one with /feature tag add <t>.`, "info");
      } else {
        await ctx.ui.notify(`Costlens: tags on "${id}":\n  ${tags.join("\n  ")}`, "info");
      }
      return;
    }
    case "add": {
      if (!tagInput) {
        await ctx.ui.notify("Costlens: usage: /feature tag add <tag>", "warning");
        return;
      }
      const tag = addTag(id, tagInput);
      await ctx.ui.notify(`Costlens: added tag "${tag}" to "${id}".`, "info");
      return;
    }
    case "remove":
    case "rm": {
      if (!tagInput) {
        await ctx.ui.notify("Costlens: usage: /feature tag remove <tag>", "warning");
        return;
      }
      const removed = removeTag(id, tagInput);
      if (removed) {
        await ctx.ui.notify(`Costlens: removed tag "${tagInput.trim().toLowerCase()}" from "${id}".`, "info");
      } else {
        await ctx.ui.notify(`Costlens: tag "${tagInput.trim().toLowerCase()}" was not on "${id}".`, "info");
      }
      return;
    }
    default:
      await ctx.ui.notify(
        `Costlens: unknown tag action "${action}". Use add, remove, or list.`,
        "warning"
      );
  }
}

async function doNote(ctx: ExtensionContext, _deps: CommandDeps, rest: string): Promise<void> {
  const id = getCurrentFeatureId(ctx);
  if (!id) {
    await ctx.ui.notify("Costlens: no active feature to attach a note to.", "warning");
    return;
  }
  const body = rest.trim();
  if (!body) {
    await ctx.ui.notify("Costlens: usage: /feature note <text>", "warning");
    return;
  }
  attachNote(id, body);
  await ctx.ui.notify(`Costlens: note attached to "${id}".`, "info");
}

async function doSearch(ctx: ExtensionContext, _deps: CommandDeps, rest: string): Promise<void> {
  const q = rest.trim();
  if (!q) {
    await ctx.ui.notify("Costlens: usage: /feature search <query>", "warning");
    return;
  }
  const matches = searchFeatures(q);
  if (matches.length === 0) {
    await ctx.ui.notify(`Costlens: no features match "${q}".`, "info");
    return;
  }
  const lines: string[] = [];
  lines.push(
    "feature".padEnd(30) +
      "status".padEnd(10) +
      "turns".padStart(5) +
      "  cost".padStart(11) +
      "  last"
  );
  lines.push("-".repeat(72));
  for (const f of matches) {
    const last = f.last_activity_at
      ? new Date(f.last_activity_at).toISOString().slice(0, 16).replace("T", " ")
      : "-";
    lines.push(
      (f.id === "unassigned" ? "unassigned" : f.name).padEnd(30).slice(0, 30) +
        ` ${f.status.padEnd(9)}` +
        String(f.turn_count).padStart(5) +
        "  $" +
        f.total_cost_usd.toFixed(4).padStart(8) +
        "  " +
        last
    );
  }
  lines.push("");
  lines.push(`${matches.length} match${matches.length === 1 ? "" : "es"} for "${q}".`);
  await ctx.ui.notify(lines.join("\n"), "info");
}

async function doExport(ctx: ExtensionContext, _deps: CommandDeps, rest: string): Promise<void> {
  const fmt = rest.trim().toLowerCase();
  if (fmt !== "json" && fmt !== "csv") {
    await ctx.ui.notify(
      `Costlens: usage: /feature export <json|csv>\nWrites to stdout. Pipe to a file if you want to save it.`,
      "warning"
    );
    return;
  }
  if (fmt === "json") {
    const data = exportLedger();
    // Always print to stdout, regardless of UI mode — the user asked for
    // a dump, not an in-pi notification.
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }
  // CSV
  const csv = exportLedgerCsv();
  process.stdout.write(csv + "\n");
}

// ---------------------------------------------------------------------------
// Phase 6: notifications
// ---------------------------------------------------------------------------

async function doNotifyTest(ctx: ExtensionContext, _deps: CommandDeps, _rest: string): Promise<void> {
  await sendNotify(
    "Costlens test",
    `This is a test notification from costlens at ${new Date().toISOString()}. ` +
      `If you can read this, the platform notifier works.`,
    "info",
    ctx
  );
  await ctx.ui.notify("Costlens: test notification sent (in-pi + native if available).", "info");
}

async function doNotifyConfig(ctx: ExtensionContext, _deps: CommandDeps, rest: string): Promise<void> {
  const trimmed = rest.trim();
  if (!trimmed) {
    await printNotifyConfig(ctx);
    return;
  }
  // First token is the subcommand, rest is the value (for set-style commands).
  const space = trimmed.search(/\s/);
  const sub = space === -1 ? trimmed : trimmed.slice(0, space);
  const value = space === -1 ? "" : trimmed.slice(space + 1).trim();

  const cfg = readConfig();
  switch (sub) {
    case "on":
      writeConfig({ ...cfg, notifications: { ...cfg.notifications, enabled: true } });
      await ctx.ui.notify("Costlens: notifications enabled.", "info");
      return;
    case "off":
      writeConfig({ ...cfg, notifications: { ...cfg.notifications, enabled: false } });
      await ctx.ui.notify("Costlens: notifications disabled.", "info");
      return;
    case "webhook": {
      if (!value || value === "clear") {
        writeConfig({ ...cfg, notifications: { ...cfg.notifications, webhook: null } });
        await ctx.ui.notify("Costlens: webhook cleared.", "info");
        return;
      }
      // Basic sanity check: must be http(s)://
      if (!/^https?:\/\//i.test(value)) {
        await ctx.ui.notify("Costlens: webhook URL must start with http:// or https://", "warning");
        return;
      }
      writeConfig({ ...cfg, notifications: { ...cfg.notifications, webhook: value } });
      await ctx.ui.notify(`Costlens: webhook set to ${value}`, "info");
      return;
    }
    case "daily-digest":
    case "digest": {
      if (value !== "on" && value !== "off") {
        await ctx.ui.notify("Costlens: usage: /feature notify-config daily-digest on|off", "warning");
        return;
      }
      writeConfig({
        ...cfg,
        notifications: { ...cfg.notifications, dailyDigest: value === "on" },
      });
      await ctx.ui.notify(`Costlens: daily digest ${value === "on" ? "enabled" : "disabled"}.`, "info");
      return;
    }
    case "daily-threshold": {
      const n = Number(value);
      if (!value || isNaN(n) || n < 0) {
        await ctx.ui.notify("Costlens: usage: /feature notify-config daily-threshold <usd>", "warning");
        return;
      }
      writeConfig({
        ...cfg,
        notifications: { ...cfg.notifications, dailyDigestThresholdUsd: n },
      });
      await ctx.ui.notify(`Costlens: daily digest threshold set to $${n.toFixed(2)}.`, "info");
      return;
    }
    case "thresholds": {
      const parts = value.split(/[,\s]+/).filter(Boolean);
      const nums = parts.map(Number);
      if (nums.length === 0 || nums.some((n) => isNaN(n) || n <= 0 || n > 10)) {
        await ctx.ui.notify(
          `Costlens: usage: /feature notify-config thresholds <list>\n` +
            `Comma-separated ratios, each in (0, 10]. e.g. 0.5,0.8,1.0,1.1\n` +
            `Default: ${getDefaultThresholds().join(", ")}`,
          "warning"
        );
        return;
      }
      writeConfig({ ...cfg, notifications: { ...cfg.notifications, thresholds: nums } });
      await ctx.ui.notify(`Costlens: thresholds set to ${nums.join(", ")}.`, "info");
      return;
    }
    case "reset": {
      writeConfig({ ...cfg, notifications: { ...cfg.notifications, thresholds: getDefaultThresholds() } });
      await ctx.ui.notify(`Costlens: thresholds reset to defaults (${getDefaultThresholds().join(", ")}).`, "info");
      return;
    }
    default:
      await ctx.ui.notify(
        `Costlens: unknown notify-config subcommand "${sub}".\n` +
          `Try: on, off, webhook, daily-digest, daily-threshold, thresholds, reset`,
        "warning"
      );
  }
}

async function printNotifyConfig(ctx: ExtensionContext): Promise<void> {
  const cfg = readConfig();
  const n = cfg.notifications;
  const lines = [
    `Costlens notifications`,
    `  enabled:        ${n.enabled ? "yes" : "no"}`,
    `  thresholds:     ${n.thresholds.join(", ")}`,
    `  webhook:        ${n.webhook ?? "(none)"}`,
    `  daily digest:   ${n.dailyDigest ? "yes" : "no"}`,
    `  digest min $:   $${n.dailyDigestThresholdUsd.toFixed(2)}`,
  ];
  await ctx.ui.notify(lines.join("\n"), "info");
}

async function doDashboard(ctx: ExtensionContext, _deps: CommandDeps, rest: string): Promise<void> {
  const args = rest.split(/\s+/).filter(Boolean);
  const detach = args.includes("--detach");
  const stop = args.includes("stop");

  if (stop) {
    const res = await stopServer();
    if (res.stopped) {
      await ctx.ui.notify(`Costlens: server stopped (pid ${res.pid ?? "?"}).`, "info");
    } else {
      await ctx.ui.notify("Costlens: no server running.", "info");
    }
    return;
  }

  try {
    const handle = await startServer({ detach });
    const url = `http://localhost:${handle.port}/`;
    if (ctx.hasUI) {
      try {
        await openBrowser(url);
        await ctx.ui.notify(
          `Costlens: dashboard at ${url}${detach ? " (detached, pid " + handle.pid + ")" : ""}`,
          "info"
        );
      } catch {
        await ctx.ui.notify(
          `Costlens: dashboard at ${url} (couldn't open browser)${detach ? ` (detached, pid ${handle.pid})` : ""}`,
          "info"
        );
      }
    } else {
      // No UI (print/JSON mode): just print the URL.
      process.stdout.write(`costlens-dashboard: ${url}\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.ui.notify(`Costlens: failed to start dashboard — ${msg}`, "error");
  }
}

async function doOpen(ctx: ExtensionContext, _deps: CommandDeps, rest: string): Promise<void> {
  const name = rest.trim();
  if (!name) {
    await ctx.ui.notify("Costlens: usage: /feature open <feature-name-or-id>", "warning");
    return;
  }
  try {
    const handle = await startServer({ detach: false });
    const url = `http://localhost:${handle.port}/feature/${encodeURIComponent(name)}`;
    if (ctx.hasUI) {
      try {
        await openBrowser(url);
        await ctx.ui.notify(`Costlens: opened "${name}" at ${url}`, "info");
      } catch {
        await ctx.ui.notify(`Costlens: ${url} (couldn't open browser)`, "info");
      }
    } else {
      process.stdout.write(`costlens-dashboard: ${url}\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.ui.notify(`Costlens: failed to open — ${msg}`, "error");
  }
}

async function doSetPort(_ctx: ExtensionContext, _deps: CommandDeps, rest: string): Promise<void> {
  const n = Number(rest);
  if (!rest || isNaN(n) || n < 1 || n > 65535) {
    await _ctx.ui.notify("Costlens: usage: /feature set-port <1..65535>", "warning");
    return;
  }
  const current = readConfig();
  writeConfig({ ...current, port: n });
  await _ctx.ui.notify(
    `Costlens: port set to ${n} (was ${current.port}). Restart the dashboard to take effect: /feature dashboard`,
    "info"
  );
}
