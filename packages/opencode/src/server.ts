/**
 * opencode-costlens — server plugin.
 *
 * Capture hook: on every completed assistant message, write a
 * `messages` row to the costlens SQLite ledger with source="opencode".
 * Same DB, same schema as the pi adapter — the dashboard reflects
 * both tools in a unified view.
 *
 * v1.0 scope (MULTI-TOOL.md §9):
 *   ✓ Capture: message.updated → messages row
 *   ✓ Session → feature mapping (git branch, auto-create)
 *   ✗ Notifications (v1.5)
 *   ✗ Tags/notes/commands (v1.6)
 *   ✗ Close/cancel/merge (v1.7)
 *   ✗ Sub-agent attribution (v1.8)
 *
 * opencode plugin API (sst/opencode, packages/plugin):
 *   Plugin = async (input: PluginInput) => ({ event, dispose })
 *   event.type "message.updated" fires on every stream chunk;
 *   only process when info.time?.completed is set (the final state).
 *
 * See MULTI-TOOL.md §14 for known risks / open questions.
 */

import { initDb, closeDb } from "./db.js";
import { detectGitContext } from "./git.js";
import {
  ensureFeatureForSession,
  setActiveFeature,
  getSessionFeatureId,
  recordMessageAndUpdateFeature,
  computePricingConfidence,
  getCoreDb,
} from "@costlens/core";

// ---------------------------------------------------------------------------
// Minimal opencode type stubs.
// These mirror the shapes from sst/opencode/packages/plugin/src/index.ts
// and sst/opencode/packages/sdk/js/src/v2/gen/types.gen.ts.
// TODO: replace with `import type { Plugin } from "@opencode-ai/plugin"` once
// a stable published version exists.
// ---------------------------------------------------------------------------

type PluginInput = {
  /** Absolute path to the project root. Used as the git CWD. */
  directory: string;
  /** Bun shell helper — available but not used by costlens in v1.0. */
  $?: unknown;
  /** opencode REST client — available but not used in v1.0 capture path. */
  client?: unknown;
};

/**
 * AssistantMessage shape from opencode's generated types.
 * Only the fields costlens cares about are listed.
 *
 * Exact field names verified against:
 *   sst/opencode packages/sdk/js/src/v2/gen/types.gen.ts (2026-07-08)
 */
type OcAssistantMessage = {
  id: string;
  role: "assistant";
  /** Model identifier, e.g. "anthropic/claude-sonnet-4-5". */
  model?: string;
  modelID?: string; // some versions use this field instead
  /** Total cost in USD for this message. */
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  /** Timing — `completed` is set once the message is done streaming. */
  time?: { completed?: number };
};

type OcEvent =
  | { type: "session.created"; properties: { sessionID: string } }
  | { type: "message.updated"; properties: { sessionID: string; info: OcAssistantMessage | { role: string } } }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.deleted"; properties: { sessionID: string } }
  | { type: string; properties: unknown };

type PluginHooks = {
  event?: (input: { event: OcEvent }) => void | Promise<void>;
  dispose?: () => void | Promise<void>;
};

type Plugin = (input: PluginInput, options?: unknown) => Promise<PluginHooks>;

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

/**
 * The opencode server plugin. Loaded as `opencode-costlens/server`.
 *
 * Usage in ~/.config/opencode/opencode.json (or per-project
 * .opencode/opencode.json):
 * ```json
 * { "plugin": ["opencode-costlens"] }
 * ```
 */
export const Costlens: Plugin = async (input) => {
  initDb();

  // The project directory is shared across all sessions in this
  // opencode instance. For v1.0, all sessions use the same cwd for
  // git detection. A future version would use per-session cwd from
  // the session.created payload.
  const cwd = input.directory;

  return {
    event: async ({ event }) => {
      switch (event.type) {
        // -----------------------------------------------------------------
        // Session start: create or resume a feature for the git branch.
        // v1.0: auto-create (no Y/n prompt — opencode has no confirm()
        // dialog equivalent). The prompt is always "yes".
        // -----------------------------------------------------------------
        case "session.created": {
          const { sessionID } = event.properties as { sessionID: string };
          const git = await detectGitContext(cwd);
          const featureId = await ensureFeatureForSession(
            { cwd, sessionFile: sessionID, git },
            async () => true // auto-create for opencode v1.0
          );
          setActiveFeature(featureId, git);
          break;
        }

        // -----------------------------------------------------------------
        // Message done: insert a messages row. Only process the final
        // state (time.completed is set). The event fires on every
        // streaming chunk, so idempotency via INSERT OR REPLACE is
        // important.
        // -----------------------------------------------------------------
        case "message.updated": {
          const { sessionID, info } = event.properties as {
            sessionID: string;
            info: OcAssistantMessage | { role: string };
          };
          if (info.role !== "assistant") break;
          const m = info as OcAssistantMessage;
          // Skip intermediate streaming chunks — only process the
          // completed message.
          if (!m.time?.completed) break;

          const featureId = getSessionFeatureId(sessionID);
          if (!featureId) break;

          const cost = m.cost ?? 0;
          const tokens = m.tokens ?? {};
          const inputTokens = tokens.input ?? 0;
          const outputTokens = tokens.output ?? 0;
          const cacheRead = tokens.cache?.read ?? 0;
          const cacheWrite = tokens.cache?.write ?? 0;
          const costUnknown = cost === 0 && inputTokens + outputTokens > 0 ? 1 : 0;
          // Prefer `model` over `modelID`; strip the provider prefix
          // (e.g. "anthropic/claude-sonnet-4-5" → "claude-sonnet-4-5")
          // so the model names in the dashboard are readable.
          const modelRaw = m.model ?? m.modelID ?? "unknown";
          const model = modelRaw.includes("/") ? modelRaw.split("/").pop()! : modelRaw;
          const provider = modelRaw.includes("/") ? modelRaw.split("/")[0] : "opencode";
          const ts = new Date(m.time.completed).toISOString();
          const messageId = m.id ?? `${sessionID}-${m.time.completed}`;

          recordMessageAndUpdateFeature({
            id: messageId,
            feature_id: featureId,
            session_id: sessionID,
            model,
            provider,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read: cacheRead,
            cache_write: cacheWrite,
            cost_usd: cost,
            cost_input: 0, // opencode v1 gives total cost only; breakdown in v1.5
            cost_output: 0,
            cost_cache_read: 0,
            cost_cache_write: 0,
            cost_unknown: costUnknown,
            timestamp: ts,
            branch_path: null,
            source: "opencode",
          });

          // Recompute pricing confidence outside the write transaction.
          const db = getCoreDb();
          const conf = computePricingConfidence(db, featureId);
          db.prepare(`UPDATE features SET pricing_conf = ? WHERE id = ?`).run(conf, featureId);
          break;
        }

        // session.idle = turn end (assistant finished, user can type)
        // session.deleted = session shutdown
        // Both are no-ops in v1.0 server plugin; the TUI plugin handles
        // footer refresh on idle, and dispose() closes the DB.
        default:
          break;
      }
    },

    dispose: () => {
      closeDb();
    },
  };
};

export default Costlens;
