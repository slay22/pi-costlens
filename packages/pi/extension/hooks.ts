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
 * Phase 7 adds `message_end` handling for `toolResult` messages:
 *   - For `Agent` tool results, read `details.results` (the subagent
 *     extension's typed payload) and insert one `subagent_runs` row per
 *     result. Idempotent on `(feature_id, parent_message_id, agent, step)`.
 *   - For all other tool results, insert a `tool_calls` row with the
 *     tool name and (best-effort) arguments size. No LLM cost; this
 *     table is for usage analytics only.
 *   - After sub-agent runs are inserted, recompute the parent feature's
 *     `subagent_cost_usd` (SUM of inserted runs). Same pattern as
 *     `total_cost_usd`.
 *
 * Idempotency matters because pi re-emits events on session reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getDb } from "./db.js";
import { computePricingConfidence } from "./pricing.js";
import {
  getCurrentFeatureId,
  getFeature,
  insertSubagentRun,
  insertToolCall,
  updateFeatureSubagentCost,
  recordMessageAndUpdateFeature,
} from "./lifecycle.js";
import { fireThresholdNotification } from "./notifications.js";

/**
 * Local copy of the `ToolResultMessage` shape from pi-ai. We don't
 * import from `@earendil-works/pi-ai` because it's not a direct
 * dependency of costlens; pi-coding-agent hoists it internally.
 */
type ToolResultMessageLike = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content?: unknown;
  details?: unknown;
  isError?: boolean;
  timestamp: number;
};

/**
 * The subagent extension's `details` payload. We declare the shape we
 * care about rather than importing the extension types — costlens
 * shouldn't take a hard dependency on the subagent extension being
 * installed. If the shape doesn't match (e.g. the extension is older
 * or absent), we no-op gracefully.
 */
type SubagentSingleResult = {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
  model?: string;
  stopReason?: string;
  step?: number;
};

type SubagentDetails = {
  mode?: "single" | "parallel" | "chain";
  results: SubagentSingleResult[];
};

function isSubagentDetails(v: unknown): v is SubagentDetails {
  if (!v || typeof v !== "object") return false;
  const r = (v as { results?: unknown }).results;
  return Array.isArray(r);
}

/**
 * Look up the assistant tool call's arguments length for a given
 * toolCallId. Walks the session entries; if the parent assistant
 * message is in the current session, we can compute the size of its
 * JSON-stringified `arguments` for analytics. Returns null if we
 * can't find it (e.g. on a session that was reloaded and the parent
 * assistant message is missing — defensive).
 */
function argsSizeForToolCall(
  ctx: ExtensionContext,
  toolCallId: string
): number | null {
  const sm = ctx.sessionManager as {
    getEntries?: () => Array<{
      type: string;
      message?: {
        role?: string;
        content?: Array<{ type?: string; id?: string; arguments?: unknown }>;
      };
    }>;
  };
  if (typeof sm.getEntries !== "function") return null;
  let entries: Array<{
    type: string;
    message?: {
      role?: string;
      content?: Array<{ type?: string; id?: string; arguments?: unknown }>;
    };
  }>;
  try {
    entries = sm.getEntries();
  } catch {
    return null;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part && part.type === "toolCall" && part.id === toolCallId) {
        try {
          return JSON.stringify(part.arguments ?? {}).length;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function registerHooks(pi: ExtensionAPI): void {
  pi.on("message_end", async (event, ctx) => {
    const db = getDb();
    const featureId = getCurrentFeatureId(ctx);
    if (!featureId) return; // no active feature; lifecycle.ts owns this

    // -----------------------------------------------------------------
    // Phase 1+6: assistant message — record LLM cost and notify.
    // -----------------------------------------------------------------
    if (event.message.role === "assistant") {
      const msg = event.message;
      if (!msg.usage) return; // safety: never seen, but be defensive

      const usage = msg.usage;
      const cost = usage.cost;
      const tokensTotal = usage.input + usage.output;
      const costUnknown = cost.total === 0 && tokensTotal > 0 ? 1 : 0;

      const messageId = ctx.sessionManager.getLeafId() ?? `synth-${msg.timestamp}`;
      const sessionFile = ctx.sessionManager.getSessionFile() ?? "ephemeral";
      const ts = new Date(msg.timestamp).toISOString();

      // Phase 9 step 2: the message-insert + feature-totals
      // recompute lives in @costlens/core's
      // `recordMessageAndUpdateFeature`. Same transaction, same
      // SQL — just consolidated into the data plane.
      //
      // Phase 9 step 4: every row written by pi is tagged with
      // source = "pi" so the dashboard can show a per-tool
      // breakdown in v1.5+. See MULTI-TOOL.md §7.
      recordMessageAndUpdateFeature({
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
        source: "pi",
      });

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
      return;
    }

    // -----------------------------------------------------------------
    // Phase 7: toolResult message — record sub-agent runs and tool calls.
    // -----------------------------------------------------------------
    if (event.message.role === "toolResult") {
      const msg = event.message as ToolResultMessageLike;
      const ts = new Date(msg.timestamp).toISOString();

      if (msg.toolName === "Agent" && isSubagentDetails(msg.details)) {
        // Sub-agent invocation: insert one row per result, then refresh
        // the parent feature's pre-computed sub-agent cost total.
        //
        // Parallel mode has N results per toolResult, all without a
        // `step` field. Without intervention they'd collide on the
        // unique key (feature_id, parent_message_id, agent, step=NULL).
        // Assign a synthetic step (the result index) for parallel mode
        // so each row has a distinct unique key — and on reload, the
        // same index maps back to the same row (idempotency works).
        const isParallel = msg.details.mode === "parallel";
        let inserted = 0;
        db.exec("BEGIN");
        try {
          for (let i = 0; i < msg.details.results.length; i++) {
            const r = msg.details.results[i];
            const step = isParallel ? i : r.step;
            if (insertSubagentRun(featureId, msg.toolCallId, { ...r, step }, ts)) inserted++;
          }
          if (inserted > 0) {
            updateFeatureSubagentCost(featureId);
          }
          db.exec("COMMIT");
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {
            // best-effort; surface original error
          }
          throw err;
        }
        return;
      }

      // Generic tool call: count it. We deliberately do NOT use the
      // Agent tool here because its cost is already attributed via
      // subagent_runs; the Agent tool itself is just the call site.
      const argsSize = argsSizeForToolCall(ctx, msg.toolCallId);
      insertToolCall(featureId, msg.toolCallId, msg.toolName, argsSize, ts);
      return;
    }
  });
}
