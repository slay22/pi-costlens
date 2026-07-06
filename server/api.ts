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
// Write endpoints (Phase 7.5)
//
// The dashboard is no longer read-only. These handlers wrap a small,
// tightly-scoped write surface so the user can act on a feature
// (close / cancel / merge / reopen / set-cap / add-tag / remove-tag /
// attach-note) without leaving the browser. All business rules live in
// `lifecycle.ts`; the HTTP layer is responsible only for input parsing,
// method dispatch, and status code mapping.
//
// Errors are JSON:
//   { "error": "lifecycle", "code": "NOT_FOUND", "message": "..." }
//   { "error": "lifecycle", "code": "INVALID_STATE", ... }
//   { "error": "lifecycle", "code": "UNASSIGNED", ... }
//   { "error": "lifecycle", "code": "BAD_REQUEST", ... }
// ---------------------------------------------------------------------------

import {
  addTag,
  attachNote,
  cancelFeature,
  closeFeature,
  LifecycleError,
  mergeFeature,
  removeTag,
  reopenFeature,
  setCap,
} from "./lifecycle.js";

function lifecycleError(err: LifecycleError): Response {
  const status =
    err.code === "NOT_FOUND" ? 404 :
    err.code === "BAD_REQUEST" ? 400 :
    409; // INVALID_STATE, UNASSIGNED
  return json(
    { error: "lifecycle", code: err.code, message: err.message },
    { status }
  );
}

/** Read the body as JSON, returning null on parse failure. */
async function readJsonBody(req: Request): Promise<unknown | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ---- status transitions ----

export async function handleClose(id: string, req: Request): Promise<Response> {
  try {
    const body = (await readJsonBody(req)) ?? {};
    const note = typeof (body as { note?: unknown }).note === "string"
      ? (body as { note: string }).note
      : undefined;
    const feature = closeFeature(id, note);
    return json(feature);
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleError(err);
    return serverError(err);
  }
}

export async function handleCancel(id: string, req: Request): Promise<Response> {
  try {
    const body = (await readJsonBody(req)) ?? {};
    const note = typeof (body as { note?: unknown }).note === "string"
      ? (body as { note: string }).note
      : undefined;
    const feature = cancelFeature(id, note);
    return json(feature);
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleError(err);
    return serverError(err);
  }
}

export async function handleMerge(id: string, req: Request): Promise<Response> {
  try {
    const body = (await readJsonBody(req)) ?? {};
    const note = typeof (body as { note?: unknown }).note === "string"
      ? (body as { note: string }).note
      : undefined;
    const feature = mergeFeature(id, note);
    return json(feature);
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleError(err);
    return serverError(err);
  }
}

export async function handleReopen(id: string): Promise<Response> {
  try {
    const feature = reopenFeature(id);
    return json(feature);
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleError(err);
    return serverError(err);
  }
}

// ---- cap ----

export async function handleSetCap(id: string, req: Request): Promise<Response> {
  try {
    const body = (await readJsonBody(req));
    if (body === null) {
      return badRequest("Body must be JSON with a capUsd field.");
    }
    const capUsdRaw = (body as { capUsd?: unknown }).capUsd;
    if (capUsdRaw === null) {
      const feature = setCap(id, null);
      return json(feature);
    }
    if (typeof capUsdRaw !== "number" || !Number.isFinite(capUsdRaw)) {
      return badRequest("capUsd must be a number or null.");
    }
    const feature = setCap(id, capUsdRaw);
    return json(feature);
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleError(err);
    return serverError(err);
  }
}

// ---- tags ----

export async function handleAddTag(id: string, req: Request): Promise<Response> {
  try {
    const body = (await readJsonBody(req));
    if (body === null) {
      return badRequest("Body must be JSON with a tag field.");
    }
    const tag = (body as { tag?: unknown }).tag;
    if (typeof tag !== "string") {
      return badRequest("tag must be a string.");
    }
    const normalised = addTag(id, tag);
    return json({ tag: normalised, tags: getTags(id) });
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleError(err);
    return serverError(err);
  }
}

export async function handleRemoveTag(id: string, tag: string): Promise<Response> {
  try {
    const tags = removeTag(id, tag);
    return json({ tags });
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleError(err);
    return serverError(err);
  }
}

// ---- notes ----

export async function handleAttachNote(id: string, req: Request): Promise<Response> {
  try {
    const body = (await readJsonBody(req));
    if (body === null) {
      return badRequest("Body must be JSON with a body field.");
    }
    const noteBody = (body as { body?: unknown }).body;
    if (typeof noteBody !== "string") {
      return badRequest("body must be a string.");
    }
    const note = attachNote(id, noteBody);
    return json(note);
  } catch (err) {
    if (err instanceof LifecycleError) return lifecycleError(err);
    return serverError(err);
  }
}
