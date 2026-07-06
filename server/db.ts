/**
 * Read-only SQLite access for the Costlens dashboard server (Bun).
 *
 * Uses `bun:sqlite` with `readonly: true` and `fileMustExist: true`. The
 * extension's writes happen against the same DB in WAL mode, so the
 * server never blocks the writer and vice versa.
 *
 * All query functions throw on schema errors. The HTTP layer maps those
 * to 500s; missing features return `undefined` and become 404s.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCostlensHome } from "./config.js";

const COSTLENS_HOME = getCostlensHome();
export const DB_PATH = join(COSTLENS_HOME, "ledger.db");

export type Feature = {
  id: string;
  name: string;
  branch: string | null;
  status: "open" | "done" | "abandoned" | "merged";
  cap_usd: number | null;
  started_at: string;
  closed_at: string | null;
  pricing_conf: "complete" | "partial" | "unknown";
  total_cost_usd: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write: number;
  turn_count: number;
  first_activity_at: string | null;
  last_activity_at: string | null;
};

export type Message = {
  id: string;
  feature_id: string;
  session_id: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  timestamp: string;
};

export type Note = { id: number; body: string; created_at: string };

export type Overview = {
  totalCost: number;
  totalTurns: number;
  totalFeatures: number;
  currentFeature: { id: string; name: string; cost: number; turns: number } | null;
  topFeatures: Array<{
    id: string;
    name: string;
    cost: number;
    turns: number;
    status: string;
  }>;
  byDay: Array<{ date: string; cost: number; turns: number }>;
  byModel: Array<{
    model: string;
    cost: number;
    turns: number;
    inputTokens: number;
    outputTokens: number;
  }>;
  byStatus: {
    open: number;
    done: number;
    abandoned: number;
    merged: number;
    unassigned: number;
  };
};

let _db: Database | null = null;

export function openDb(path: string = DB_PATH): Database {
  if (_db) return _db;
  if (!existsSync(path)) {
    throw new Error(
      `Costlens DB not found at ${path}; has the extension been run yet?`
    );
  }
  // `readonly: true` so the server can never write. (Bun's
  // DatabaseSync doesn't accept `fileMustExist` — if the path is wrong
  // or missing, the open call will throw with a clear error.)
  _db = new Database(path, { readonly: true });
  return _db;
}

export function getDb(): Database {
  if (!_db) throw new Error("DB not opened; call openDb() first");
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

export function getAllFeatures(): Feature[] {
  return getDb()
    .prepare(
      `SELECT * FROM features
       ORDER BY COALESCE(last_activity_at, started_at) DESC`
    )
    .all() as Feature[];
}

export function getFeature(id: string): Feature | null {
  const row = getDb()
    .prepare(`SELECT * FROM features WHERE id = ?`)
    .get(id) as Feature | null;
  return row ?? null;
}

export function getNotes(featureId: string): Note[] {
  return getDb()
    .prepare(
      `SELECT id, body, created_at FROM notes
       WHERE feature_id = ? ORDER BY created_at ASC`
    )
    .all(featureId) as Note[];
}

export function getTags(featureId: string): string[] {
  return (
    getDb()
      .prepare(`SELECT tag FROM tags WHERE feature_id = ? ORDER BY tag`)
      .all(featureId) as Array<{ tag: string }>
  ).map((r) => r.tag);
}

export function getRecentModels(featureId: string, limit = 3): string[] {
  return (
    getDb()
      .prepare(
        `SELECT model FROM messages
         WHERE feature_id = ?
         ORDER BY timestamp DESC LIMIT ?`
      )
      .all(featureId, limit) as Array<{ model: string }>
  ).map((r) => r.model);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function getMessages(
  featureId: string,
  opts: { since?: string; limit?: number } = {}
): Message[] {
  const limit = opts.limit ?? 100;
  if (opts.since) {
    return getDb()
      .prepare(
        `SELECT * FROM messages
         WHERE feature_id = ? AND timestamp > ?
         ORDER BY timestamp ASC LIMIT ?`
      )
      .all(featureId, opts.since, limit) as Message[];
  }
  return getDb()
    .prepare(
      `SELECT * FROM messages
       WHERE feature_id = ?
       ORDER BY timestamp ASC LIMIT ?`
    )
    .all(featureId, limit) as Message[];
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function getOverview(): Overview {
  const db = getDb();

  // Excludes unassigned from the totals so the "what have I spent on
  // actual features" number is clean. The byStatus.unassigned field
  // still surfaces that data separately.
  const totalRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(total_cost_usd), 0) AS cost,
         COALESCE(SUM(turn_count), 0)     AS turns
       FROM features
       WHERE id != 'unassigned'`
    )
    .get() as { cost: number; turns: number };

  const totalFeatures = (
    db.prepare(`SELECT COUNT(*) AS c FROM features`).get() as { c: number }
  ).c;

  const currentRow = db
    .prepare(
      `SELECT id, name, total_cost_usd AS cost, turn_count AS turns
       FROM features
       WHERE status = 'open' AND id != 'unassigned'
       ORDER BY COALESCE(last_activity_at, started_at) DESC
       LIMIT 1`
    )
    .get() as
    | { id: string; name: string; cost: number; turns: number }
    | undefined;

  const topFeatures = db
    .prepare(
      `SELECT id, name, total_cost_usd AS cost, turn_count AS turns, status
       FROM features
       WHERE id != 'unassigned'
       ORDER BY total_cost_usd DESC
       LIMIT 5`
    )
    .all() as Array<{
      id: string;
      name: string;
      cost: number;
      turns: number;
      status: string;
    }>;

  // byDay covers the last 30 days; missing days are filled with zeros
  // so the chart has a continuous x-axis.
  const byDayRows = db
    .prepare(
      `SELECT date(timestamp) AS date,
              SUM(cost_usd)   AS cost,
              COUNT(*)        AS turns
       FROM messages
       WHERE timestamp >= date('now', '-30 days')
       GROUP BY date(timestamp)`
    )
    .all() as Array<{ date: string; cost: number; turns: number }>;
  const dayMap = new Map(byDayRows.map((r) => [r.date, r]));
  const byDay: Array<{ date: string; cost: number; turns: number }> = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const row = dayMap.get(key);
    byDay.push({ date: key, cost: row?.cost ?? 0, turns: row?.turns ?? 0 });
  }

  const byModel = db
    .prepare(
      `SELECT model,
              SUM(cost_usd)      AS cost,
              COUNT(*)           AS turns,
              SUM(input_tokens)  AS inputTokens,
              SUM(output_tokens) AS outputTokens
       FROM messages
       GROUP BY model
       ORDER BY cost DESC`
    )
    .all() as Array<{
      model: string;
      cost: number;
      turns: number;
      inputTokens: number;
      outputTokens: number;
    }>;

  const statusRows = db
    .prepare(`SELECT status, COUNT(*) AS c FROM features GROUP BY status`)
    .all() as Array<{ status: string; c: number }>;
  const unassignedCount = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM features WHERE id = 'unassigned'`)
      .get() as { c: number }
  ).c;
  const byStatus = {
    open: 0,
    done: 0,
    abandoned: 0,
    merged: 0,
    unassigned: 0,
  };
  for (const row of statusRows) {
    if (row.status in byStatus && row.status !== "unassigned") {
      (byStatus as Record<string, number>)[row.status] = row.c;
    }
  }
  byStatus.unassigned = unassignedCount;

  return {
    totalCost: totalRow.cost,
    totalTurns: totalRow.turns,
    totalFeatures,
    currentFeature: currentRow ?? null,
    topFeatures,
    byDay,
    byModel,
    byStatus,
  };
}
