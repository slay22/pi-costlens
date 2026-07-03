# Phase 5 — Polish

Tagging, notes (standalone), merge, search, export, and a few quality-of-life bits. Brings the costlens extension from "tracks and displays" to "manages".

**Status:** not started. Dogfood target: branch `feat/phase-5-polish`.

---

## 1. Goals

- Tag features for categorization (client, project, type) — useful for filtering and reporting
- Standalone notes that don't require closing a feature
- `merge` status for branches merged but where the feature work is still ongoing
- `search` to find features by name fragment
- `export` to dump the ledger (CSV / JSON) for accounting or backup
- Pricing confidence badge in the status command (already in the dashboard)
- Final README + packaging notes

## 2. Non-goals (deferred past Phase 5)

- WebSocket real-time updates
- Sub-agent cost attribution
- Per-tool cost analysis
- Custom pricing overrides
- Sync across machines / team mode
- Native OS notifications for cap hits
- Multi-language UI

## 3. Architecture

No new components. Everything lives in:
- `extension/lifecycle.ts` — new data functions
- `extension/commands.ts` — new subcommand handlers
- `server/db.ts` / `server/api.ts` — read endpoints for tags + notes (the dashboard wants to show them, which it does already)
- `server/web/{index,feature}.html` + `*.js` — UI for tags / notes / search
- `server/web/style.css` — tag pills
- `README.md` — final docs

The schema is already in place: `tags(feature_id, tag)`, `notes(feature_id, body, created_at)`, and the `features.status` enum already includes `'merged'`. No migrations needed.

## 4. Files

```
costlens/
├── extension/
│   ├── lifecycle.ts                MODIFIED — addTag, removeTag, listTags, listNotes,
│   │                                         attachNote already exists; searchFeatures,
│   │                                         exportFeatures
│   ├── commands.ts                 MODIFIED — /feature tag add/remove/list,
│   │                                         /feature note, /feature merge,
│   │                                         /feature search, /feature export
│   └── index.ts                    UNCHANGED
├── server/
│   ├── db.ts                       MODIFIED — getTagsForFeature already exists;
│   │                                         add searchFeatures, exportToJSON, exportToCSV
│   ├── api.ts                      MODIFIED — optional /api/features?q=<query> for search
│   └── web/
│       ├── index.html              MODIFIED — tag column in top features, search box
│       ├── feature.html            MODIFIED — tag chips, notes editor, search filter
│       ├── overview.js             MODIFIED — search box, tag rendering
│       ├── feature.js              MODIFIED — tag rendering, note add (optional)
│       └── style.css               MODIFIED — tag pill, search input
├── test/
│   └── lifecycle.test.ts           MODIFIED — add tests for tag/note/merge/search/export
├── package.json                    UNCHANGED
├── README.md                       REWRITTEN — final user-facing docs
└── PHASE5.md                       this file
```

## 5. Command surface (additions to `/feature`)

| Command | Behaviour |
|---|---|
| `/feature tag add <tag>` | Add a tag to the current feature. Tags are free-form, lowercased on save. |
| `/feature tag remove <tag>` | Remove a tag from the current feature. |
| `/feature tag list` | List all tags on the current feature. (Or all features with that tag, TBD.) |
| `/feature note <text>` | Attach a note to the current feature without closing it. Notes are timestamped. |
| `/feature merge` | Mark the current feature as `merged`. Sets `closed_at` to now, status to `merged`. Like close but signals "the branch was merged; feature work may continue." |
| `/feature search <query>` | Find features whose id or name contains `<query>` (case-insensitive). Show name, status, cost, last activity. |
| `/feature export csv` | Dump all features + messages + notes to CSV (one file per table, to stdout). |
| `/feature export json` | Dump the whole ledger to a single JSON document (stdout). |

`/feature list` also gets: tag column, sort by tag.

## 6. Status enum

No schema change. The `status` column already accepts `'open' | 'done' | 'abandoned' | 'merged'`. The new `/feature merge` command writes `'merged'`. Closed features (`done`, `abandoned`, `merged`) all freeze cost; `merged` is a third "ended but cost preserved" state, semantically distinct from `done` (work completed) and `abandoned` (work dropped).

Lifecycle:
- `open` → `done` via `/feature close`
- `open` → `abandoned` via `/feature cancel`
- `open` → `merged` via `/feature merge` *(new)*
- `done` / `abandoned` / `merged` → `open` via `/feature reopen` (already works)

## 7. Data model notes

**Tags:**
```sql
CREATE TABLE tags (
  feature_id TEXT NOT NULL REFERENCES features(id),
  tag        TEXT NOT NULL,
  PRIMARY KEY (feature_id, tag)
);
```
Already exists. New helpers: `addTag(featureId, tag)`, `removeTag(featureId, tag)`, `listTags(featureId)`, `listAllTags()`.

Tags are lowercased and trimmed on save. No validation beyond that (free-form is more useful than forcing a taxonomy in v1).

**Notes:**
```sql
CREATE TABLE notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id TEXT NOT NULL REFERENCES features(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```
Already exists. `attachNote(featureId, body)` already exists. Add `listNotes(featureId)` (already exists too — verify) and `/feature note <text>` command.

**Search:**
Case-insensitive substring match on `id` and `name`. Implemented in SQL: `WHERE LOWER(id) LIKE ? OR LOWER(name) LIKE ?` with `%query%`.

**Export:**
- **JSON:** one object with `{ exportedAt, features, messages, notes, tags, sessions }`. Each table as an array.
- **CSV:** three sections (one per table) with a header line and rows. Output to stdout. Useful for piping to a file or another tool.

## 8. API additions

| Route | Method | Response |
|---|---|---|
| `GET /api/features?q=<query>` | GET | Same as `/api/features` but filtered by `q` (substring on id/name). |
| `GET /api/features/:id/tags` | GET | `string[]` — the feature's tags. (Already in the feature detail response, but having a dedicated route lets the dashboard refresh tags without re-fetching the whole feature.) |
| `GET /api/features/:id/notes` | GET | `Note[]` — the feature's notes. (Same — already in feature detail.) |
| `GET /api/export.json` | GET | Full ledger as JSON (same shape as `/feature export json`). |
| `GET /api/export.csv` | GET | CSV bundle (text/csv). |

These are read-only and read straight from the existing tables. No new server-side state.

## 9. UI changes (dashboard)

**Overview page:**
- Search box at the top (filters the top-features table client-side; also shows search count).
- Tag column in the top-features table (chips). Empty cells show `—`.

**Feature detail page:**
- Tag row: chip per tag, with a `+` to add a new tag (optional; can defer to command-only for v1).
- Notes section: list of notes with timestamps; a small form to add a note (optional; defer to command-only).
- Search/filter for the messages table: text input that filters by model name or session id (nice-to-have, defer if scope creeps).

**Polish (CSS):**
- `.tag` class: small rounded pill, neutral background, mono font for tag text.
- `.tag.client`, `.tag.project`, `.tag.type` color hints (optional, namespace-based).

## 10. Tests

`test/lifecycle.test.ts` — extend with:
- `addTag` / `removeTag` / `listTags` / `listAllTags` round-trip
- `attachNote` already tested; add `listNotes` test
- `mergeFeature` sets status=merged, closed_at
- `searchFeatures` substring match (case-insensitive)
- Tag deduplication (adding the same tag twice is a no-op)
- Removing a non-existent tag is a no-op (no error)
- Export helpers return valid JSON / parseable CSV (smoke)

`bun test test/server.test.ts` — extend with:
- `GET /api/features?q=foo` filters correctly
- `GET /api/export.json` returns valid JSON with all tables

## 11. Implementation order

Each step dogfoodable.

1. **`/feature merge`** — single command + lifecycle fn. Verify: rename feature, mark done, mark abandoned, mark merged, reopen. All transitions work.
2. **`/feature tag add|remove|list`** — lifecycle fns + command. Verify: tags persist in DB, show in `/feature status`, removed on `remove`.
3. **`/feature note <text>`** — uses existing `attachNote`. Verify: note appears in feature detail page, multiple notes stack.
4. **`/feature search <q>`** — case-insensitive LIKE query. Verify: matches id and name, no match returns empty.
5. **`/feature export csv|json`** — output to stdout. Verify: parseable JSON, valid CSV.
6. **Dashboard UI** — tag chips on overview + feature page. Search box on overview.
7. **API additions** — `/api/features?q=`, `/api/export.json`, `/api/export.csv`.
8. **README rewrite** — final user-facing docs, install, commands, screenshots, architecture.

## 12. Decisions worth flagging

1. **No tag taxonomy.** Free-form strings. Lowercased on save. If the user wants `client:acme` or `project:web`, they type it that way. We could enforce a `prefix:value` format but that constrains too early.
2. **No tag-on-attach.** Adding a tag requires `/feature tag add`. No `+` button in the dashboard in v1. Keeps the server stateless.
3. **Search is read-only.** Searches hit the DB, no caching. For 10s-100s of features, that's fine.
4. **Export is to stdout, not a file.** The user pipes `> backup.json` if they want a file. No file dialog, no path handling. Simple.
5. **Merge doesn't re-open branches.** `/feature merge` is a status transition, not a git operation. We don't `git checkout` or `git merge` — the user already did that in their real workflow.
6. **Reopen from merged works.** Same as reopen from done/abandoned — cost continues to accumulate under the same id.

## 13. Dogfooding plan

You're on `feat/phase-5-polish` (newly created from `feat/phase-4-dashboard` at commit `91e079f`).

- Set cap: `/feature set-cap 0.50` (keep the visual feedback tight)
- After step 1: test `merge` on a scratch feature
- After step 2: add 2-3 tags to your features, see them on the dashboard
- After step 5: run `/feature export json` and inspect the output
- After step 6: open the dashboard, see the tag chips and search
- After step 8: README is the new user-facing entry point
- Close: `/feature close polish shipped` (or whatever note)

## 14. Rollback

Phase 5 is additive. Tags and notes are in their own tables, so dropping them doesn't touch `features` or `messages`. The new commands are isolated subcommands. If something breaks, `/feature <subcommand>` just errors. The whole feature can be disabled by removing `/feature tag`, `/feature note`, `/feature merge`, `/feature search`, `/feature export` from the dispatcher in `commands.ts`.

To wipe tags / notes without touching features / messages:
```sql
DELETE FROM tags;
DELETE FROM notes;
```
