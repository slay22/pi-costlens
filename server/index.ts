/**
 * Costlens dashboard server (Bun).
 *
 * Step 4 of PHASE4.md: server + DB + JSON API + static HTML pages.
 * Step 5 (uPlot charts) comes next.
 *
 * Run manually:
 *   bun server/index.ts
 *   open http://localhost:7331/
 *
 * The extension spawns this via the `startServer` helper in
 * `extension/server.ts` with COSTLENS_HOME and COSTLENS_PORT set.
 */

import { join, dirname } from "node:path";
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
const VERSION = "0.4.0-step4";

// Web assets live in server/web/ alongside this file.
const WEB_DIR = join(dirname(import.meta.path), "web");

// Open the DB up-front so we fail fast with a clear error if it's
// missing, rather than 500-ing on the first request.
openDb(DB_PATH);

const ctx: RouteContext = { startedAt: STARTED_AT, version: VERSION };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
};

function serveStatic(path: string): Response {
  const file = Bun.file(path);
  return new Response(file, {
    headers: {
      "content-type": MIME[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream",
      "cache-control": "no-cache",
    },
  });
}

const server = Bun.serve({
  port: REQUESTED_PORT,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // API routes
      if (path === "/api/health") return handleHealth(ctx, REQUESTED_PORT);
      if (path === "/api/overview") return handleOverview();
      if (path === "/api/features") return handleFeatures();

      const featureMatch = path.match(/^\/api\/features\/([^/]+)(?:\/(messages))?$/);
      if (featureMatch) {
        const id = decodeURIComponent(featureMatch[1]);
        const sub = featureMatch[2];
        if (sub === "messages") return handleMessages(id, url);
        return handleFeature(id);
      }

      // Page routes
      if (path === "/" || path === "/index.html") {
        return serveStatic(join(WEB_DIR, "index.html"));
      }
      const featurePageMatch = path.match(/^\/feature\/(.+)$/);
      if (featurePageMatch) {
        return serveStatic(join(WEB_DIR, "feature.html"));
      }

      // Static assets
      if (path === "/style.css") return serveStatic(join(WEB_DIR, "style.css"));
      if (path === "/overview.js") return serveStatic(join(WEB_DIR, "overview.js"));
      if (path === "/feature.js") return serveStatic(join(WEB_DIR, "feature.js"));

      return new Response("Not found", { status: 404 });
    } catch (err) {
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
console.log(`  web dir:    ${WEB_DIR}`);
console.log(`  pid:        ${process.pid}`);

const shutdown = (signal: string) => {
  console.log(`\ncostlens-server received ${signal}, shutting down`);
  server.stop();
  closeDb();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
