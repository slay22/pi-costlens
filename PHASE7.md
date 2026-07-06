# Phase 7 — Sub-agent & per-tool cost attribution

The "hard" deferred item, made tractable: the subagent extension already returns the sub-agent's full usage data in the parent's `ToolResultMessage.details`. Costlens reads it on `message_end` and attributes the sub-agent cost separately from the parent's LLM cost.

**Status:** not started. Dogfood target: branch `feat/phase-7-subagent-cost`.

---

## 1. The discovery that makes this tractable

I dug into `examples/extensions/subagent/index.ts` (in the pi source). The parent's tool result for an `Agent` invocation has this shape:

```ts
interface SingleResult {
  agent: string;                         // "Explore" | "Plan" | "general-purpose" | custom
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  usage: UsageStats;                     // ← this is what we want
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;                         // for chain mode
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: "user" | "project" | "both";
  projectAgentsDir: string | null;
  results: SingleResult[];               // 1 for single, N for parallel/chain
}
```

`SubagentDetails` is what arrives in `message.details` for the parent's `toolResult` message. So costlens can read it on `message_end` (or on `tool_result`) — no need to fork the subagent extension, no need to scan sub-agent session files, no need to estimate. The real numbers are right there.

For the modes:
- `single` — `results.length === 1`, easy
- `parallel` — `results.length === N`, all sub-agents run "in parallel" from the parent's perspective
- `chain` — `results.length === N`, ordered steps; `step` field on each result

We attribute all sub-agents to the parent's current feature.

## 2. Goals

- **Sub-agent cost attribution**: every sub-agent invocation records `(agent, model, usage, cost)` to a new `subagent_runs` table, attributed to the parent feature.
- **Per-tool invocation counts**: track all tool calls (not just `Agent`) — Read, Edit, Bash, etc. — for usage analytics. Free (no LLM cost), just counts.
- **Sub-agent dashboard view**: per-agent breakdown on the feature detail page (Explore: 12 runs / $0.50, Plan: 3 runs / $0.12, etc.).
- **Performance metrics** (bonus, nice-to-have): latency per LLM call (turn_start to message_end deltas) for the "which model is faster" question. Could be Phase 7.5 or Phase 9.

## 3. Non-goals (deferred)

- Cross-machine sync (Phase 9)
- Custom pricing overrides (v2)
- WebSocket real-time updates (v2)
- Public npm publish (Phase 8)
- Replacing the subagent extension or its UI

## 4. Architecture

```
extension/
├── hooks.ts              MODIFIED — on message_end for toolResult (Agent), read
│                                   details, insert subagent_runs. For other toolResult,
│                                   insert tool_calls.
├── lifecycle.ts          MODIFIED — getSubagentRuns(featureId), getToolCalls(featureId),
│                                   addSubagentCostToFeature(featureId)
└── commands.ts           MODIFIED — /feature status shows sub-agent breakdown
extension/db.ts            UNCHANGED — same schema, just new tables
server/
├── db.ts                 MODIFIED — subagent runs + tool calls queries
├── api.ts                MODIFIED — /api/features/:id/subagents, /api/features/:id/tools
└── web/
    ├── feature.html      MODIFIED — sub-agent section
    ├── feature.js        MODIFIED — render sub-agent breakdown
    └── style.css         MODIFIED — agent chip styling
test/
├── hooks-subagent.test.ts NEW — sub-agent insertion tests
└── lifecycle-subagent.test.ts NEW — sub-agent query tests
```

**New tables:**

```sql
CREATE TABLE subagent_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id      TEXT NOT NULL REFERENCES features(id),
  parent_message_id TEXT NOT NULL,           -- the toolResult message id
  agent           TEXT NOT NULL,             -- "Explore", "Plan", etc.
  agent_source    TEXT NOT NULL,             -- "user" | "project" | "unknown"
  model           TEXT,
  task            TEXT NOT NULL,             -- first 200 chars for context
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  cache_read      INTEGER NOT NULL,
  cache_write     INTEGER NOT NULL,
  cost_usd        REAL NOT NULL,
  turns           INTEGER NOT NULL,
  step            INTEGER,                   -- for chain mode
  exit_code       INTEGER NOT NULL,
  stop_reason     TEXT,
  timestamp       TEXT NOT NULL,
  INDEX idx_subagent_feature ON subagent_runs(feature_id)
);

CREATE TABLE tool_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id      TEXT NOT NULL REFERENCES features(id),
  message_id      TEXT NOT NULL,              -- the parent assistant message that contained the tool call
  tool_name       TEXT NOT NULL,             -- "Read", "Edit", "Bash", "Agent", etc.
  args_size       INTEGER,                   -- JSON.stringify(arguments).length, for context
  timestamp       TEXT NOT NULL,
  INDEX idx_tool_calls_feature_name ON tool_calls(feature_id, tool_name)
);
```

No changes to `features` table. `total_cost_usd` stays as parent's LLM cost only. Sub-agent cost is computed on-the-fly from `subagent_runs` (SUM cost_usd) — stored in feature's `subagent_cost_usd` for fast dashboard reads. Or computed in a query — TBD based on what the dashboard needs.

Decision: add `subagent_cost_usd REAL NOT NULL DEFAULT 0` to `features`, updated on each subagent_runs insert. Matches the existing pattern of pre-computed feature totals.

**Migration:** `schema_version` bumps to 2. Migration is `ALTER TABLE features ADD COLUMN subagent_cost_usd REAL NOT NULL DEFAULT 0`. Idempotent — only runs if the column doesn't exist.

## 5. Data flow

### On every `message_end` for assistant messages (existing)

Unchanged. Writes the assistant message's `usage` and cost to `messages` table. Updates `features.total_cost_usd` etc.

### On every `message_end` for `toolResult` messages (new)

```ts
pi.on("message_end", async (event, ctx) => {
  if (event.message.role !== "toolResult") return;
  const msg = event.message as ToolResultMessage;
  if (msg.toolName !== "Agent") {
    // Generic tool call: count it
    insertToolCall(featureId, msg.toolCallId, msg.toolName, msg);
    return;
  }
  // Agent tool: extract sub-agent runs
  const details = msg.details as SubagentDetails | undefined;
  if (!details?.results) return;
  for (const r of details.results) {
    insertSubagentRun(featureId, msg.toolCallId, r);
  }
  // Update feature.subagent_cost_usd = SUM of inserted runs
  updateFeatureSubagentCost(featureId);
});
```

### Hook placement

Same hook, different branch. `tool_result` event is also an option, but `message_end` keeps everything in one place.

## 6. Sub-agent recording logic

```ts
function insertSubagentRun(
  featureId: string,
  parentMessageId: string,
  r: SingleResult,
): void {
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT INTO subagent_runs (
      feature_id, parent_message_id, agent, agent_source, model, task,
      input_tokens, output_tokens, cache_read, cache_write, cost_usd,
      turns, step, exit_code, stop_reason, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    featureId,
    parentMessageId,
    r.agent,
    r.agentSource,
    r.model ?? null,
    r.task.slice(0, 200),
    r.usage.input,
    r.usage.output,
    r.usage.cacheRead,
    r.usage.cacheWrite,
    r.usage.cost,
    r.usage.turns,
    r.step ?? null,
    r.exitCode,
    r.stopReason ?? null,
    ts,
  );
}
```

Idempotency: use `(feature_id, parent_message_id, agent, step)` as a unique key. If the same sub-agent result is re-emitted (e.g., on session reload), it's a no-op.

```sql
CREATE UNIQUE INDEX idx_subagent_unique
  ON subagent_runs(feature_id, parent_message_id, agent, COALESCE(step, -1));
```

## 7. /feature status sub-agent section

The existing `/feature status` becomes:

```
● feat/phase-7-subagent-cost  (open)
  branch: feat/phase-7-subagent-cost
  cost:    $0.0420 / $5.00 cap
    parent:  $0.0300  (12 turns, 8.2k in / 1.1k out)
    agents:  $0.0120  (Explore: 5×$0.008, Plan: 2×$0.002)
  tokens:  in 8,200 · out 1,100 · cache r 0 · w 0
  turns:   12
  pricing: complete
  by model:
    claude-haiku-4-5   9t  $0.0240  in 7,800 · out 1,000
    minimax-m3         3t  $0.0060  in 400   · out 100

  sub-agents:
    Explore    5 runs  $0.040  (in 4.2k / out 0.8k / 12 turns total)
    Plan       2 runs  $0.080  (in 8.1k / out 1.6k / 4 turns total)
```

New sub-section: `sub-agents:` with per-agent rows.

## 8. Dashboard additions

### Feature page: sub-agent section

Below the existing "Cost by model" chart, add a new card:

```
┌─ Sub-agents ────────────────────────┐
│  Agent     Runs  Cost     Turns      │
│  Explore     5   $0.040    12        │
│  Plan        2   $0.080     4        │
│  custom      1   $0.012     3        │
│  ─────────────────────────────────  │
│  total       8   $0.132    19        │
└────────────────────────────────────┘
```

Plus a small "cost per run" bar chart (uPlot bar) showing each agent's cost-per-run average.

### Overview page: top sub-agents

Below the top-features table, add a "Top sub-agents" table:

```
Agent     Total runs  Total cost  Avg cost / run
Explore          42      $1.20     $0.029
Plan             18      $0.45     $0.025
general-purpose   5      $0.08     $0.016
```

Useful for "which agent am I using most, and what does it cost me?"

### API

| Route | Response |
|---|---|
| `GET /api/features/:id/subagents` | `SubagentRun[]` — all sub-agent runs for a feature |
| `GET /api/features/:id/tools` | `ToolCall[]` — all tool calls for a feature |
| `GET /api/subagents/top?limit=10` | Aggregated across all features: top agents by cost |

## 9. Performance metrics (optional, scope-creep risk)

Latency: `turn_end.timestamp - turn_start.timestamp` per turn. Wall time per LLM call.

Useful for "is Opus 1.5× faster than Sonnet" or "is my context getting too big".

Implementation:
- Add `latency_ms INTEGER` to a new `turn_metrics` table (or denormalize into `messages`)
- On `turn_end`, compute delta from `turn_start`, insert
- Display on dashboard

**Decision: defer to Phase 7.5 or Phase 9.** It uses the same hook pattern but the data is less actionable than sub-agent cost. Scope-creep risk. Let me know if you want it in Phase 7.

## 10. Tests

`test/hooks-subagent.test.ts` (new, node:test):
- Mock `message_end` events with `toolResult` for `Agent` tool, sub-agent details
- Verify subagent_runs has the right rows
- Verify `subagent_cost_usd` is updated
- Verify idempotency on re-emit

`test/lifecycle-subagent.test.ts` (new, node:test):
- `getSubagentRuns(featureId)` returns rows in order
- `getToolCalls(featureId)` returns counts per tool
- Migration from v1 → v2 adds the column

`bun test test/server.test.ts` (extend):
- `GET /api/features/:id/subagents` returns the right shape
- `GET /api/features/:id/tools` returns counts

## 11. Implementation order

Each step is dogfoodable.

1. **Schema migration + table** — bump `schema_version` to 2, add `subagent_cost_usd` column, create `subagent_runs` and `tool_calls` tables. `npm test` confirms migration is idempotent.
2. **Hook sub-agent recording** — `message_end` branch for `toolResult` Agent tool, extract `details.results`, insert rows. Verify by running pi with a sub-agent and inspecting the DB.
3. **Hook tool call recording** — `message_end` branch for `toolResult` non-Agent tools, count them. Verify with Read/Edit/Bash.
4. **`/feature status` sub-agent section** — format the new breakdown. Verify visually.
5. **Server queries** — `getSubagentRuns`, `getToolCalls`, plus the aggregation for top agents. Test in `bun test`.
6. **Dashboard UI** — feature page sub-agent section, overview top-agents table. Test with real data.
7. **API endpoints** — `/api/features/:id/subagents`, `/api/features/:id/tools`, `/api/subagents/top`. Test in `bun test`.
8. **Optional: performance metrics** — only if you want it.

## 12. Decisions worth flagging

1. **Sub-agent cost is separate from parent cost.** `features.total_cost_usd` stays as parent's LLM cost only. `features.subagent_cost_usd` is new. The cap is against the sum (configurable).
2. **We trust the subagent extension's `details.results[].usage.cost`.** No re-computation. The extension already gave us the right numbers.
3. **Idempotency on re-emit.** Sessions can be reloaded; the same sub-agent result might be re-emitted. Unique index `(feature_id, parent_message_id, agent, COALESCE(step, -1))` makes the insert a no-op.
4. **No `messages` schema change.** Sub-agent runs go in their own table. The parent's `messages` table stays clean.
5. **Per-tool counts but no cost** (except Agent). Read/Edit/Bash don't burn LLM tokens, so no cost. Just counts for analytics.
6. **No UI for closing/archiving individual sub-agent runs.** They're data points. The dashboard aggregates them.
7. **Performance metrics deferred.** Same hook pattern but less actionable. Keep Phase 7 focused on sub-agent + per-tool.

## 13. Dogfooding plan

You're on `feat/phase-7-subagent-cost` (newly created from `main` at v0.6.0).

- Set a tight cap: `/feature set-cap 0.50` — visible feedback as the agent's parent + sub-agents burn through it
- Step 2 is the most testable: trigger an `Explore` sub-agent from a pi turn, watch the costlens DB populate
- Step 4: `/feature status` should show the sub-agent breakdown
- Step 6: dashboard feature page should have the sub-agent card
- Close: `/feature close subagent shipped` (or similar)

## 14. Rollback

Phase 7 is additive. The schema migration is forward-only (adds a column with a default), but never destructive. To roll back:
- Don't run the migration (don't install the new extension)
- Or: `ALTER TABLE features DROP COLUMN subagent_cost_usd` (SQLite 3.35+, may not be available)
- Or: just stop using `/feature status`'s sub-agent section; the data is harmless

The new tables (`subagent_runs`, `tool_calls`) can be dropped without affecting the rest of costlens.
