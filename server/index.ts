/**
 * Costlens dashboard server (Bun).
 *
 * Phase 4 of PHASE4.md: server + DB + JSON API + static HTML pages +
 * uPlot charts + dark/light + error states + polling.
 *
 * Run manually:
 *   bun server/index.ts
 *   open http://localhost:7331/
 *
 * The extension spawns this via the `startServer` helper in
 * `extension/server.ts` with COSTLENS_HOME and COSTLENS_PORT set.
 * If COSTLENS_PORT isn't set, we fall back to the configured port
 * from `~/.pi/costlens/config.json` (default 7331).
 */

import { join, dirname } from "node:path";
import { openDb, closeDb } from "./db.js";
import {
  handleFeatures,
  handleFeature,
  handleFeatureTags,
  handleFeatureNotes,
  handleHealth,
  handleMessages,
  handleOverview,
  handleAllTags,
  handleExportCsv,
  handleExportJson,
  type RouteContext,
} from "./api.js";
import { getCostlensHome, readConfig } from "./config.js";
import { DEFAULT_PORT, findFreePort } from "./port.js";

const COSTLENS_HOME = getCostlensHome();
const DB_PATH = join(COSTLENS_HOME, "ledger.db");
const STARTED_AT = new Date().toISOString();
const VERSION = "0.6.0";

// Web assets live in server/web/ alongside this file.
const WEB_DIR = join(dirname(import.meta.path), "web");

// Decide which port to bind. Priority:
//   1. COSTLENS_PORT env (the extension always sets this)
//   2. The port from config.json
//   3. The default 7331
// If the chosen port is taken, fall through to the next free port in
// the range. This keeps the manual `bun server/index.ts` flow usable
// even when the extension's server is already running.
const envPort = Number(process.env.COSTLENS_PORT);
const configuredPort = readConfig().port;
const preferredPort =
  Number.isFinite(envPort) && envPort > 0 ? envPort : configuredPort || DEFAULT_PORT;

const REQUESTED_PORT = (await findFreePort(preferredPort)) ?? preferredPort;

if (REQUESTED_PORT !== preferredPort) {
  console.warn(
    `costlens-server: preferred port ${preferredPort} taken; using ${REQUESTED_PORT}`
  );
}

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
  const ext = path.slice(path.lastIndexOf("."));
  return new Response(file, {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-cache",
    },
  });
}

async function tryServeStatic(path: string): Promise<Response | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const ext = path.slice(path.lastIndexOf("."));
  return new Response(file, {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-cache",
    },
  });
}

const server = Bun.serve({
  port: REQUESTED_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // API routes
      if (path === "/api/health") return handleHealth(ctx, REQUESTED_PORT);
      if (path === "/api/overview") return handleOverview();
      if (path === "/api/features") return handleFeatures(url);
      if (path === "/api/tags") return handleAllTags();
      if (path === "/api/export.json") return handleExportJson();
      if (path === "/api/export.csv") return handleExportCsv();

      const featureMatch = path.match(/^\/api\/features\/([^/]+)(?:\/(messages|tags|notes))?$/);
      if (featureMatch) {
        const id = decodeURIComponent(featureMatch[1]);
        const sub = featureMatch[2];
        if (sub === "messages") return handleMessages(id, url);
        if (sub === "tags") return handleFeatureTags(id);
        if (sub === "notes") return handleFeatureNotes(id);
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
      if (path.startsWith("/vendor/")) {
        const r = await tryServeStatic(join(WEB_DIR, path));
        if (r) return r;
      }

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
