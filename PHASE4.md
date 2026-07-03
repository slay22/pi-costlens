# Phase 4 — Dashboard v1

A local web dashboard served by an embedded Bun process, reading from the same SQLite ledger the extension writes to. Real-time cost visibility, model breakdowns, and per-feature detail.

**Status:** not started. Dogfood target: branch `feat/phase-4-dashboard`.

---

## 1. Goals

- A web UI you can open with `/feature dashboard` that shows every feature's cost, status, and breakdown
- Per-feature drill-down at `/feature/:id` with cost timeline, model mix, notes, tags
- The server runs as a child process of the extension by default; survives pi exit only with `--detach`
- Zero new npm dependencies. Bun is built-in for `Bun.serve()` and `bun:sqlite`. Frontend is vanilla HTML/CSS/JS, uPlot from CDN.

## 2. Non-goals (deferred)

- Sub-agent cost attribution
- Per-tool cost analysis
- WebSocket / real-time push (v1 uses 5s polling)
- Team / multi-machine sync
- Pricing overrides
- Native OS notifications for cap hits

## 3. Architecture

```
pi (Node)
  └── costlens extension (Node, TypeScript)
        │   writes
        ▼
  ~/.pi/costlens/ledger.db   (WAL mode, shared with server)
        ▲   reads (readonly)
        │
  ┌──────────────────────────────────────────────────────┐
  │  costlens-server (Bun)                                │
  │  ├── Bun.serve() on localhost:<port> (default 7331)  │
  │  ├── bun:sqlite (readonly)                            │
  │  ├── API routes  /api/...                             │
  │  └── static assets  /, /feature/:id                   │
  └──────────────────────────────────────────────────────┘
```

**Lifecycle:**
- Default: spawned by the extension as a child of pi. Killed on `session_shutdown`.
- Detached: spawned with `--detach` flag. PID recorded in `~/.pi/costlens/server.pid`. Killed via `/feature dashboard stop` or by PID.

**Configuration:** `~/.pi/costlens/config.json` — created on first use, contains `{ "port": 7331 }` to start. Read by both extension and server (they agree on the port).

## 4. Files

```
costlens/
├── extension/
│   ├── server.ts                 NEW — spawn / kill / status
│   ├── config.ts                 NEW — read/write config.json
│   ├── commands.ts               MODIFIED — /feature dashboard, /feature open,
│   │                                       /feature dashboard stop,
│   │                                       /feature set-port
│   ├── index.ts                  MODIFIED — start server on session_start
│   │                                       (optional auto-start)
│   └── footer.ts                 UNCHANGED
├── server/                       NEW (replaces placeholder README)
│   ├── index.ts                  Bun.serve() entry, routing, signals
│   ├── db.ts                     bun:sqlite read-only access
│   ├── api.ts                    JSON API handlers
│   ├── config.ts                 reads config.json
│   ├── port.ts                   find a free port in 7331..7399
│   └── web/
│       ├── index.html            overview page
│       ├── feature.html          feature detail page
│       ├── style.css             shared styles
│       ├── overview.js           overview page logic
│       ├── feature.js            feature detail page logic
│       └── vendor/
│           └── uplot.iife.min.js   uPlot 1.6.x from CDN, vendored locally
├── test/
│   ├── server.test.ts            NEW — bun:test for server queries + API
│   ├── extension.test.ts         UNCHANGED
│   ├── footer.test.ts            UNCHANGED
│   └── lifecycle.test.ts         UNCHANGED
├── package.json                  MODIFIED — add `test:server` script
└── PHASE4.md                     this file
```

## 5. API surface

All routes are GET unless noted. JSON content is `Content-Type: application/json`.

### Health

| Route | Response | Notes |
|---|---|---|
| `GET /api/health` | `{ ok: true, version, startedAt, port }` | Used by the extension to wait for "ready" after spawn |

### Overview

| Route | Response shape |
|---|---|
| `GET /api/overview` | `{ totalCost, totalTokens, totalTurns, totalFeatures, currentFeature?, topFeatures: [{id,name,cost,turns,status}], byDay: [{date, cost, turns}], byModel: [{model, cost, turns, inputTokens, outputTokens}], byStatus: {open, done, abandoned, merged, unassigned} }` |

`byDay` covers the last 30 days. Days with no activity are included with `cost: 0`. The "current feature" is the most recently active `open` feature (or `null`).

### Features

| Route | Response shape |
|---|---|
| `GET /api/features` | `Feature[]` — full list sorted by `last_activity_at` desc, with `total_cost_usd`, `turn_count`, `status`, `pricing_conf` |
| `GET /api/features/:id` | `{ ...Feature, notes: [{id, body, created_at}], tags: string[], recentModels: string[] }` |
| `GET /api/features/:id/messages?since=<iso>&limit=<n>` | `Message[]` — for the cost-timeline chart and the "recent messages" table. `since` is optional; defaults to the last 100. |

`Message` shape: `{ id, timestamp, model, provider, input_tokens, output_tokens, cache_read, cache_write, cost_usd }`.

## 6. Frontend pages

### Overview (`/`)

```
┌──────────────────────────────────────────────────────────┐
│  Costlens                                       ↻ Refresh│
├──────────────────────────────────────────────────────────┤
│  Total spent:  $42.31     Total turns: 187               │
│  Features:     12 (8 open, 3 done, 1 abandoned)          │
│  Current:      feat/phase-4-dashboard  $4.23  ▏31 turns │
├──────────────────────────────────────────────────────────┤
│  Top 5 features                                          │
│  ┌────────────────────────────────────────────────┐     │
│  │ feat/phase-4-dashboard  $4.23  open   31 turns  │     │
│  │ auth-refactor           $3.10  done   22 turns  │     │
│  │ fix-landing             $1.87  done   15 turns  │     │
│  │ ...                                            │     │
│  └────────────────────────────────────────────────┘     │
├──────────────────────────────────────────────────────────┤
│  Cost by day (last 30)                                   │
│  [uPlot line chart]                                      │
├──────────────────────────────────────────────────────────┤
│  Cost by model                                           │
│  [uPlot bar chart]                                       │
└──────────────────────────────────────────────────────────┘
```

### Feature detail (`/feature/:id`)

```
┌──────────────────────────────────────────────────────────┐
│  ← back    feat/phase-4-dashboard      (open)             │
│           branch: feat/phase-4-dashboard  cap: $0.50     │
├──────────────────────────────────────────────────────────┤
│  Cost: $4.23 / $0.50 cap  ▏31 turns                      │
│  Tokens: in 12,403 · out 8,221 · cache r 41,028          │
│  Pricing confidence: complete                            │
├──────────────────────────────────────────────────────────┤
│  Notes                                                   │
│  - 2026-07-03  dashboard skeleton landed                  │
│  - 2026-07-03  API endpoints done                         │
├──────────────────────────────────────────────────────────┤
│  Cost over time                                          │
│  [uPlot line chart — one point per message]              │
├──────────────────────────────────────────────────────────┤
│  Cost by model (for this feature)                        │
│  [uPlot bar chart]                                       │
├──────────────────────────────────────────────────────────┤
│  Recent messages                                         │
│  timestamp              model           in    out   cost  │
│  2026-07-03T16:00:00Z   claude-haiku-4-5  230   89  0.001│
│  ...                                                      │
└──────────────────────────────────────────────────────────┘
```

**Refresh:** a "↻ Refresh" button fetches `/api/...` again. On the feature page, also 5s polling (so the live footer has a UI mirror). On the overview, no polling (manual refresh is fine for now).

**Styling:** minimal. Single `style.css`, system font stack, dark/light auto via `prefers-color-scheme`. No framework.

## 7. Commands added to `/feature`

| Command | Behaviour |
|---|---|
| `/feature dashboard` | If server not running, start it. Then open browser to `http://localhost:<port>/`. |
| `/feature open <name>` | If server not running, start it. Then open browser to `http://localhost:<port>/feature/<name>`. |
| `/feature dashboard --detach` | Start server with `detach: true`. Server survives pi exit. Prints PID. |
| `/feature dashboard stop` | Kill the detached server (sends SIGTERM to recorded PID, waits 2s, SIGKILL if needed). |
| `/feature set-port <N>` | Persist `N` in `config.json` and report. Doesn't restart the running server (user restarts manually). |

`/feature dashboard stop` returns "no detached server running" if the PID file is missing.

## 8. Server lifecycle in the extension

`extension/server.ts` exports:

```ts
type ServerHandle = { pid: number; port: number; detach: boolean };

export function startServer(opts: { port: number; detach: boolean }): Promise<ServerHandle>;
export function stopServer(opts: { detach: boolean }): Promise<void>;
export function isServerRunning(): boolean;
```

**Spawn flow** (`startServer`):
1. Check `~/.pi/costlens/server.pid` — if exists and process alive, reuse.
2. Find free port starting from configured port.
3. Spawn `bun <path-to-server>/index.ts` with env `COSTLENS_HOME`, `COSTLENS_PORT`.
4. Poll `/api/health` every 200ms, up to 5s. If healthy, return handle.
5. If `--detach`, write PID to `~/.pi/costlens/server.pid`.
6. If non-detach, register cleanup on `session_shutdown`.

**Browser open:** `child_process.execFile("open", [url])` on macOS. On Linux, `xdg-open`. On Windows, `cmd /c start`. Respect `$BROWSER` env var first.

## 9. Configuration

`~/.pi/costlens/config.json`:

```json
{
  "port": 7331
}
```

Created lazily on first access. If missing, write defaults. If malformed, log and use defaults (don't crash).

`extension/config.ts` and `server/config.ts` both read this file. They use the same simple JSON parse + defaults. No schema validation library.

## 10. Tests

`test/server.test.ts` (runs with `bun test`):

- `db.ts` queries return expected shapes against a seeded DB
- `api.ts` handlers return correct JSON for known fixtures
- `port.ts` finds the next free port in 7331..7399
- `config.ts` round-trips a config object through disk

The extension side keeps its existing tests (Node). Two test commands:
- `npm test` — extension (Node)
- `bun test` — server (Bun)

## 11. Implementation order

Each step is dogfoodable: the dashboard URL works after step 4, the commands work after step 3, and we can refresh data as we go.

1. **`server/index.ts` skeleton** — `Bun.serve()` with `/api/health` returning `{ ok: true }`. Manually runnable: `bun server/index.ts`.
2. **`server/db.ts` + `server/api.ts`** — read-only queries, JSON handlers for `/api/overview`, `/api/features`, `/api/features/:id`, `/api/features/:id/messages`.
3. **`extension/server.ts` + `/feature dashboard` command** — spawn, kill, open browser. Auto-shutdown on `session_shutdown` (non-detached).
4. **Static HTML for `/` and `/feature/:id`** — basic tables, no charts. Hit refresh to see new data.
5. **uPlot integration** — cost-by-day (line), cost-by-model (bar), cost-timeline (line per message).
6. **`/feature open <name>`, `--detach`, `stop`, `set-port`** — full command surface.
7. **CSS, dark/light, error states, polling** — polish.

## 12. Decisions worth flagging

1. **No new npm dependencies.** Bun's built-in `bun:sqlite` and `Bun.serve()` are enough. uPlot vendored locally (one ~40KB file) so the dashboard works offline.
2. **Read-only DB on the server side.** Bun's `DatabaseSync` accepts `readonly: true` and `fileMustExist: true`. WAL mode means the extension's writes don't block.
3. **No real-time push in v1.** Polling (5s on detail page, manual on overview). WebSocket is a v2 add — the API is already JSON so swapping in WS later is mechanical.
4. **Port persists in `config.json`, not in pi settings.** Costlens owns its own state under `~/.pi/costlens/`. No cross-contamination with pi's config.
5. **Server failure = graceful degradation.** If the server crashes mid-session, `/feature dashboard` restarts it. If it fails to start (port in use, etc.), show the error in pi, don't crash.
6. **Two test runners.** `npm test` (Node, for extension), `bun test` (Bun, for server). This is by design — the two runtimes are different.

## 13. Dogfooding plan

You're on `feat/phase-4-dashboard` already.

- Set cap: `/feature set-cap 0.50` early on so the dashboard's color change is visible while building
- After step 3, you can run `/feature dashboard` and see real accumulated data from Phase 1-3 work
- After step 5, charts populate
- After step 7, full polish — close with `/feature close dashboard shipped`
- New commands: `/feature dashboard`, `/feature open feat/phase-4-dashboard`, `/feature set-port 8080`, etc.

## 14. Rollback

Phase 4 is additive. If the dashboard ships broken, `/feature dashboard` just errors. The extension itself is unchanged. Wipe `~/.pi/costlens/server.pid` to forget a detached server.
