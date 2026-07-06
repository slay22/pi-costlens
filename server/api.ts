/**
 * HTTP route handlers for the Costlens dashboard.
 *
 * Handlers return a `Response` and never throw — errors are mapped to
 * 4xx/5xx with a small JSON body. The Bun fetch loop in `index.ts`
 * delegates here based on the URL.
 */

import {
  getAllFeatures,
  getFeature,
  getNotes,
  getOverview,
  getRecentModels,
  getTags,
  getMessages,
  getAllTags,
  searchFeatures,
  exportLedger,
  exportLedgerCsv,
  getSubagentRuns,
  getSubagentSummary,
  getToolCallCounts,
  getTopSubagents,
} from "./db.js";

const JSON_HEADERS = { "content-type": "application/json" };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

function notFound(what: string): Response {
  return json({ error: "not_found", message: what }, { status: 404 });
}

function badRequest(message: string): Response {
  return json({ error: "bad_request", message }, { status: 400 });
}

function serverError(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);
  return json({ error: "server_error", message }, { status: 500 });
}

export type RouteContext = {
  startedAt: string;
  version: string;
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleHealth(ctx: RouteContext, port: number) {
  return json({
    ok: true,
    version: ctx.version,
    startedAt: ctx.startedAt,
    port,
  });
}

export function handleOverview(): Response {
  try {
    return json(getOverview());
  } catch (err) {
    return serverError(err);
  }
}

export function handleFeatures(url: URL): Response {
  try {
    const q = url.searchParams.get("q");
    if (q && q.trim()) {
      return json(searchFeatures(q));
    }
    return json(getAllFeatures());
  } catch (err) {
    return serverError(err);
  }
}

export function handleAllTags(): Response {
  try {
    return json(getAllTags());
  } catch (err) {
    return serverError(err);
  }
}

export function handleFeatureTags(id: string): Response {
  try {
    if (!getFeature(id)) return notFound(`No feature "${id}".`);
    return json(getTags(id));
  } catch (err) {
    return serverError(err);
  }
}

export function handleFeatureNotes(id: string): Response {
  try {
    if (!getFeature(id)) return notFound(`No feature "${id}".`);
    return json(getNotes(id));
  } catch (err) {
    return serverError(err);
  }
}

export function handleExportJson(): Response {
  try {
    return json(exportLedger());
  } catch (err) {
    return serverError(err);
  }
}

export function handleExportCsv(): Response {
  try {
    return new Response(exportLedgerCsv(), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="costlens-export.csv"',
      },
    });
  } catch (err) {
    return serverError(err);
  }
}

export function handleFeature(id: string): Response {
  try {
    const feature = getFeature(id);
    if (!feature) return notFound(`No feature "${id}".`);
    return json({
      ...feature,
      notes: getNotes(id),
      tags: getTags(id),
      recentModels: getRecentModels(id),
    });
  } catch (err) {
    return serverError(err);
  }
}

export function handleMessages(
  id: string,
  url: URL
): Response {
  try {
    if (!getFeature(id)) return notFound(`No feature "${id}".`);
    const since = url.searchParams.get("since") ?? undefined;
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if (limit !== undefined && (isNaN(limit) || limit <= 0)) {
      return badRequest("limit must be a positive number");
    }
    return json(getMessages(id, { since, limit }));
  } catch (err) {
    return serverError(err);
  }
}

// ---------------------------------------------------------------------------
// Phase 7: sub-agents + per-tool cost attribution
// ---------------------------------------------------------------------------

export function handleFeatureSubagents(id: string): Response {
  try {
    if (!getFeature(id)) return notFound(`No feature "${id}".`);
    return json(getSubagentSummary(id));
  } catch (err) {
    return serverError(err);
  }
}

export function handleFeatureSubagentRuns(id: string): Response {
  try {
    if (!getFeature(id)) return notFound(`No feature "${id}".`);
    return json(getSubagentRuns(id));
  } catch (err) {
    return serverError(err);
  }
}

export function handleFeatureTools(id: string): Response {
  try {
    if (!getFeature(id)) return notFound(`No feature "${id}".`);
    return json(getToolCallCounts(id));
  } catch (err) {
    return serverError(err);
  }
}

export function handleTopSubagents(url: URL): Response {
  try {
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw ? Number(limitRaw) : 10;
    if (isNaN(limit) || limit <= 0) {
      return badRequest("limit must be a positive number");
    }
    return json(getTopSubagents(limit));
  } catch (err) {
    return serverError(err);
  }
}
