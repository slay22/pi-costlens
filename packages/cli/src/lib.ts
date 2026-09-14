/**
 * Pure helpers for the costlens CLI — no IO, no DB, no clock.
 * Kept separate from `index.ts` so the money-mapping (ccusage → ledger
 * rows) and the session picker are unit-testable without a SQLite file
 * or a live `ccusage` run.
 */

import type { CoreDatabase, MessageInsert, Feature } from "@costlens/core";
import { UNASSIGNED_ID, recomputeFeatureTotals } from "@costlens/core";

/** Default `source` tag for ingested rows (Claude Code). ccusage on this
 *  machine is a multi-agent reader (claude, codex, gemini, …), so the source
 *  is passed per-ingest; this is only the fallback. */
export const SOURCE_CLAUDE = "claude-code";

/** Minimal shape of a `ccusage session --json` entry (only the fields we read). */
export type CcusageSession = {
  period?: string;
  totalCost?: number;
  totalTokens?: number;
  modelsUsed?: string[];
  modelBreakdowns?: Array<{
    modelName?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    cost?: number;
  }>;
  metadata?: { lastActivity?: string };
};

/**
 * Pick a ccusage session by uuid substring on `period`, else the most
 * recently active. Same rule as `wi`'s picker: in one-session-per-feature
 * mode the newest session ≈ the feature you just finished, but callers
 * should always pass an explicit id.
 */
export function pickCcusageSession(
  sessions: CcusageSession[] | undefined,
  sessionId?: string
): CcusageSession | null {
  if (!sessions?.length) return null;
  if (sessionId) return sessions.find((s) => String(s.period ?? "").includes(sessionId)) ?? null;
  return (
    [...sessions].sort((a, b) =>
      String(b.metadata?.lastActivity ?? "").localeCompare(String(a.metadata?.lastActivity ?? ""))
    )[0] ?? null
  );
}

/**
 * Turn one ccusage session into `messages` rows — one per model in the
 * session. The id is deterministic (`ccusage:<session>:<model>`) so a
 * re-ingest is an INSERT OR REPLACE, never a double-count.
 *
 * ccusage reports only a single total `cost` per model (no input/output
 * split), so `cost_usd` carries it and the per-bucket cost columns stay 0
 * (dashboard detail only; feature totals sum `cost_usd`). `cost_unknown`
 * flags the pi-style case where tokens were spent but ccusage priced it
 * at $0 (model absent from its pricing table).
 */
export function ccusageSessionToInserts(
  sess: CcusageSession,
  featureId: string,
  now: string,
  source: string = SOURCE_CLAUDE
): MessageInsert[] {
  const period = String(sess.period ?? "unknown");
  const ts = sess.metadata?.lastActivity ?? now;
  const breakdowns =
    sess.modelBreakdowns && sess.modelBreakdowns.length
      ? sess.modelBreakdowns
      : [
          {
            modelName: (sess.modelsUsed ?? [])[0] ?? "unknown",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            cost: sess.totalCost ?? 0,
          },
        ];
  return breakdowns.map((b) => {
    const input = b.inputTokens ?? 0;
    const output = b.outputTokens ?? 0;
    const cacheRead = b.cacheReadTokens ?? 0;
    const cacheWrite = b.cacheCreationTokens ?? 0;
    const cost = b.cost ?? 0;
    const model = String(b.modelName ?? "unknown");
    const tokensSpent = input + output + cacheRead + cacheWrite;
    return {
      id: `ccusage:${period}:${model}`,
      feature_id: featureId,
      session_id: period,
      model,
      provider: source,
      input_tokens: input,
      output_tokens: output,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      cost_usd: cost,
      cost_input: 0,
      cost_output: 0,
      cost_cache_read: 0,
      cost_cache_write: 0,
      cost_unknown: cost === 0 && tokensSpent > 0 ? 1 : 0,
      timestamp: ts,
      branch_path: null,
      source,
    };
  });
}

export type FeatureReport = {
  feature: string;
  found: boolean;
  status: string | null;
  cost: number;
  capUsd: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  turns: number;
  byModel: Array<{ model: string; cost: number; turns: number }>;
  bySource: Array<{ source: string; cost: number; turns: number }>;
};

/** Shape a feature row + its grouped sums into the CLI's stable report object. */export function shapeFeatureReport(
  branch: string,
  feature: Feature | undefined,
  byModel: Array<{ model: string; cost: number; turns: number }>,
  bySource: Array<{ source: string; cost: number; turns: number }>
): FeatureReport {
  return {
    feature: branch,
    found: !!feature,
    status: feature?.status ?? null,
    cost: feature?.total_cost_usd ?? 0,
    capUsd: feature?.cap_usd ?? null,
    tokens: {
      input: feature?.total_input ?? 0,
      output: feature?.total_output ?? 0,
      cacheRead: feature?.total_cache_read ?? 0,
      cacheWrite: feature?.total_cache_write ?? 0,
    },
    turns: feature?.turn_count ?? 0,
    byModel,
    bySource,
  };
}

// ---------------------------------------------------------------------------
// claim — re-attribute a project's sessions to a named feature
// ---------------------------------------------------------------------------

/**
 * Create the feature row if it's missing — regardless of status, so cost
 * stamped AFTER a merge/close still books to the right feature (we must
 * NOT route to `unassigned` the way ensureFeatureForSession does for
 * closed features). Existing rows are left untouched.
 */
export function ensureFeatureRow(db: CoreDatabase, id: string, branch: string | null): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO features
       (id, name, branch, status, pricing_conf, started_at, first_activity_at, last_activity_at)
     VALUES (?, ?, ?, 'open', 'unknown', ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(id, id, branch, now, now, now);
}

export type ClaimOptions = {
  /** Working directory whose sessions should be re-attributed (absolute). */
  cwd: string;
  /** Feature id the sessions are claimed into. */
  feature: string;
  /** Only rows currently booked here are moved. Default: `unassigned`. */
  from?: string;
  /** Compute and report, write nothing. */
  dryRun?: boolean;
};

export type ClaimSummary = {
  applied: boolean;
  cwd: string;
  feature: string;
  from: string;
  sessions: number;
  messages: number;
  costUsd: number;
  subagentRuns: number;
  toolCalls: number;
  /** Target feature cost/turns after the claim (projected when dry-run). */
  target: { costUsd: number; turns: number };
  /** Source feature cost/turns after the claim (projected when dry-run). */
  source: { costUsd: number; turns: number };
};

/** `/a/b/` → `/a/b`; `/` stays `/`. */
function normalizeCwd(p: string): string {
  return p.replace(/\/+$/, "") || "/";
}

function featureTotals(db: CoreDatabase, id: string): { costUsd: number; turns: number } {
  const row = db
    .prepare(`SELECT total_cost_usd AS cost, turn_count AS turns FROM features WHERE id = ?`)
    .get(id) as { cost: number; turns: number } | undefined;
  return { costUsd: row?.cost ?? 0, turns: Number(row?.turns ?? 0) };
}

/**
 * Move every session that ran in `cwd` (or below it — worktrees
 * included) from the `from` feature onto `feature`, and repair both
 * features' denormalized totals.
 *
 * Rows in `sessions` / `messages` are matched by directory; the
 * feature-owned `subagent_runs` and `tool_calls` rows follow their
 * parent message. Idempotent: re-running moves nothing the second
 * time, and it never touches rows already on a named feature (unless
 * `--from` says otherwise).
 */
export function claimLedger(db: CoreDatabase, opts: ClaimOptions): ClaimSummary {
  const from = opts.from ?? UNASSIGNED_ID;
  const cwd = normalizeCwd(opts.cwd);
  const prefix = cwd === "/" ? "/%" : cwd + "/%";
  const scope = `(cwd = ? OR cwd LIKE ?)`;
  const inScope = `session_id IN (SELECT id FROM sessions WHERE ${scope})`;

  const sessions = Number(
    (db.prepare(`SELECT COUNT(*) AS c FROM sessions WHERE ${scope}`).get(cwd, prefix) as {
      c: number;
    }).c
  );
  const moved = db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(cost_usd), 0) AS cost
         FROM messages WHERE feature_id = ? AND ${inScope}`
    )
    .get(from, cwd, prefix) as { c: number; cost: number };
  const subagentRuns = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM subagent_runs
            WHERE feature_id = ? AND parent_message_id IN (
              SELECT id FROM messages WHERE feature_id = ? AND ${inScope})`
        )
        .get(from, from, cwd, prefix) as { c: number }
    ).c
  );
  const toolCalls = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM tool_calls
            WHERE feature_id = ? AND message_id IN (
              SELECT id FROM messages WHERE feature_id = ? AND ${inScope})`
        )
        .get(from, from, cwd, prefix) as { c: number }
    ).c
  );

  const movedMessages = Number(moved.c);
  const movedCost = Number(moved.cost ?? 0);
  const beforeTarget = featureTotals(db, opts.feature);
  const beforeSource = featureTotals(db, from);

  const summary: ClaimSummary = {
    applied: false,
    cwd,
    feature: opts.feature,
    from,
    sessions,
    messages: movedMessages,
    costUsd: movedCost,
    subagentRuns,
    toolCalls,
    target: beforeTarget,
    source: beforeSource,
  };

  if (opts.dryRun) {
    // Preview only: project the totals instead of writing them.
    summary.target = {
      costUsd: beforeTarget.costUsd + movedCost,
      turns: beforeTarget.turns + movedMessages,
    };
    summary.source = {
      costUsd: Math.max(0, beforeSource.costUsd - movedCost),
      turns: Math.max(0, beforeSource.turns - movedMessages),
    };
    return summary;
  }

  db.exec("BEGIN");
  try {
    ensureFeatureRow(db, opts.feature, null);
    // Children first, while their parent messages still sit on `from`.
    db.prepare(
      `UPDATE subagent_runs SET feature_id = ?
        WHERE feature_id = ? AND parent_message_id IN (
          SELECT id FROM messages WHERE feature_id = ? AND ${inScope})`
    ).run(opts.feature, from, from, cwd, prefix);
    db.prepare(
      `UPDATE tool_calls SET feature_id = ?
        WHERE feature_id = ? AND message_id IN (
          SELECT id FROM messages WHERE feature_id = ? AND ${inScope})`
    ).run(opts.feature, from, from, cwd, prefix);
    db.prepare(
      `UPDATE messages SET feature_id = ? WHERE feature_id = ? AND ${inScope}`
    ).run(opts.feature, from, cwd, prefix);
    db.prepare(`UPDATE sessions SET feature_id = ? WHERE ${scope}`).run(
      opts.feature,
      cwd,
      prefix
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // best-effort
    }
    throw err;
  }

  // Totals are caches of the messages table — repair both sides from it.
  recomputeFeatureTotals(opts.feature, db);
  recomputeFeatureTotals(from, db);

  summary.applied = true;
  summary.target = featureTotals(db, opts.feature);
  summary.source = featureTotals(db, from);
  return summary;
}
