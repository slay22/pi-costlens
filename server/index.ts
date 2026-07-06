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
  // Phase 7
  handleFeatureSubagents,
  handleFeatureSubagentRuns,
  handleFeatureTools,
  handleTopSubagents,
  // Phase 7.5
  handleClose,
  handleCancel,
  handleMerge,
  handleReopen,
  handleSetCap,
  handleAddTag,
  handleRemoveTag,
  handleAttachNote,
  type RouteContext,
} from "./api.js";
import { getCostlensHome, readConfig } from "./config.js";
import { DEFAULT_PORT, findFreePort } from "./port.js";

const COSTLENS_HOME = getCostlensHome();
const DB_PATH = join(COSTLENS_HOME, "ledger.db");
const STARTED_AT = new Date().toISOString();
const VERSION = "0.7.0";

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

function methodNotAllowed(allow: string): Response {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow },
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
      if (path === "/api/subagents/top") return handleTopSubagents(url);
      if (path === "/api/export.json") return handleExportJson();
      if (path === "/api/export.csv") return handleExportCsv();

      // /api/features/<id>... — feature id can contain slashes (e.g.
      // "feat/open"). Strip the prefix and dispatch on whatever is
      // left: a known sub-resource, an action, a tag-delete tail, or
      // the bare id.
      if (path.startsWith("/api/features/")) {
        const rest = path.slice("/api/features/".length);
        const method = req.method;

        // DELETE /api/features/<id>/tags/<tag> (tag never has slashes
        // because it's normalised — lowercase, single token).
        const tagDel = rest.match(/^(.+)\/tags\/([^/]+)$/);
        if (tagDel) {
          const id = decodeURIComponent(tagDel[1]);
          const tag = decodeURIComponent(tagDel[2]);
          if (method === "DELETE") return handleRemoveTag(id, tag);
          return methodNotAllowed("DELETE");
        }

        // <id>/<action-or-subresource> (POST/PATCH/GET).
        const action = rest.match(/^(.+)\/(messages|tags|notes|subagents|subagent-runs|tools|close|cancel|merge|reopen|cap)$/);
        if (action) {
          const id = decodeURIComponent(action[1]);
          const sub = action[2];
          // Status transitions (POST).
          if (sub === "close") return method === "POST" ? handleClose(id, req) : methodNotAllowed("POST");
          if (sub === "cancel") return method === "POST" ? handleCancel(id, req) : methodNotAllowed("POST");
          if (sub === "merge") return method === "POST" ? handleMerge(id, req) : methodNotAllowed("POST");
          if (sub === "reopen") return method === "POST" ? handleReopen(id) : methodNotAllowed("POST");
          // Cap (PATCH).
          if (sub === "cap") return method === "PATCH" ? handleSetCap(id, req) : methodNotAllowed("PATCH");
          // Read sub-resources (GET).
          if (sub === "messages") return method === "GET" ? handleMessages(id, url) : methodNotAllowed("GET");
          if (sub === "tags") {
            if (method === "GET") return handleFeatureTags(id);
            if (method === "POST") return handleAddTag(id, req);
            return methodNotAllowed("GET, POST");
          }
          if (sub === "notes") {
            if (method === "GET") return handleFeatureNotes(id);
            if (method === "POST") return handleAttachNote(id, req);
            return methodNotAllowed("GET, POST");
          }
          if (sub === "subagents") return handleFeatureSubagents(id);
          if (sub === "subagent-runs") return handleFeatureSubagentRuns(id);
          if (sub === "tools") return handleFeatureTools(id);
        }

        // Top-level feature (GET only).
        if (method === "GET") return handleFeature(decodeURIComponent(rest));
        return methodNotAllowed("GET");
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
