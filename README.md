# Costlens

A pi extension that books the real dollar cost of every assistant message to a **feature** (a git branch you're working on), with a local web dashboard for stats — and the command surface to tag, search, note, export, and be **notified** when you cross a cap.

> **Status: Phase 6 (notifications) — shipped.** Native OS notifications on cap hits, daily digest, optional webhook. See [PHASE6.md](./PHASE6.md) for the latest phase plan and [PLAN.md](./PLAN.md) for the overall roadmap.

## What it does

- Registers as a pi extension
- On every assistant message, writes the token usage + dollar cost to `~/.pi/costlens/ledger.db` (SQLite, WAL mode)
- Groups costs by feature (= git branch; `main` / `master` / `develop` / `dev` / detached HEAD / no-git go to an `unassigned` pool)
- On a fresh branch, prompts once: "Start a feature for `branch`? [Y/n]"
- Closes / cancels / merges preserve the cost; reopen via `/feature reopen`
- Renders an ANSI-coloured status footer (green at <50% of cap, yellow at 50–80%, bright yellow at 80–100%, red above) with text fallbacks (`! near cap`, `✗ over cap by $X.XX`)
- Computes a `pricing_confidence` per feature (`complete` / `partial` / `unknown`)
- Tags (free-form, lowercased on save) for categorisation
- Standalone notes (timestamped) attach to a feature without closing it
- A `merge` status for branches merged but where the feature work is still ongoing
- `search` to find features by id/name fragment
- `export` to dump the ledger (CSV / JSON) for accounting or backup
- A Bun-served local web dashboard with overview, per-feature drill-down, tag chips, a search box, and uPlot charts
- **Native OS notifications** when a feature's cost crosses 50% / 80% / 100% / 110% of its cap (each threshold fires once per feature per session)
- **Optional webhook** (Slack/Discord incoming webhook, or any HTTP POST) on threshold crossings
- **Daily digest** at session_start: one-line summary of yesterday's spend above a configurable USD threshold

## Install (dev)

Costlens is a pi extension. For development, point pi at the local extension folder.

### Option A — symlink (recommended for dev)

```bash
cd ~/Develop/costlens
npm install
ln -s ~/Develop/costlens/extension ~/.pi/agent/extensions/costlens
```

Then restart pi, or run `/reload` inside pi to hot-reload extensions.

### Option B — settings.json entry

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/Users/leo.gutierrez/Develop/costlens/extension"]
}
```

> Note: this loads via the `--extension` style — full hot-reload only works with Option A (auto-discovered location).

The dashboard server is a separate Bun process; it spawns on demand via `/feature dashboard`. Bun must be on `PATH`.

## Verify

1. Start pi on a non-main branch and confirm the feature prompt.
2. Send a few prompts. The footer should be green (cost is well under any cap you set).
3. Try `/feature set-cap 0.10` and run more prompts. Watch the colour change:
   - Green → yellow at 50% (≈ $0.05)
   - Yellow → bright yellow at 80% (≈ $0.08)
   - Bright yellow → red above 100% (over $0.10), marker changes to `✗ over cap by $X.XX`
4. If pi's TUI strips the ANSI codes, you'll still see the text markers (`! near cap`, `✗ over cap`).
5. Tag the feature: `/feature tag add client:acme`. See it in `/feature list` and on the dashboard.
6. Attach a note: `/feature note handed off to Jane`. See it in `/feature status` and the dashboard.
7. Run `/feature dashboard` to open the local web UI at `http://localhost:7331/`.
8. Try `/feature search auth` and `/feature export json` for a quick dump.

## Commands

| Command | What it does |
|---|---|
| `/feature help` | List available subcommands (grouped) |
| `/feature status` | Current feature detail (cost, cap, model breakdown, tags, notes) |
| `/feature list` | All features (name, status, tags, cost, last activity) |
| `/feature search <query>` | Find features by id/name fragment (case-insensitive) |
| `/feature close [note]` | Mark current feature done, freeze cost |
| `/feature cancel [note]` | Mark current feature abandoned, freeze cost |
| `/feature merge [note]` | Mark current feature merged, freeze cost (third "ended" state) |
| `/feature reopen` | Re-open a closed / cancelled / merged feature |
| `/feature rename <name>` | Rename current feature (id stays) |
| `/feature set-cap <usd>` | Set soft cap (0 to clear) |
| `/feature note <text>` | Attach a timestamped note without closing the feature |
| `/feature tag add <t>` | Tag the current feature (free-form, lowercased on save) |
| `/feature tag remove <t>` | Remove a tag |
| `/feature tag list` | List tags on the current feature |
| `/feature export json` | Dump the full ledger as JSON to stdout |
| `/feature export csv` | Dump the full ledger as CSV (5 sections) to stdout |
| `/feature notify-test` | Fire a test notification (in-pi + native) |
| `/feature notify-config` | Print current notification config |
| `/feature notify-config on\|off` | Master switch |
| `/feature notify-config webhook <url>\|clear` | Set or clear the webhook URL |
| `/feature notify-config daily-digest on\|off` | Toggle the daily digest |
| `/feature notify-config daily-threshold <usd>` | Set the digest threshold |
| `/feature notify-config thresholds <list>` | Override thresholds (e.g. `0.5,0.8,1.0,1.1`) |
| `/feature dashboard` | Start server + open browser to overview |
| `/feature dashboard --detach` | Start server that survives pi exit |
| `/feature dashboard stop` | Kill the running server |
| `/feature open <name>` | Open feature detail page |
| `/feature set-port <N>` | Set the dashboard port (1..65535) |

### Examples

```bash
/feature tag add client:acme
/feature tag add v1
/feature note handed off to jane, she'll take it from here
/feature merge
/feature export json > backup-$(date +%Y%m%d).json
/feature export csv  | less
/feature search auth
/feature rename "Auth refactor"
/feature set-cap 5
/feature set-cap 0          # clear the cap
/feature dashboard
```

## Data model

`~/.pi/costlens/ledger.db` — a single SQLite file in WAL mode, shared between the extension (writes) and the dashboard server (reads). The extension uses Node's built-in `node:sqlite`; the server uses `bun:sqlite` (readonly). Schema:

- `features` — one row per feature (id is the branch name, or `unassigned`)
- `messages` — one row per assistant message, with token + cost breakdown
- `notes` — timestamped notes attached to a feature
- `tags` — `(feature_id, tag)` pairs
- `sessions` — session file → feature mapping for resume

Closed features (`done`, `abandoned`, `merged`) freeze cost. `merged` is semantically distinct from `done` (work completed) and `abandoned` (work dropped): the branch was merged into the trunk, but feature work may continue — `/feature reopen` works the same way for all three terminal states.

## API

The dashboard server exposes a small JSON API on `http://localhost:<port>`:

| Route | Response |
|---|---|
| `GET /api/health` | `{ ok, version, startedAt, port }` |
| `GET /api/overview` | Aggregates (totals, top features, by-day, by-model, by-status) |
| `GET /api/features` | Full feature list, or `?q=<query>` for substring search |
| `GET /api/features/:id` | Feature detail + notes + tags + recent models |
| `GET /api/features/:id/messages?since=&limit=` | Messages for a feature |
| `GET /api/features/:id/tags` | The feature's tags |
| `GET /api/features/:id/notes` | The feature's notes |
| `GET /api/tags` | All unique tags across the ledger with counts |
| `GET /api/export.json` | Full ledger as JSON |
| `GET /api/export.csv` | Full ledger as CSV (download) |

## Footer colour scheme

| Cost vs cap | Colour | Marker |
|---|---|---|
| no cap | default | (none) |
| < 50% | green | (none) |
| 50–80% | yellow | (none) |
| 80–100% | bright yellow | `! 80% of $X cap` |
| > 100% | bright red | `✗ over cap by $X.XX` |

Text markers are always present, even if pi's TUI strips ANSI — you can always tell the level from a glance.

## Notifications (Phase 6)

When a feature's cost crosses 50% / 80% / 100% / 110% of its cap, you get a native OS notification (macOS Notification Center, Linux `notify-send`, Windows BurntToast) plus an in-pi banner. Each threshold fires at most once per feature per session; `reopen` re-arms the debounce.

Platform commands are best-effort with a 1.5s timeout — if the OS notifier isn't available, the in-pi path still works. The native call never throws.

### Configuration

`~/.pi/costlens/config.json` gains an optional `notifications` block:

```json
{
  "port": 7331,
  "notifications": {
    "enabled": true,
    "thresholds": [0.5, 0.8, 1.0, 1.1],
    "webhook": null,
    "dailyDigest": true,
    "dailyDigestThresholdUsd": 0.5
  }
}
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `true` | Master switch |
| `thresholds` | number[] | `[0.5, 0.8, 1.0, 1.1]` | Ratios that fire (0.5 = 50% of cap) |
| `webhook` | string \| null | `null` | URL to POST on threshold crossing (Slack-compatible) |
| `dailyDigest` | bool | `true` | Show yesterday's spend on session_start |
| `dailyDigestThresholdUsd` | number | `0.5` | Only mention features above this $ |

### Webhook payload

A Slack-compatible shape (so it just works as a Slack incoming webhook):

```json
{
  "text": "🚨 *feat/phase-6-notifications* hit 80% of $5.00 cap — $4.00 / $5.00",
  "feature": "feat/phase-6-notifications",
  "threshold": 0.8,
  "cost": 4.0,
  "cap": 5.0,
  "level": "warn"
}
```

POSTed as JSON, 2s timeout, fire-and-forget. The webhook URL must start with `http://` or `https://`. Failures are logged to stderr; they never crash the extension.

### Daily digest

On every `session_start`, if any feature spent more than `dailyDigestThresholdUsd` yesterday (UTC), costlens shows a one-line summary in pi:

```
Costlens — yesterday (2026-07-02): $4.23 across 12 turns
  feat/phase-6-notifications      $2.50  (7 turns)
  feat/phase-5-polish             $1.73  (5 turns)
```

The digest also fires the native notifier, so you'll see it as a banner even when you're not in the pi TUI.

## Export format

**JSON** is a single object:
```json
{
  "exportedAt": "2026-07-03T16:00:00.000Z",
  "features":  [ /* Feature[] */ ],
  "messages":  [ /* Message[] */ ],
  "notes":     [ /* Note[] */ ],
  "tags":      [ /* { feature_id, tag }[] */ ],
  "sessions":  [ /* Session[] */ ]
}
```

**CSV** has five sections, separated by blank lines, with a `# <name>` marker line, then a header row, then data rows. Pipe to a file with `> backup.csv`. Sections: `features`, `messages`, `notes`, `tags`, `sessions`.

## Rollback

Costlens is additive across all five phases. To wipe tags / notes without touching features / messages:

```sql
DELETE FROM tags;
DELETE FROM notes;
```

To forget a detached dashboard server, remove `~/.pi/costlens/server.pid`. To fully reset, remove `~/.pi/costlens/`.

## Layout

```
costlens/
├── extension/         # runs in pi (Node, loaded via jiti)
│   ├── index.ts       # entry
│   ├── db.ts          # SQLite schema + queries (Node)
│   ├── hooks.ts       # message_end handler (+ threshold notify on cost update)
│   ├── lifecycle.ts   # feature creation/lookup/merge/tags/notes/search/export
│   ├── git.ts         # branch detection
│   ├── commands.ts    # /feature <subcommand>
│   ├── pricing.ts     # confidence calc
│   ├── footer.ts      # status bar
│   ├── server.ts      # dashboard server lifecycle (spawn / kill)
│   ├── config.ts      # ~/.pi/costlens/config.json (+ notifications block)
│   └── notifications.ts  # native notif + webhook + debounce + daily digest
├── server/            # runs in Bun (dashboard)
│   ├── index.ts       # Bun.serve() entry
│   ├── db.ts          # bun:sqlite (read-only) + export helpers
│   ├── api.ts         # JSON handlers
│   ├── config.ts      # reads config.json
│   ├── port.ts        # find a free port in 7331..7399
│   └── web/
│       ├── index.html
│       ├── feature.html
│       ├── style.css
│       ├── overview.js
│       ├── feature.js
│       └── vendor/
│           └── uplot.iife.min.js
├── test/
│   ├── extension.test.ts     # extension smoke
│   ├── footer.test.ts        # footer formatter
│   ├── lifecycle.test.ts     # DB + lifecycle (Node)
│   ├── notifications.test.ts # Phase 6: notif, webhook, digest
│   └── server.test.ts        # server queries + API (Bun)
├── package.json
├── tsconfig.json
├── PLAN.md
├── PHASE5.md
├── PHASE6.md
└── README.md
```

## Tests

```bash
# Extension (Node)
npm test

# Server (Bun)
bun test test/server.test.ts
```

Current: **98 extension tests + 39 server tests**, all green.

## License

MIT.
