/**
 * Costlens dashboard server (Bun).
 *
 * Step 2 of PHASE4.md: server skeleton + DB queries + JSON API.
 * Step 4 (HTML pages) and step 5 (uPlot) come later.
 *
 * Run manually:
 *   bun server/index.ts
 *   curl http://localhost:7331/api/health
 *   curl http://localhost:7331/api/overview
 *
 * The extension spawns this in step 3 with COSTLENS_HOME and
 * COSTLENS_PORT set in the environment.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { openDb, closeDb } from "./db.js";
import {
  handleFeatures,
  handleFeature,
  handleHealth,
  handleMessages,
  handleOverview,
  type RouteContext,
} from "./api.js";

const COSTLENS_HOME = process.env.COSTLENS_HOME
  ? join(process.env.COSTLENS_HOME, "costlens")
  : join(homedir(), ".pi", "costlens");
const DB_PATH = join(COSTLENS_HOME, "ledger.db");
const REQUESTED_PORT = Number(process.env.COSTLENS_PORT) || 7331;
const STARTED_AT = new Date().toISOString();
const VERSION = "0.4.0-step2";

// Open the DB up-front so we fail fast with a clear error if it's
// missing, rather than 500-ing on the first request.
openDb(DB_PATH);

const ctx: RouteContext = { startedAt: STARTED_AT, version: VERSION };

const server = Bun.serve({
  port: REQUESTED_PORT,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/api/health") return handleHealth(ctx, server.port);
      if (path === "/api/overview") return handleOverview();
      if (path === "/api/features") return handleFeatures();

      // /api/features/:id and /api/features/:id/messages
      const featureMatch = path.match(/^\/api\/features\/([^/]+)(?:\/(messages))?$/);
      if (featureMatch) {
        const id = decodeURIComponent(featureMatch[1]);
        const sub = featureMatch[2];
        if (sub === "messages") return handleMessages(id, url);
        return handleFeature(id);
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      // Last-resort safety net so the server never crashes on a bad
      // request. The API handlers already catch their own errors.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`unhandled error: ${message}`);
      return new Response(JSON.stringify({ error: "server_error", message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },
});

console.log(`costlens-server v${VERSION}`);
console.log(`  listening:  http://localhost:${server.port}`);
console.log(`  db path:    ${DB_PATH}`);
console.log(`  pid:        ${process.pid}`);
console.log(`  routes:     /api/health, /api/overview, /api/features, /api/features/:id, /api/features/:id/messages`);

const shutdown = (signal: string) => {
  console.log(`\ncostlens-server received ${signal}, shutting down`);
  server.stop();
  closeDb();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
