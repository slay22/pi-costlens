# Costlens — v1 Plan

A pi extension (with an embedded Bun server) that books the real dollar cost and token usage of every assistant message to a **feature**, where a feature is a git branch you're working on. Gives you a local web dashboard with totals, breakdowns, and a soft-cap warning while you work.

---

## 1. What it is

When you start a pi session on a non-main branch, Costlens prompts once: *"Start a feature for `branch-name`?"*. You confirm, and every assistant message that follows has its token usage and dollar cost booked to that feature. Close the feature when you're done (`/feature close`) or abandon it (`/feature cancel`) — the cost is preserved either way. A local web dashboard shows totals, breakdowns by model/day/tool, and a top-level overview of all features.

---

## 2. User-facing behavior

### Lifecycle

- **Start:** On session start, if the current branch is non-main and we don't recognise the feature, prompt once to open it. Branch name is the default feature name; renameable via `/feature rename`.
- **Close:** `/feature close [note]` → status `done`, cost frozen.
- **Cancel:** `/feature cancel [note]` → status `abandoned`, cost frozen.
- **Unassigned pool:** Sessions on `main`, detached HEAD, or no git book costs to a synthetic `unassigned` feature. The footer is hidden on `main`; unassigned shows up in `/feature list` and the dashboard.
- **Multi-session:** Same branch across days/sessions = same feature ID, costs accumulate.

### Commands (slash + palette)

```
/feature status               # current feature detail
/feature list                 # all features
/feature close [note]
/feature cancel [note]
/feature rename <name>
/feature set-cap <usd>        # 0 to clear
/feature dashboard            # open browser
/feature open <name>          # deep-link to feature
/feature note <text>          # attach note
/feature tag add|remove <t>   # categorize
/feature merge                # mark branch as merged (not closed)
/feature search <q>           # find by name
/feature export <format>      # csv | json
/feature help
```

### Footer

On every prompt, when a feature is active (and not on `main`):
```
● fix-landing-page  $4.32 / $20 cap  ▏12 turns  ▏opus-4-5
```
Color: green → yellow at 50% → red at 100% (and at 100% a one-line warning prints in the next response).

### Dashboard

- **Bun server** embedded as a child process of pi.
- **Default port 7331**, configurable (`/feature set-port`).
- **Auto-opens browser** on first `/feature dashboard`.
- **Detach with `/feature dashboard --detach`** → server keeps running after pi exits, PID printed, killed via `/feature dashboard stop`.
- **Routes:**
  - `/` — overview: total spent, top 5 most expensive features, cost by day (line chart), cost by model (bar chart), feature status breakdown.
  - `/feature/<name>` — feature detail: cost timeline, model breakdown, tool-call counts, turns, notes, tags, status.
  - `/api/...` — JSON for the front-end.
  - Deep-link from CLI: `/feature open <name>` copies a URL like `http://localhost:7331/feature/fix-landing-page`.

---

## 3. Data model (SQLite)

`~/.pi/costlens/ledger.db`:

```sql
CREATE TABLE features (
  id            TEXT PRIMARY KEY,        -- branch name (or "unassigned")
  name          TEXT NOT NULL,           -- human-friendly (renamable)
  branch        TEXT,                    -- nullable for unassigned
  status        TEXT NOT NULL,           -- 'open' | 'done' | 'abandoned' | 'merged'
  cap_usd       REAL,                    -- nullable
  started_at    TEXT NOT NULL,
  closed_at     TEXT,
  pricing_conf  TEXT NOT NULL,           -- 'complete' | 'partial' | 'unknown'
  total_cost_usd REAL NOT NULL DEFAULT 0,
  total_input   INTEGER NOT NULL DEFAULT 0,
  total_output  INTEGER NOT NULL DEFAULT 0,
  total_cache_read  INTEGER NOT NULL DEFAULT 0,
  total_cache_write INTEGER NOT NULL DEFAULT 0,
  turn_count    INTEGER NOT NULL DEFAULT 0,
  first_activity_at TEXT,
  last_activity_at  TEXT
);

CREATE TABLE messages (
  id            TEXT PRIMARY KEY,        -- session entry ID
  feature_id    TEXT NOT NULL REFERENCES features(id),
  session_id    TEXT NOT NULL,
  model         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read    INTEGER NOT NULL,
  cache_write   INTEGER NOT NULL,
  cost_usd      REAL NOT NULL,
  cost_input    REAL NOT NULL,
  cost_output   REAL NOT NULL,
  cost_cache_read  REAL NOT NULL,
  cost_cache_write REAL NOT NULL,
  cost_unknown  INTEGER NOT NULL,        -- 1 if pi gave us 0 cost on a non-zero token message
  timestamp     TEXT NOT NULL,
  branch_path   TEXT
);

CREATE TABLE tags (
  feature_id TEXT NOT NULL REFERENCES features(id),
  tag        TEXT NOT NULL,
  PRIMARY KEY (feature_id, tag)
);

CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id TEXT NOT NULL REFERENCES features(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL REFERENCES features(id),
  cwd        TEXT NOT NULL,
  started_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE INDEX idx_messages_feature ON messages(feature_id);
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_features_status ON features(status);
```

**Writes** happen in two places:
- **Hot path (in-session):** on each `message_end`, insert the message row and recompute feature totals. Single-row transactions, fast.
- **Cold path (session reload):** on session start, scan `sessionManager.getBranch()` for any messages we haven't yet recorded. Idempotent on `messages.id`.

**Reads** are entirely server-side: the Bun server opens the DB read-only.

---

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  pi (Node)                                                  │
│  └── costlens extension (Node, TypeScript)                  │
│      ├── hooks: message_end, session_start, agent_end       │
│      ├── commands: /feature ...                             │
│      ├── footer: status bar renderer                        │
│      ├── writes: SQLite (~/.pi/costlens/ledger.db)          │
│      └── spawns: Bun dashboard server on demand             │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  costlens-server (Bun)                               │    │
│  │  ├── HTTP server on localhost:7331                   │    │
│  │  ├── reads: SQLite (read-only)                       │    │
│  │  ├── serves: static HTML/JS/CSS + JSON API           │    │
│  │  └── on shutdown: closes DB cleanly                  │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                  │
│                          ▼                                  │
│                    ┌──────────┐                             │
│                    │  Browser │                             │
│                    └──────────┘                             │
└─────────────────────────────────────────────────────────────┘
```

**Why two processes:**
- Extension needs to live inside pi's Node runtime to hook events.
- Server benefits from Bun's fast TS/JSX startup, native SQLite, built-in `Bun.serve()`.
- Clean lifecycle: server is a child of extension, dies with pi (unless detached).

---

## 5. File structure

```
costlens/
├── README.md
├── PLAN.md
├── package.json              # name: costlens
├── tsconfig.json
├── extension/                # runs in pi (Node)
│   ├── index.ts              # entry: register hooks + commands
│   ├── lifecycle.ts          # feature start/close/cancel/merge
│   ├── hooks.ts              # message_end, session_start handlers
│   ├── db.ts                 # better-sqlite3 wrapper, schema migrations
│   ├── footer.ts             # status bar renderer
│   ├── commands.ts           # /feature command implementations
│   ├── git.ts                # branch detection
│   └── pricing.ts            # confidence calc
├── server/                   # runs in Bun (Phase 4)
│   ├── index.ts
│   ├── db.ts
│   ├── api.ts
│   └── web/                  # static assets
└── test/                     # smoke tests
```

---

## 6. Implementation phases

1. **Phase 1 — Skeleton + DB** ✅: extension registers, creates the SQLite schema, hooks `message_end`, writes one message row.
2. **Phase 2 — Feature lifecycle** ✅: Y/n prompt for fresh branches, close/cancel/rename/set-cap/reopen, multi-session continuity, footer with cap marker. Closed features on a branch do NOT auto-resume; `/feature reopen` is explicit.
3. **Phase 3 — Footer polish** ✅: ANSI colour in footer (green / yellow / bright-yellow / red by cap ratio), testable `formatFooterText`, text-marker fallbacks for terminals that strip ANSI, grouped help text.
4. **Phase 4 — Dashboard v1** ✅: Bun server (port 7331), overview + feature-detail pages, uPlot charts, port config, detach mode, browser auto-open, real-time costlens dogfooded to 0.4.0 over 86 turns / $0.47.
5. **Phase 5 — Polish** ✅: tags, notes, merge, search, export, dashboard tag chips, search box. Costlens dogfooded to 0.5.0 over 119 turns / $0.95.
6. **Phase 6 — Notifications & digest** ✅: native OS notifications on cap thresholds (50/80/100/110%), in-memory debounce, optional webhook (Slack-compatible), daily digest at session_start. Costlens dogfooded on `feat/phase-6-notifications`.
7. **Phase 7 — Sub-agent cost attribution**: track cost of `Agent` tool invocations (Explore, Plan, general-purpose, etc.), per-tool cost analysis, latency. The "hard" deferred item.
8. **Phase 8 — Packaging & publish**: `npm publish`, install script, public landing page, launch post. The "ship it" phase.

---

## 7. Explicitly deferred to v2

- Cost by sub-agent (now in Phase 7)
- Latency / tokens-per-second / "model performance" comparison (now in Phase 7)
- Per-tool cost analysis (now in Phase 7)
- Custom pricing overrides
- Sync across machines / team mode
- Cross-session budget periods (e.g., "monthly budget")
- Native OS notifications for cap hits (now in Phase 6)

---

## 8. Pricing & data integrity (decisions)

- **Trust pi's pre-calculated `usage.cost` as the source of truth.** No manual recompute. Numbers match pi's own UI.
- **Pricing confidence flag** per feature: `complete` / `partial` / `unknown`, surfaced on dashboard with a badge.
- **Per-message `model` and `cost` are recorded as-is.** No retroactive repricing.
- **No user-override of pricing in v1.** Trust pi, add overrides in v2 if needed.
- **Tool calls** don't get a cost line in v1 (they don't hit the LLM). Tool-call counts are recorded for context.
- **Compaction** is just a normal assistant turn — costed as usual.

---

## 9. Edge cases

- **Session on `main`** → unassigned pool, footer hidden.
- **Detached HEAD / no git** → unassigned pool, footer hidden.
- **Branch mid-session change** → for v1, the feature is set at session start. Polling for branch changes is a v2 add.
- **Multi-branch session tree (`/tree`)** → only the current branch's messages are booked (matches pi's own view). We never double-book.
- **pi crashes** → cost already persisted on every `message_end`. The next session can replay missing messages.
- **Errored/aborted LLM calls** → still billed (tokens were burned). Not filtered out.
- **Cache reads/writes** → tracked separately with their own pricing.
- **Thinking/reasoning tokens** → included in `output` by pi's cost calc, no special handling.
