/**
 * Tests for `costlens claim` — re-attributing a project's sessions from
 * the global `unassigned` pool onto a named feature.
 *
 * The ledger's `messages` table is the source of truth; `features` holds
 * caches of it. A claim therefore has to move the rows *and* repair both
 * sides' caches, or the dashboard would show a total that no longer
 * matches the messages it summarises. These tests pin that down:
 *
 *   - rows in scope move (messages, sessions, sub-agent runs, tool calls);
 *   - rows outside the scope never move (other cwd, other source feature);
 *   - totals on both features are recomputed from `messages`, not guessed;
 *   - `--dry-run` writes nothing but projects the same numbers;
 *   - re-running is a no-op (idempotent).
 */

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  applySchema,
  setCoreDb,
  recordMessageAndUpdateFeature,
  type CoreDatabase,
  type MessageInsert,
} from "@costlens/core";
import { claimLedger, ensureFeatureRow } from "./lib.ts";

const APP = "/Users/leo/Develop/receiptScanner";
const OTHER = "/Users/leo/Develop/wopr";
const FEATURE = "receipt-ledger";

let db: Database;

function freshLedger(): Database {
  const d = new Database(":memory:");
  d.exec("PRAGMA foreign_keys = ON");
  applySchema(d as unknown as CoreDatabase);
  setCoreDb(d as unknown as CoreDatabase);
  ensureFeatureRow(d as unknown as CoreDatabase, "unassigned", null);
  return d;
}

function addSession(id: string, cwd: string, featureId = "unassigned"): void {
  db.prepare(
    `INSERT INTO sessions (id, feature_id, cwd, started_at, last_seen) VALUES (?, ?, ?, ?, ?)`
  ).run(id, featureId, cwd, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
}

function addMessage(
  id: string,
  sessionId: string,
  cost: number,
  ts: string,
  featureId = "unassigned"
): void {
  const row: MessageInsert = {
    id,
    feature_id: featureId,
    session_id: sessionId,
    model: "deepseek-v4.1-flash",
    provider: "opencode-go",
    input_tokens: 10,
    output_tokens: 5,
    cache_read: 0,
    cache_write: 0,
    cost_usd: cost,
    cost_input: 0,
    cost_output: 0,
    cost_cache_read: 0,
    cost_cache_write: 0,
    cost_unknown: 0,
    timestamp: ts,
    branch_path: null,
    source: "pi",
  };
  recordMessageAndUpdateFeature(row);
}

function addSubagent(featureId: string, parentMessageId: string, cost: number): void {
  db.prepare(
    `INSERT INTO subagent_runs
       (feature_id, parent_message_id, agent, agent_source, task, input_tokens, output_tokens,
        cache_read, cache_write, cost_usd, turns, exit_code, timestamp)
     VALUES (?, ?, 'explore', 'project', 'find things', 1, 1, 0, 0, ?, 1, 0, '2026-09-01T00:00:00.000Z')`
  ).run(featureId, parentMessageId, cost);
}

function addToolCall(featureId: string, messageId: string, tool = "read"): void {
  db.prepare(
    `INSERT INTO tool_calls (feature_id, message_id, tool_name, args_size, timestamp)
     VALUES (?, ?, ?, 42, '2026-09-01T00:00:00.000Z')`
  ).run(featureId, messageId, tool);
}

/** The scenario this feature exists for: a project's cost buried in unassigned. */
function seedProject(): void {
  addSession("s1", APP);
  addSession("s2", APP + "/packages"); // nested dir is in scope
  addSession("s3", OTHER); // different project — must not move
  addMessage("m1", "s1", 1.5, "2026-09-01T10:00:00.000Z");
  addMessage("m2", "s1", 2.25, "2026-09-01T11:00:00.000Z");
  addMessage("m3", "s2", 0.5, "2026-09-02T09:00:00.000Z");
  addMessage("m4", "s3", 9.99, "2026-09-02T09:30:00.000Z"); // other project
  addSubagent("unassigned", "m1", 0.4);
  addToolCall("unassigned", "m2");
  addToolCall("unassigned", "m4"); // other project
}

beforeEach(() => {
  db = freshLedger();
  seedProject();
});

describe("claimLedger", () => {
  test("moves scoped rows and leaves other projects alone", () => {
    const summary = claimLedger(db as unknown as CoreDatabase, { cwd: APP, feature: FEATURE });

    expect(summary.applied).toBe(true);
    expect(summary.sessions).toBe(2);
    expect(summary.messages).toBe(3);
    expect(summary.costUsd).toBeCloseTo(4.25, 5);
    expect(summary.subagentRuns).toBe(1);
    expect(summary.toolCalls).toBe(1);

    const claimed = db
      .prepare(`SELECT id FROM messages WHERE feature_id = ? ORDER BY id`)
      .all(FEATURE) as Array<{ id: string }>;
    expect(claimed.map((r) => r.id)).toEqual(["m1", "m2", "m3"]);

    // The other project's message and tool call stayed behind.
    const left = db
      .prepare(`SELECT feature_id FROM messages WHERE id = 'm4'`)
      .get() as { feature_id: string };
    expect(left.feature_id).toBe("unassigned");
    const otherTool = db
      .prepare(`SELECT feature_id FROM tool_calls WHERE message_id = 'm4'`)
      .get() as { feature_id: string };
    expect(otherTool.feature_id).toBe("unassigned");

    // Sessions were repointed so future reads agree with the rows.
    const sessions = db
      .prepare(`SELECT id, feature_id FROM sessions ORDER BY id`)
      .all() as Array<{ id: string; feature_id: string }>;
    expect(sessions).toEqual([
      { id: "s1", feature_id: FEATURE },
      { id: "s2", feature_id: FEATURE },
      { id: "s3", feature_id: "unassigned" },
    ]);
  });

  test("recomputes both sides' totals from messages", () => {
    claimLedger(db as unknown as CoreDatabase, { cwd: APP, feature: FEATURE });

    const target = db
      .prepare(`SELECT total_cost_usd, turn_count FROM features WHERE id = ?`)
      .get(FEATURE) as { total_cost_usd: number; turn_count: number };
    expect(target.total_cost_usd).toBeCloseTo(4.25, 5);
    expect(target.turn_count).toBe(3);

    const source = db
      .prepare(`SELECT total_cost_usd, turn_count FROM features WHERE id = 'unassigned'`)
      .get() as { total_cost_usd: number; turn_count: number };
    expect(source.total_cost_usd).toBeCloseTo(9.99, 5);
    expect(source.turn_count).toBe(1);
  });

  test("sub-agent cost follows its parent feature", () => {
    claimLedger(db as unknown as CoreDatabase, { cwd: APP, feature: FEATURE });
    const runs = db
      .prepare(`SELECT feature_id, cost_usd FROM subagent_runs`)
      .all() as Array<{ feature_id: string; cost_usd: number }>;
    expect(runs).toEqual([{ feature_id: FEATURE, cost_usd: 0.4 }]);
    const target = db
      .prepare(`SELECT subagent_cost_usd FROM features WHERE id = ?`)
      .get(FEATURE) as { subagent_cost_usd: number };
    expect(target.subagent_cost_usd).toBeCloseTo(0.4, 5);
  });

  test("dry-run writes nothing but projects the same numbers", () => {
    const summary = claimLedger(db as unknown as CoreDatabase, {
      cwd: APP,
      feature: FEATURE,
      dryRun: true,
    });

    expect(summary.applied).toBe(false);
    expect(summary.messages).toBe(3);
    expect(summary.costUsd).toBeCloseTo(4.25, 5);
    expect(summary.target.costUsd).toBeCloseTo(4.25, 5);
    expect(summary.target.turns).toBe(3);
    expect(summary.source.costUsd).toBeCloseTo(9.99, 5);
    expect(summary.source.turns).toBe(1);

    // Nothing moved and no feature row was created.
    const stillUnassigned = db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE feature_id = 'unassigned'`)
      .get() as { c: number };
    expect(stillUnassigned.c).toBe(4);
    const target = db.prepare(`SELECT COUNT(*) AS c FROM features WHERE id = ?`).get(FEATURE) as {
      c: number;
    };
    expect(target.c).toBe(0);
  });

  test("idempotent: a second claim moves nothing", () => {
    claimLedger(db as unknown as CoreDatabase, { cwd: APP, feature: FEATURE });
    const second = claimLedger(db as unknown as CoreDatabase, { cwd: APP, feature: FEATURE });
    expect(second.messages).toBe(0);
    expect(second.costUsd).toBe(0);
    expect(second.target.costUsd).toBeCloseTo(4.25, 5);
    expect(second.target.turns).toBe(3);
  });

  test("only rows on the --from feature move (never steals named features)", () => {
    // Pretend a previous claim already moved one message to a branch feature.
    ensureFeatureRow(db as unknown as CoreDatabase, "feat/other", "feat/other");
    db.prepare(`UPDATE messages SET feature_id = 'feat/other' WHERE id = 'm1'`).run();
    const summary = claimLedger(db as unknown as CoreDatabase, { cwd: APP, feature: FEATURE });
    expect(summary.messages).toBe(2); // m1 is not in `unassigned` anymore
    const moved = db
      .prepare(`SELECT feature_id FROM messages WHERE id = 'm1'`)
      .get() as { feature_id: string };
    expect(moved.feature_id).toBe("feat/other");
  });

  test("an explicit --from re-attributes from a named feature", () => {
    ensureFeatureRow(db as unknown as CoreDatabase, "feat/other", "feat/other");
    db.prepare(`UPDATE messages SET feature_id = 'feat/other' WHERE session_id = 's1'`).run();
    const summary = claimLedger(db as unknown as CoreDatabase, {
      cwd: APP,
      feature: FEATURE,
      from: "feat/other",
    });
    expect(summary.messages).toBe(2);
    expect(summary.from).toBe("feat/other");
  });

  test("a cwd with no sessions is a clean no-op", () => {
    const summary = claimLedger(db as unknown as CoreDatabase, {
      cwd: "/nowhere/at/all",
      feature: FEATURE,
    });
    expect(summary.applied).toBe(true); // the write path ran...
    expect(summary.sessions).toBe(0);
    expect(summary.messages).toBe(0);
    expect(summary.target.costUsd).toBe(0); // ...and created an empty feature
  });
});
