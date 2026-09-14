# Changelog

All notable changes to `pi-costlens` are documented here. The format
is loosely based on [Keep a Changelog](https://keepachangelog.com/);
this project is single-author and dogfood-driven, so the cadence is
"cut a release when there's something worth shipping" rather than
"every N weeks".

Versions prior to 2.0.0 were tracked via the [Phase plans](./PLAN.md)
and the per-phase docs (`PHASE4.md` through `PHASE7.5.md`). The
pre-2.0.0 line is summarised below; the 2.0.0 cut is the first
release documented in this file.

## [Unreleased]

### Added
- **`@costlens/cli` — standalone `costlens` CLI** (was a v2 non-goal in
  MULTI-TOOL.md; shipped early because the `wi` work-item factory needs a
  query surface). Two commands over `@costlens/core`, no pi/opencode runtime
  dependency:
  - `costlens feature <branch> [--json]` — per-feature (git-branch) cost
    report: total, tokens, byModel, bySource, status/cap. `--json` is what
    `wi cost` consumes.
  - `costlens ingest-ccusage --feature <branch> --session <uuid> [--source <tag>] [--dry-run]`
    — batch-ingest one ccusage session into the ledger, booked to the branch.
    ccusage is a multi-agent reader (claude, codex, gemini, …), so `--source`
    tags the rows (default `claude-code`; e.g. `codex`). Idempotent
    (deterministic `ccusage:<session>:<model>` row ids → INSERT OR REPLACE).
    Lands cost for agents without a live adapter into the unified ledger
    without a watcher (the live watchers stay v2).
- **Standing project → feature mapping, and `costlens claim`** — fixes the
  global `unassigned` pool. Every session on a trunk branch (`main`,
  `develop`, detached HEAD, no-git) was booked to one shared feature, so
  per-project totals were indistinguishable (one real ledger: wopr $10.58
  + receiptScanner $6.85 + FirstAgent $2.56 read as a single $23.83 pool).
  - `CostlensConfig.projects` — a `cwd → feature id` map in
    `config.json`. Consulted **only** when git resolution would land on
    `unassigned`, so feature branches keep their per-branch granularity.
    Longest prefix wins, matched on a path boundary (`/a/b` covers
    `/a/b/worktrees/w1`, never `/a/bc`). A mapped feature is created
    without the "start a feature?" prompt (the mapping is already a
    decision); a closed mapped feature is not auto-resumed.
  - `costlens claim --cwd <path> --feature <id> [--from <feature>] [--dry-run] [--map] [--json]`
    — re-attributes every session that ran in `<path>` (or below it) onto
    the named feature, carrying its `subagent_runs` and `tool_calls` and
    repointing `sessions.feature_id`, then repairs both features' cached
    totals from `messages` (the source of truth). `--map` persists the
    standing mapping in the same run. Idempotent; never touches rows
    already on a named feature unless `--from` says so.
  - `@costlens/core` gains `projectFeatureFor()` and
    `recomputeFeatureTotals()` (the totals-repair primitive).

### Fixed
- **Dashboard feature detail page was dead** (`/feature/<id>` rendered every
  field as its static default — `$0.00`, `0`, `—` — so clicking a row looked
  like "nothing happens"). `packages/core/src/server/web/feature.js` could not
  parse, for two reasons committed during the phase-7 × phase-7.5 merge
  (`c4e87c4`, 2026-07-06): the conflict hunks were committed **with their
  markers**, and one constructor used TypeScript parameter properties
  (`constructor(public code, message, public status)`) in a plain `.js` asset.
  The browser discarded the whole script, so `load()`/`render()` never ran —
  while the overview page, which uses a different file, stayed healthy.
  - Resolved the hunk as the union both sides intended (HEAD's
    `renderSubagents`/`renderTools` + the branch's actions block — `render()`
    calls all three) and wrote the constructor as plain JS.
  - New guard `packages/core/src/server/web-assets.test.ts`: every dashboard
    asset must compile under `node:vm`, and no asset may carry conflict
    markers. Nothing else in the suite touched these files, which is how this
    survived two months.

## [2.0.0] — 2026-07-08

The multi-tool refactor ([MULTI-TOOL.md](./MULTI-TOOL.md)). The
extension is now a thin adapter over the new `@costlens/core`
package. The data plane (SQLite schema, lifecycle, search, export,
the Bun dashboard server) lives in core. This unlocks the
opencode-costlens and (future) claude-costlens adapters without
duplicating code.

### What changed for users

- **Data directory moved**: `~/.pi/costlens/` → `~/.costlens/`.
  The migration is lazy and runs on the first `session_start`
  after upgrade. Existing data is renamed into the new home
  atomically; a `.migrated-from-pi` flag file is written so the
  migration is one-shot.
- **Dashboard "Welcome to v2" banner** appears once per browser
  after the migration. Dismissable; the dismissal is stored in
  `localStorage`.
- **No other user-visible changes.** Same features, same
  commands, same dashboard, same data, same extension entry
  point. Pre-2.0.0 users upgrade in place and don't lose any
  settings or history.

### What changed for the package itself

- The repo is now a pnpm monorepo. The extension lives in
  `packages/pi/`; the data plane lives in `packages/core/`.
- `pi-costlens` depends on `@costlens/core` as a regular
  dependency (`^0.1.0`).
- The 1300+ lines of `extension/lifecycle.ts` + `server/db.ts` +
  `server/lifecycle.ts` + `server/api.ts` + `server/index.ts` are
  now in `@costlens/core`. Both writes that were duplicated
  (extension's lifecycle.ts and server's lifecycle.ts) are
  consolidated into a single canonical implementation.
- `server/` no longer ships in the published tarball; the
  dashboard server is loaded from `packages/core/src/server/`
  by the extension's `startServer` helper.

### What's next

- `opencode-costlens@0.1.0` ships in step 7 of MULTI-TOOL.md,
  reusing all of `@costlens/core` and reading/writing the same
  SQLite ledger.
- `claude-costlens@0.1.0` (v2) follows once opencode v1.0 is
  dogfooded.

## Pre-2.0.0

| Version | Phase | Highlights |
|---|---|---|
| 0.7.0 | 7, 7.5 | Sub-agent + per-tool cost attribution, dashboard actions (close/cancel/merge/reopen/cap/tags/notes) |
| 0.6.0 | 6 | Cap-threshold notifications, webhook, daily digest |
| 0.5.0 | 5 | Tags, notes, merge status, search, export |
| 0.4.0 | 4 | Dashboard server, port selection, browser spawn |
| 0.3.0 | 3 | — |
| 0.2.0 | 2 | Lifecycle (close/cancel/rename/cap/reopen), Y/n prompt, footer |
| 0.1.0 | 1 | SQLite ledger, assistant-message cost capture, basic footer |
