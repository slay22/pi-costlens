/**
 * Costlens dashboard server (Bun).
 *
 * Step 1 of PHASE4.md: skeleton with /api/health.
 *
 * Run manually:
 *   bun server/index.ts
 *   curl http://localhost:7331/api/health
 *
 * The extension spawns this in step 3 with COSTLENS_HOME and
 * COSTLENS_PORT set in the environment.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const COSTLENS_HOME = process.env.COSTLENS_HOME
  ? join(process.env.COSTLENS_HOME, "costlens")
  : join(homedir(), ".pi", "costlens");
const DB_PATH = join(COSTLENS_HOME, "ledger.db");
const REQUESTED_PORT = Number(process.env.COSTLENS_PORT) || 7331;
const STARTED_AT = new Date().toISOString();
const VERSION = "0.4.0-step1";

const dbExists = existsSync(DB_PATH);

const server = Bun.serve({
  port: REQUESTED_PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        version: VERSION,
        startedAt: STARTED_AT,
        port: server.port,
        dbReady: dbExists,
        dbPath: DB_PATH,
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`costlens-server v${VERSION}`);
console.log(`  listening:  http://localhost:${server.port}`);
console.log(`  db path:    ${DB_PATH}`);
console.log(`  db status:  ${dbExists ? "found" : "NOT FOUND — has the extension run yet?"}`);
console.log(`  pid:        ${process.pid}`);

const shutdown = (signal: string) => {
  console.log(`\ncostlens-server received ${signal}, shutting down`);
  server.stop();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
