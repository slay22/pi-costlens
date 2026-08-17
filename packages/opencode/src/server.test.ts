/**
 * opencode-costlens server plugin tests (Bun).
 *
 * Runs with: `bun test src/server.test.ts`
 *
 * Tests the capture logic by:
 *   1. Calling the plugin factory with a mock PluginInput.
 *   2. Firing synthetic opencode events (session.created,
 *      message.updated) via the returned `event` hook.
 *   3. Asserting the messages row was written correctly with
 *      source = "opencode".
 *
 * These tests use a real SQLite DB in a temp dir, not a mock.
 * That catches any SQL / schema issues that type-checking misses.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

// Temp dir used as COSTLENS_HOME for all tests.
const TEST_HOME = mkdtempSync(join(tmpdir(), "opencode-costlens-test-"));
process.env.COSTLENS_HOME = TEST_HOME;

const DB_DIR = join(TEST_HOME, "costlens");
const DB_PATH = join(DB_DIR, "ledger.db");

beforeAll(() => {
  mkdirSync(DB_DIR, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env.COSTLENS_HOME;
  } catch {}
});

// Import the plugin AFTER setting COSTLENS_HOME so db.ts resolves
// the right path at module load time.
const { Costlens } = await import("./server.ts");

// ---------------------------------------------------------------------------
// Helper: fire events through the plugin
// ---------------------------------------------------------------------------

function makePlugin() {
  return Costlens({ directory: "/tmp/test-project" });
}

function sessionCreatedEvent(sessionID: string) {
  return {
    event: {
      type: "session.created" as const,
      properties: { sessionID },
    },
  };
}

function messageUpdatedEvent(
  sessionID: string,
  opts: {
    id?: string;
    model?: string;
    cost?: number;
    input?: number;
    output?: number;
    completed?: number;
  } = {}
) {
  return {
    event: {
      type: "message.updated" as const,
      properties: {
        sessionID,
        info: {
          id: opts.id ?? `msg-${sessionID}-1`,
          role: "assistant",
          model: opts.model ?? "anthropic/claude-haiku-4-5",
          cost: opts.cost ?? 0.0042,
          tokens: {
            input: opts.input ?? 100,
            output: opts.output ?? 50,
            cache: { read: 10, write: 0 },
          },
          time: { completed: opts.completed ?? Date.now() },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe("schema", () => {
  test("initDb creates the ledger at COSTLENS_HOME", async () => {
    const hooks = await makePlugin();
    expect(hooks.event).toBeDefined();
    expect(hooks.dispose).toBeDefined();
    // The DB was opened; at minimum the messages table must exist.
    const db = new Database(DB_PATH);
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='messages'`).get() as { name: string } | null;
    expect(row?.name).toBe("messages");
    db.close();
    await hooks.dispose?.();
  });
});

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

describe("capture", () => {
  beforeEach(async () => {
    // Wipe sessions + messages between tests so each is isolated.
    // Use the singleton DB connection (via closeCoreDb + reopen) to
    // ensure visibility — creating a second connection to WAL mode DB
    // can have visibility timing issues in tests.
    const { closeDb } = await import("./db.ts");
    const { initDb } = await import("./db.ts");
    closeDb();
    const db = new Database(DB_PATH);
    db.exec(`DELETE FROM messages; DELETE FROM tool_calls; DELETE FROM subagent_runs; DELETE FROM notes; DELETE FROM tags; DELETE FROM sessions; DELETE FROM features;`);
    db.close();
    initDb(); // re-open singleton
  });

  // Fresh plugin per test — ensures the session.created/message.updated
  // are processed by the same plugin instance that owns the DB singleton.
  async function getHooks() {
    return Costlens({ directory: "/tmp" });
  }

  test("session.created creates a feature row (unassigned when no git)", async () => {
    const hooks = await getHooks();
    await hooks.event?.(sessionCreatedEvent("sess-1"));
    const db = new Database(DB_PATH);
    const f = db.prepare(`SELECT id FROM features WHERE id = 'unassigned'`).get() as { id: string } | null;
    expect(f).not.toBeNull();
    db.close();
    await hooks.dispose?.();
  });

  test("message.updated inserts a messages row with source='opencode'", async () => {
    const hooks = await getHooks();
    await hooks.event?.(sessionCreatedEvent("sess-2"));
    await hooks.event?.(messageUpdatedEvent("sess-2", {
      id: "m-1",
      cost: 0.0042,
      input: 100,
      output: 50,
    }));
    const db = new Database(DB_PATH);
    const row = db.prepare(`SELECT * FROM messages WHERE id = 'm-1'`).get() as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect(row!.source).toBe("opencode");
    expect(Number(row!.cost_usd)).toBeCloseTo(0.0042, 4);
    expect(Number(row!.input_tokens)).toBe(100);
    expect(Number(row!.output_tokens)).toBe(50);
    expect(Number(row!.cache_read)).toBe(10);
    db.close();
    await hooks.dispose?.();
  });

  test("model string is stripped of provider prefix", async () => {
    const hooks = await getHooks();
    await hooks.event?.(sessionCreatedEvent("sess-3"));
    await hooks.event?.(messageUpdatedEvent("sess-3", {
      id: "m-2",
      model: "anthropic/claude-sonnet-4-5",
    }));
    const db = new Database(DB_PATH);
    const row = db.prepare(`SELECT model, provider FROM messages WHERE id = 'm-2'`).get() as { model: string; provider: string } | null;
    expect(row?.model).toBe("claude-sonnet-4-5");
    expect(row?.provider).toBe("anthropic");
    db.close();
    await hooks.dispose?.();
  });

  test("intermediate message.updated (no time.completed) is ignored", async () => {
    const hooks = await getHooks();
    await hooks.event?.(sessionCreatedEvent("sess-4"));
    // Streaming chunk: time.completed not set
    await hooks.event?.({
      event: {
        type: "message.updated" as const,
        properties: {
          sessionID: "sess-4",
          info: {
            id: "m-3",
            role: "assistant",
            cost: 0,
            tokens: {},
            time: {}, // no completed field
          },
        },
      },
    });
    const db = new Database(DB_PATH);
    const row = db.prepare(`SELECT id FROM messages WHERE id = 'm-3'`).get();
    expect(row).toBeNull(); // not inserted
    db.close();
    await hooks.dispose?.();
  });

  test("message.updated is idempotent (INSERT OR REPLACE on same id)", async () => {
    const hooks = await getHooks();
    await hooks.event?.(sessionCreatedEvent("sess-5"));
    const evt = messageUpdatedEvent("sess-5", { id: "m-4", cost: 0.001 });
    await hooks.event?.(evt);
    await hooks.event?.(evt); // re-emit (session reload simulation)
    const db = new Database(DB_PATH);
    const rows = db.prepare(`SELECT id FROM messages WHERE id = 'm-4'`).all();
    expect(rows.length).toBe(1); // deduped
    db.close();
    await hooks.dispose?.();
  });

  test("feature totals are updated after insert", async () => {
    const hooks = await getHooks();
    await hooks.event?.(sessionCreatedEvent("sess-6"));
    await hooks.event?.(messageUpdatedEvent("sess-6", { id: "m-5", cost: 0.10 }));
    await hooks.event?.(messageUpdatedEvent("sess-6", { id: "m-6", cost: 0.20 }));
    const db = new Database(DB_PATH);
    // The unassigned feature (used when no git) should have turn_count=2
    const f = db.prepare(`SELECT total_cost_usd, turn_count FROM features WHERE id = 'unassigned'`).get() as { total_cost_usd: number; turn_count: number } | null;
    expect(f?.turn_count).toBe(2);
    expect(Number(f?.total_cost_usd)).toBeCloseTo(0.30, 4);
    db.close();
    await hooks.dispose?.();
  });
});
