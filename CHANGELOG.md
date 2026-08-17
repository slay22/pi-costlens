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
  - `costlens ingest-ccusage --feature <branch> --session <uuid> [--dry-run]`
    — batch-ingest one Claude Code session (via ccusage) into the ledger,
    booked to the branch, tagged `source=claude-code`. Idempotent
    (deterministic `ccusage:<session>:<model>` row ids → INSERT OR REPLACE).
    Lands Claude cost in the unified ledger without the live watcher (that
    stays the claude-costlens v2 adapter).

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
