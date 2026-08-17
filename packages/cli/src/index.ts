#!/usr/bin/env bun
/**
 * costlens — standalone CLI over the shared @costlens/core ledger.
 *
 *   costlens feature <branch> [--json]
 *       Per-feature (git-branch) cost report. `--json` for machines
 *       (this is what `wi cost` calls); human summary otherwise.
 *
 *   costlens ingest-ccusage --feature <branch> --session <uuid> [--source <tag>] [--dry-run]
 *       Batch-ingest one ccusage session into the ledger, booked to the
 *       given feature branch. ccusage here is a multi-agent reader, so
 *       --source tags the rows (claude-code default; codex, gemini, …).
 *       Idempotent — re-running replaces, never double-counts. This is how
 *       cost for agents without a live costlens adapter lands in the
 *       unified ledger (the live watchers stay costlens v2).
 *
 * pi and opencode need no ingest — their adapters write live.
 */

import {
  getFeature,
  getCoreDb,
  recordMessageAndUpdateFeature,
  featureIdFor,
} from "@costlens/core";
import { initDb, closeDb } from "./db.ts";
import {
  pickCcusageSession,
  ccusageSessionToInserts,
  shapeFeatureReport,
  SOURCE_CLAUDE,
  type CcusageSession,
} from "./lib.ts";

function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      flags[key] = next === undefined || next.startsWith("--") ? "true" : argv[++i];
    } else positional.push(argv[i]);
  }
  return { positional, flags };
}

/** Resolve a raw branch name to its feature id (main/develop/… → unassigned). */
function idFor(branch: string): string {
  return featureIdFor({ isRepo: true, branch, isMainBranch: false });
}

function cmdFeature(branch: string, flags: Record<string, string>) {
  if (!branch) throw new Error("usage: costlens feature <branch> [--json]");
  initDb();
  const id = idFor(branch);
  const feature = getFeature(id);
  const db = getCoreDb();
  const byModel = (
    db
      .prepare(
        `SELECT model, SUM(cost_usd) AS cost, COUNT(*) AS turns
           FROM messages WHERE feature_id = ? GROUP BY model ORDER BY cost DESC`
      )
      .all(id) as Array<{ model: string; cost: number; turns: number }>
  ).map((r) => ({ model: r.model, cost: r.cost ?? 0, turns: Number(r.turns) }));
  const bySource = (
    db
      .prepare(
        `SELECT source, SUM(cost_usd) AS cost, COUNT(*) AS turns
           FROM messages WHERE feature_id = ? GROUP BY source ORDER BY cost DESC`
      )
      .all(id) as Array<{ source: string; cost: number; turns: number }>
  ).map((r) => ({ source: r.source, cost: r.cost ?? 0, turns: Number(r.turns) }));

  const report = shapeFeatureReport(id, feature, byModel, bySource);

  if ("json" in flags) {
    console.log(JSON.stringify(report));
    return;
  }
  if (!report.found) {
    console.log(`${id}: no cost recorded in the ledger.`);
    return;
  }
  const usd = report.cost.toFixed(2);
  const cap = report.capUsd != null ? ` / cap $${report.capUsd.toFixed(2)}` : "";
  console.log(`${id}  [${report.status}]  $${usd}${cap} · ${report.turns} turns`);
  console.log(
    `  tokens: in ${report.tokens.input.toLocaleString("en-US")} · out ${report.tokens.output.toLocaleString(
      "en-US"
    )} · cache r/w ${report.tokens.cacheRead.toLocaleString("en-US")}/${report.tokens.cacheWrite.toLocaleString("en-US")}`
  );
  for (const m of report.byModel) console.log(`  · ${m.model}: $${m.cost.toFixed(2)} (${m.turns})`);
  if (report.bySource.length > 1)
    console.log(`  sources: ${report.bySource.map((s) => `${s.source} $${s.cost.toFixed(2)}`).join(" · ")}`);
}

/** Create the feature row if it's missing — regardless of status, so cost
 *  stamped AFTER a merge/close still books to the right feature (we must
 *  NOT route to `unassigned` the way ensureFeatureForSession does for
 *  closed features). Existing rows are left untouched. */
function ensureFeatureRow(id: string, branch: string) {
  const db = getCoreDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO features
       (id, name, branch, status, pricing_conf, started_at, first_activity_at, last_activity_at)
     VALUES (?, ?, ?, 'open', 'unknown', ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(id, id, branch, now, now, now);
}

function cmdIngestCcusage(flags: Record<string, string>) {
  const branch = flags.feature;
  const session = flags.session;
  const source = flags.source ?? SOURCE_CLAUDE; // e.g. claude-code, codex, gemini
  if (!branch || !session)
    throw new Error(
      "usage: costlens ingest-ccusage --feature <branch> --session <uuid> [--source <tag>] [--dry-run]"
    );

  const proc = Bun.spawnSync(["npx", "-y", "ccusage@latest", "session", "--json"]);
  if (proc.exitCode !== 0)
    throw new Error(`ccusage failed (is npx available?): ${proc.stderr.toString().trim()}`);
  const data = JSON.parse(proc.stdout.toString());
  const sess = pickCcusageSession(data.session as CcusageSession[], session);
  if (!sess) throw new Error(`no ccusage session matching ${session}`);

  const id = idFor(branch);
  const now = new Date().toISOString();
  const rows = ccusageSessionToInserts(sess, id, now, source);
  const total = rows.reduce((a, r) => a + r.cost_usd, 0);
  const models = rows.map((r) => r.model).join(", ");

  if ("dry-run" in flags) {
    console.log(`(dry-run) would book $${total.toFixed(2)} to ${id} · ${rows.length} row(s) · ${source} · ${models}`);
    return;
  }
  initDb();
  ensureFeatureRow(id, branch);
  for (const r of rows) recordMessageAndUpdateFeature(r);
  console.log(`ingested ccusage session → ${id}: $${total.toFixed(2)} · ${source} · ${models}`);
}

const HELP = `costlens — per-feature (git-branch) cost from the shared ledger
  costlens feature <branch> [--json]
  costlens ingest-ccusage --feature <branch> --session <uuid> [--source <tag>] [--dry-run]`;

function main() {
  const { positional, flags } = parse(process.argv.slice(2));
  const [cmd, a] = positional;
  try {
    switch (cmd) {
      case "feature":
        return cmdFeature(a, flags);
      case "ingest-ccusage":
        return cmdIngestCcusage(flags);
      case undefined:
      case "help":
      case "--help":
        return console.log(HELP);
      default:
        console.error(`unknown command: ${cmd}\n\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    closeDb();
  }
}

main();
