/**
 * pi event hooks.
 *
 * Phase 1 captures one event: `message_end` for assistant messages.
 * On each call we:
 *   1. Insert/update the message row (idempotent on `id`).
 *   2. Recompute the parent feature's totals from the messages table.
 *   3. Recompute the feature's pricing_confidence.
 *   4. (Phase 6) Check the new total against cap thresholds and fire
 *      a notification + webhook for any that were just crossed.
 *
 * Idempotency matters because pi re-emits events on session reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDb } from "./db.js";
import { computePricingConfidence } from "./pricing.js";
import { getCurrentFeatureId, getFeature } from "./lifecycle.js";
import { fireThresholdNotification } from "./notifications.js";

export function registerHooks(pi: ExtensionAPI): void {
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const msg = event.message;
    if (!msg.usage) return; // safety: never seen, but be defensive

    const db = getDb();
    const featureId = getCurrentFeatureId(ctx);
    if (!featureId) return; // no active feature; lifecycle.ts owns this

    const usage = msg.usage;
    const cost = usage.cost;
    const tokensTotal = usage.input + usage.output;
    const costUnknown = cost.total === 0 && tokensTotal > 0 ? 1 : 0;

    const messageId = ctx.sessionManager.getLeafId() ?? `synth-${msg.timestamp}`;
    const sessionFile = ctx.sessionManager.getSessionFile() ?? "ephemeral";
    const ts = new Date(msg.timestamp).toISOString();

    const insertMessage = db.prepare(`
      INSERT OR REPLACE INTO messages (
        id, feature_id, session_id, model, provider,
        input_tokens, output_tokens, cache_read, cache_write,
        cost_usd, cost_input, cost_output, cost_cache_read, cost_cache_write,
        cost_unknown, timestamp, branch_path
      ) VALUES (
        @id, @feature_id, @session_id, @model, @provider,
        @input_tokens, @output_tokens, @cache_read, @cache_write,
        @cost_usd, @cost_input, @cost_output, @cost_cache_read, @cost_cache_write,
        @cost_unknown, @timestamp, @branch_path
      )
    `);

    const updateFeatureTotals = db.prepare(`
      UPDATE features
      SET
        total_cost_usd    = COALESCE((SELECT SUM(cost_usd)        FROM messages WHERE feature_id = @fid), 0),
        total_input       = COALESCE((SELECT SUM(input_tokens)    FROM messages WHERE feature_id = @fid), 0),
        total_output      = COALESCE((SELECT SUM(output_tokens)   FROM messages WHERE feature_id = @fid), 0),
        total_cache_read  = COALESCE((SELECT SUM(cache_read)      FROM messages WHERE feature_id = @fid), 0),
        total_cache_write = COALESCE((SELECT SUM(cache_write)     FROM messages WHERE feature_id = @fid), 0),
        turn_count        = COALESCE((SELECT COUNT(*)             FROM messages WHERE feature_id = @fid), 0),
        first_activity_at = COALESCE(first_activity_at, @ts),
        last_activity_at  = @ts
      WHERE id = @fid
    `);

    // node:sqlite has no `db.transaction()` helper — wrap manually.
    db.exec("BEGIN");
    try {
      insertMessage.run({
        id: messageId,
        feature_id: featureId,
        session_id: sessionFile,
        model: msg.model,
        provider: msg.provider,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read: usage.cacheRead,
        cache_write: usage.cacheWrite,
        cost_usd: cost.total,
        cost_input: cost.input,
        cost_output: cost.output,
        cost_cache_read: cost.cacheRead,
        cost_cache_write: cost.cacheWrite,
        cost_unknown: costUnknown,
        timestamp: ts,
        branch_path: null,
      });
      updateFeatureTotals.run({ fid: featureId, ts });
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best-effort; surface original error
      }
      throw err;
    }

    // Confidence is derived; recompute outside the write transaction
    // (it's a small read, doesn't need to block the write).
    const conf = computePricingConfidence(db, featureId);
    db.prepare(`UPDATE features SET pricing_conf = ? WHERE id = ?`).run(conf, featureId);

    // Phase 6: threshold notifications. The feature is read fresh from
    // the DB (its totals just got updated) and only fires if it has a
    // cap set. Debounce lives inside `fireThresholdNotification`; this
    // call is safe to make on every message_end.
    const updated = getFeature(featureId);
    if (updated && updated.cap_usd != null && updated.cap_usd > 0) {
      fireThresholdNotification(updated, updated.total_cost_usd, updated.cap_usd, ctx);
    }
  });
}
