/**
 * Pure helpers for the costlens CLI — no IO, no DB, no clock.
 * Kept separate from `index.ts` so the money-mapping (ccusage → ledger
 * rows) and the session picker are unit-testable without a SQLite file
 * or a live `ccusage` run.
 */

import type { MessageInsert, Feature } from "@costlens/core";

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

/** Shape a feature row + its grouped sums into the CLI's stable report object. */
export function shapeFeatureReport(
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
