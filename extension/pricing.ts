/**
 * Pricing confidence.
 *
 * Pi gives us a pre-calculated `usage.cost` on every assistant message. If
 * a model has no pricing in pi's table, that cost will be $0 even though
 * tokens were consumed. We surface this as a per-feature confidence:
 *
 *   - "complete"  every message in the feature has cost > 0
 *   - "partial"   some messages have cost = 0
 *   - "unknown"   every message has cost = 0
 */

import type { DatabaseSync } from "node:sqlite";

export type PricingConfidence = "complete" | "partial" | "unknown";

export function computePricingConfidence(
  db: DatabaseSync,
  featureId: string
): PricingConfidence {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN cost_unknown = 1 THEN 1 ELSE 0 END) AS unknown_count,
         SUM(CASE WHEN cost_usd > 0 THEN 1 ELSE 0 END) AS priced_count
       FROM messages
       WHERE feature_id = ?`
    )
    .get(featureId) as { total: number; unknown_count: number; priced_count: number };

  if (row.total === 0) return "unknown";
  if (row.unknown_count === 0) return "complete";
  if (row.priced_count === 0) return "unknown";
  return "partial";
}
