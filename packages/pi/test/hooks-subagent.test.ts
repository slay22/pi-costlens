/**
 * Phase 7: tests for the sub-agent + per-tool cost attribution hook.
 *
 * The `message_end` handler in `extension/hooks.ts` has two branches:
 *  - assistant message: record LLM cost, update feature totals, fire
 *    cap-threshold notification (Phase 1+6 behaviour, covered by the
 *    smoke test in `extension.test.ts`).
 *  - toolResult message: for `Agent` tool results, read
 *    `details.results` and insert one `subagent_runs` row per result;
 *    for other tool results, insert a `tool_calls` row.
 *
 * These tests exercise the toolResult branch with hand-crafted events
 * that mimic what pi emits. The handler reads `event.message.role`,
 * `event.message.toolCallId`, `event.message.toolName`,
 * `event.message.timestamp`, and (for Agent) `event.message.details`.
 */

import { describe, test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testHome: string;

before(() => {
  testHome = mkdtempSync(join(tmpdir(), "costlens-subagent-"));
  process.env.COSTLENS_HOME = testHome;
});

after(() => {
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  delete process.env.COSTLENS_HOME;
});

beforeEach(async () => {
  const { closeDb, initDb } = await import("../extension/db.js");
  closeDb();
  rmSync(join(testHome, "costlens"), { recursive: true, force: true });
  initDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AssistantMessage = {
  role: "assistant";
  model: string;
  provider: string;
  timestamp: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
};

type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  timestamp: number;
  details?: unknown;
};

type ExtensionContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    setStatus: (key: string, text: string) => void;
    notify: (msg: string, level: string) => Promise<void> | void;
  };
  sessionManager: {
    getSessionFile: () => string | undefined;
    getLeafId: () => string | undefined;
    getEntries: () => unknown[];
  };
};

function makeAssistantEvent(msg: AssistantMessage) {
  return { type: "message_end", message: msg };
}

function makeToolResultEvent(msg: ToolResultMessage) {
  return { type: "message_end", message: msg };
}

function makeCtx(): ExtensionContext {
  return {
    cwd: "/tmp",
    hasUI: false,
    ui: {
      setStatus: () => {},
      notify: () => {},
    },
    sessionManager: {
      getSessionFile: () => "/tmp/hook-test.jsonl",
      getLeafId: () => "leaf-1",
      getEntries: () => [],
    },
  };
}

/**
 * Drive the extension through session_start so a feature is created,
 * then return the session_start handler that we can fire message_end
 * through.
 */
async function bootstrapFeature(branch: string): Promise<{
  fireMessageEnd: (msg: unknown) => Promise<void>;
}> {
  const { ensureFeatureForSession, _resetForTest, getFeature } = await import(
    "../extension/lifecycle.js"
  );
  _resetForTest();
  await ensureFeatureForSession(
    {
      cwd: "/tmp",
      sessionFile: "/tmp/hook-test.jsonl",
      git: { isRepo: true, branch, isMainBranch: false },
    },
    async () => true
  );
  // Sanity: feature should be created
  assert.ok(getFeature(branch), `feature "${branch}" created`);

  // Now register the hooks and capture the message_end handler.
  const { registerHooks } = await import("../extension/hooks.js");
  let handler: ((e: unknown, c: unknown) => Promise<void>) | null = null;
  const pi = {
    on(event: string, fn: unknown) {
      if (event === "message_end") handler = fn as never;
    },
    registerCommand() {},
  };
  registerHooks(pi as never);
  if (!handler) throw new Error("message_end handler not registered");

  return {
    fireMessageEnd: (msg) => handler!(msg, makeCtx()),
  };
}

// ---------------------------------------------------------------------------
// Sub-agent recording
// ---------------------------------------------------------------------------

describe("sub-agent recording", () => {
  test("inserts a subagent_runs row for a single Agent result", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/sub-1");
    const { getSubagentRuns, getFeature } = await import(
      "../extension/lifecycle.js"
    );

    await fireMessageEnd(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "Agent",
        timestamp: Date.now(),
        details: {
          mode: "single",
          results: [
            {
              agent: "Explore",
              agentSource: "user",
              task: "find files",
              exitCode: 0,
              usage: {
                input: 1000,
                output: 200,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0.05,
                turns: 2,
              },
              model: "claude-haiku-4-5",
              stopReason: "stop",
            },
          ],
        },
      })
    );

    const runs = getSubagentRuns("feat/sub-1");
    assert.equal(runs.length, 1, "one subagent_runs row inserted");
    assert.equal(runs[0].agent, "Explore");
    assert.equal(runs[0].agent_source, "user");
    assert.equal(runs[0].parent_message_id, "tc-1");
    assert.equal(runs[0].model, "claude-haiku-4-5");
    assert.equal(runs[0].input_tokens, 1000);
    assert.equal(runs[0].output_tokens, 200);
    assert.equal(runs[0].cost_usd, 0.05);
    assert.equal(runs[0].turns, 2);
    assert.equal(runs[0].step, null, "step is null for single mode");
    assert.equal(runs[0].exit_code, 0);
    assert.equal(runs[0].stop_reason, "stop");
    assert.equal(runs[0].task, "find files");

    // Feature's pre-computed subagent_cost_usd should match the run.
    const f = getFeature("feat/sub-1");
    assert.equal(f?.subagent_cost_usd, 0.05);
  });

  test("inserts N rows for parallel mode", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/sub-2");
    const { getSubagentRuns, getSubagentSummary } = await import(
      "../extension/lifecycle.js"
    );

    await fireMessageEnd(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-par",
        toolName: "Agent",
        timestamp: Date.now(),
        details: {
          mode: "parallel",
          results: [
            {
              agent: "Explore",
              agentSource: "user",
              task: "find A",
              exitCode: 0,
              usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
            },
            {
              agent: "Explore",
              agentSource: "user",
              task: "find B",
              exitCode: 0,
              usage: { input: 200, output: 80, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 2 },
            },
            {
              agent: "Plan",
              agentSource: "user",
              task: "draft plan",
              exitCode: 0,
              usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.005, turns: 1 },
            },
          ],
        },
      })
    );

    const runs = getSubagentRuns("feat/sub-2");
    assert.equal(runs.length, 3);
    const summary = getSubagentSummary("feat/sub-2");
    assert.equal(summary.length, 2, "two distinct agents");
    const explore = summary.find((s) => s.agent === "Explore");
    const plan = summary.find((s) => s.agent === "Plan");
    assert.equal(explore?.runs, 2);
    assert.equal(Math.round((explore?.cost ?? 0) * 1000) / 1000, 0.03);
    assert.equal(plan?.runs, 1);
  });

  test("inserts ordered rows for chain mode with step field", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/sub-3");
    const { getSubagentRuns } = await import("../extension/lifecycle.js");

    await fireMessageEnd(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-chain",
        toolName: "Agent",
        timestamp: Date.now(),
        details: {
          mode: "chain",
          results: [
            {
              agent: "Explore",
              agentSource: "user",
              task: "first",
              exitCode: 0,
              usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
              step: 0,
            },
            {
              agent: "Plan",
              agentSource: "user",
              task: "second",
              exitCode: 0,
              usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 2 },
              step: 1,
            },
          ],
        },
      })
    );

    const runs = getSubagentRuns("feat/sub-3");
    assert.equal(runs.length, 2);
    assert.equal(runs[0].agent, "Explore");
    assert.equal(runs[0].step, 0);
    assert.equal(runs[1].agent, "Plan");
    assert.equal(runs[1].step, 1);
  });

  test("ignores Agent toolResult with no details", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/sub-4");
    const { getSubagentRuns } = await import("../extension/lifecycle.js");

    await fireMessageEnd(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-x",
        toolName: "Agent",
        timestamp: Date.now(),
        // no details
      })
    );

    assert.equal(getSubagentRuns("feat/sub-4").length, 0);
  });

  test("ignores Agent toolResult whose details don't have results", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/sub-5");
    const { getSubagentRuns } = await import("../extension/lifecycle.js");

    await fireMessageEnd(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-y",
        toolName: "Agent",
        timestamp: Date.now(),
        details: { mode: "single" }, // missing results
      })
    );

    assert.equal(getSubagentRuns("feat/sub-5").length, 0);
  });

  test("is idempotent on re-emit (same toolCallId)", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/sub-6");
    const { getSubagentRuns, getFeature } = await import(
      "../extension/lifecycle.js"
    );

    const evt = makeToolResultEvent({
      role: "toolResult",
      toolCallId: "tc-idem",
      toolName: "Agent",
      timestamp: Date.now(),
      details: {
        mode: "single",
        results: [
          {
            agent: "Explore",
            agentSource: "user",
            task: "idem",
            exitCode: 0,
            usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
          },
        ],
      },
    });

    await fireMessageEnd(evt);
    await fireMessageEnd(evt); // reload / replay

    const runs = getSubagentRuns("feat/sub-6");
    assert.equal(runs.length, 1, "second emit is a no-op");
    const f = getFeature("feat/sub-6");
    assert.equal(f?.subagent_cost_usd, 0.01, "cost not double-counted");
  });

  test("truncates task to 200 chars", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/sub-7");
    const { getSubagentRuns } = await import("../extension/lifecycle.js");

    const longTask = "x".repeat(500);
    await fireMessageEnd(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-long",
        toolName: "Agent",
        timestamp: Date.now(),
        details: {
          mode: "single",
          results: [
            {
              agent: "Explore",
              agentSource: "user",
              task: longTask,
              exitCode: 0,
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.0, turns: 1 },
            },
          ],
        },
      })
    );

    const runs = getSubagentRuns("feat/sub-7");
    assert.equal(runs[0].task.length, 200);
  });
});

// ---------------------------------------------------------------------------
// Tool-call recording (non-Agent toolResults)
// ---------------------------------------------------------------------------

describe("tool-call recording", () => {
  test("inserts a tool_calls row for a Read tool result", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/tc-1");
    const { getToolCallCounts, getToolCalls } = await import(
      "../extension/lifecycle.js"
    );

    await fireMessageEnd(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-read",
        toolName: "Read",
        timestamp: Date.now(),
      })
    );

    const counts = getToolCallCounts("feat/tc-1");
    assert.equal(counts.length, 1);
    assert.equal(counts[0].tool_name, "Read");
    assert.equal(counts[0].calls, 1);

    const all = getToolCalls("feat/tc-1");
    assert.equal(all.length, 1);
    assert.equal(all[0].message_id, "tc-read");
    assert.equal(all[0].tool_name, "Read");
    assert.equal(all[0].args_size, null, "args_size null when no entries");
  });

  test("counts multiple tool calls per tool", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/tc-2");
    const { getToolCallCounts } = await import("../extension/lifecycle.js");

    for (let i = 0; i < 3; i++) {
      await fireMessageEnd(
        makeToolResultEvent({
          role: "toolResult",
          toolCallId: `tc-bash-${i}`,
          toolName: "Bash",
          timestamp: Date.now(),
        })
      );
    }
    for (let i = 0; i < 2; i++) {
      await fireMessageEnd(
        makeToolResultEvent({
          role: "toolResult",
          toolCallId: `tc-read-${i}`,
          toolName: "Read",
          timestamp: Date.now(),
        })
      );
    }

    const counts = getToolCallCounts("feat/tc-2");
    const byName = Object.fromEntries(counts.map((c) => [c.tool_name, c.calls]));
    assert.equal(byName["Bash"], 3);
    assert.equal(byName["Read"], 2);
  });

  test("does NOT record Agent tool results as tool calls (cost is in subagent_runs)", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/tc-3");
    const { getToolCallCounts, getSubagentRuns } = await import(
      "../extension/lifecycle.js"
    );

    await fireMessageEnd(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-agent-1",
        toolName: "Agent",
        timestamp: Date.now(),
        details: {
          mode: "single",
          results: [
            {
              agent: "Explore",
              agentSource: "user",
              task: "find",
              exitCode: 0,
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.0, turns: 1 },
            },
          ],
        },
      })
    );

    assert.equal(getToolCallCounts("feat/tc-3").length, 0, "no tool_calls rows");
    assert.equal(getSubagentRuns("feat/tc-3").length, 1, "but one subagent_runs row");
  });

  test("attempts to look up args_size from session entries", async () => {
    const { ensureFeatureForSession, _resetForTest } = await import(
      "../extension/lifecycle.js"
    );
    _resetForTest();
    await ensureFeatureForSession(
      {
        cwd: "/tmp",
        sessionFile: "/tmp/hook-test.jsonl",
        git: { isRepo: true, branch: "feat/tc-4", isMainBranch: false },
      },
      async () => true
    );

    const { registerHooks } = await import("../extension/hooks.js");
    type MessageEndHandler = (e: unknown, c: unknown) => Promise<void>;
    let handler: MessageEndHandler | null = null;
    const pi = {
      on(event: string, fn: unknown) {
        if (event === "message_end") handler = fn as MessageEndHandler;
      },
      registerCommand() {},
    };
    registerHooks(pi as never);
    if (!handler) throw new Error("no handler");
    const fireHandler: MessageEndHandler = handler;

    const ctx: ExtensionContext = {
      cwd: "/tmp",
      hasUI: false,
      ui: { setStatus: () => {}, notify: () => {} },
      sessionManager: {
        getSessionFile: () => "/tmp/hook-test.jsonl",
        getLeafId: () => "leaf-1",
        getEntries: () => [
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "tc-with-args",
                  arguments: { file_path: "/tmp/x.ts", limit: 50 },
                },
              ],
            },
          },
        ],
      },
    };

    await fireHandler(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-with-args",
        toolName: "Read",
        timestamp: Date.now(),
      }),
      ctx
    );

    const { getToolCalls } = await import("../extension/lifecycle.js");
    const rows = getToolCalls("feat/tc-4");
    assert.equal(rows.length, 1);
    assert.ok(rows[0].args_size !== null, "args_size populated from session");
    assert.ok(rows[0].args_size! > 0, "args_size is a positive number");
  });
});

// ---------------------------------------------------------------------------
// Assistant message branch still works (smoke)
// ---------------------------------------------------------------------------

describe("assistant message branch (Phase 1+6 smoke)", () => {
  test("still records the parent's LLM cost and updates totals", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/asst-1");
    const { getFeature } = await import("../extension/lifecycle.js");
    const { getDb } = await import("../extension/db.js");

    await fireMessageEnd(
      makeAssistantEvent({
        role: "assistant",
        model: "claude-haiku-4-5",
        provider: "anthropic",
        timestamp: Date.now(),
        usage: {
          input: 100,
          output: 50,
          cacheRead: 1000,
          cacheWrite: 0,
          cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
        },
      })
    );

    const f = getFeature("feat/asst-1");
    assert.equal(f?.total_cost_usd, 0.03);
    assert.equal(f?.turn_count, 1);

    const msgs = getDb()
      .prepare(`SELECT * FROM messages WHERE feature_id = ?`)
      .all("feat/asst-1");
    assert.equal(msgs.length, 1);
  });
});

// ---------------------------------------------------------------------------
// /feature status sub-agent section (Phase 7)
// ---------------------------------------------------------------------------

/**
 * Drive the extension to register commands; fire `/feature status`;
 * capture the resulting notification. Mirrors the smoke-test pattern
 * in extension.test.ts.
 */
async function runStatus(featureId: string): Promise<string> {
  const { registerCommands } = await import("../extension/commands.js");
  const { getDb } = await import("../extension/db.js");
  const { detectGitContext } = await import("../extension/git.js");
  const { renderFooter } = await import("../extension/footer.js");

  const notifyCalls: string[] = [];
  const ctx = {
    cwd: "/tmp",
    hasUI: true,
    ui: {
      setStatus: () => {},
      notify: (msg: string) => {
        notifyCalls.push(msg);
      },
    },
    sessionManager: {
      getSessionFile: () => "/tmp/hook-test.jsonl",
      getLeafId: () => "leaf-1",
      getEntries: () => [],
    },
  };

  type CommandHandler = (args: string, c: unknown) => Promise<void>;
  let commandHandler: CommandHandler | null = null;
  const pi = {
    on() {},
    registerCommand(_name: string, def: { handler: CommandHandler }) {
      commandHandler = def.handler;
    },
  };
  registerCommands(pi as never, {
    getActiveFeatureId: () => featureId,
    getDb: () => getDb(),
    detectGitContext,
    refreshFooter: () => {},
  });
  if (!commandHandler) throw new Error("command handler not registered");
  const fire: CommandHandler = commandHandler;

  // Need a session row for getCurrentFeatureId to find the feature.
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sessions (id, feature_id, cwd, started_at, last_seen)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      "/tmp/hook-test.jsonl",
      featureId,
      "/tmp",
      new Date().toISOString(),
      new Date().toISOString()
    );

  await fire("status", ctx);
  // The last notify call is the status output.
  return notifyCalls[notifyCalls.length - 1] ?? "";
}

describe("/feature status includes sub-agent section", () => {
  test("shows a `sub-agents:` block when subagent_runs exist", async () => {
    const { fireMessageEnd } = await bootstrapFeature("feat/status-1");
    // Two sub-agent runs.
    await fireMessageEnd(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-1",
        toolName: "Agent",
        timestamp: Date.now(),
        details: {
          mode: "single",
          results: [
            {
              agent: "Explore",
              agentSource: "user",
              task: "find files",
              exitCode: 0,
              usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.05, turns: 1 },
            },
          ],
        },
      })
    );
    await fireMessageEnd(
      makeToolResultEvent({
        role: "toolResult",
        toolCallId: "tc-2",
        toolName: "Agent",
        timestamp: Date.now(),
        details: {
          mode: "single",
          results: [
            {
              agent: "Plan",
              agentSource: "user",
              task: "draft plan",
              exitCode: 0,
              usage: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.10, turns: 2 },
            },
          ],
        },
      })
    );

    const text = await runStatus("feat/status-1");
    assert.ok(text.includes("sub-agents:"), "sub-agents: block present");
    assert.ok(text.includes("Explore"), "lists Explore");
    assert.ok(text.includes("Plan"), "lists Plan");
    // Sub-agent cost appears under the `cost:` line.
    assert.match(text, /agents: \$0\.1500/);
    // Parent cost + agents sub-section both present.
    assert.match(text, /parent: \$0\.0000/);
  });

  test("omits the sub-agents block when there are no sub-agent runs", async () => {
    const _ = await bootstrapFeature("feat/status-2");
    const text = await runStatus("feat/status-2");
    assert.ok(!text.includes("sub-agents:"), "no sub-agents: block when empty");
  });
});
