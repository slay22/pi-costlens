# Phase 9 — Multi-tool expansion

Make costlens a tool-agnostic cost layer. pi stays supported; opencode and Claude Code get the same experience. The data layer becomes the core; each tool ships a thin adapter. The dashboard already works for all of them.

**Status:** not started. Dogfood target: branch `feat/phase-9-multi-tool` (this branch).

---

## 1. Why this phase exists

Today, costlens is a single repo with `extension/` (pi-coupled) and `server/` (tool-agnostic). The pi extension is published on npm. There are users who only run opencode — they want cost visibility too. The architecture is already 80% tool-agnostic; this phase finishes the job and ships opencode support.

The dashboard, the DB schema, the lifecycle (close/cancel/merge/reopen/tags/notes), the export logic — all of that doesn't care what tool produced the data. It just reads and writes SQLite. The only pi-specific code is the extension entry point, the hooks (`session_start` / `message_end`), the command registration, the `ctx.ui` notifications, and the `setStatus` footer.

Refactor the code into a monorepo: a shared `@costlens/core` plus three adapters (`pi-costlens`, `opencode-costlens`, `claude-costlens`). Existing pi users see no functional change. New opencode users get the same dashboard. Future Claude Code users get the same thing.

## 2. Goals

- **Tool-agnostic cost layer.** The dashboard reads `~/.costlens/` and shows whatever tools wrote there. The user sees a single unified view across pi, opencode, and (v2) Claude Code sessions.
- **`opencode-costlens` v1.0 ships.** Capture, footer in opencode's status bar, dashboard spawn on demand. Same feature surface as pi for those three things.
- **Zero-friction migration for existing `pi-costlens` users.** The `pi-costlens` npm package stays; its internals become a thin adapter over `@costlens/core`. Data migrates from `~/.pi/costlens/` to `~/.costlens/` lazily on first read.
- **Claude Code in v2.** Watcher-based adapter. Same dashboard, same DB.
- **Independent package versioning** so core can ship a bugfix without bumping the opencode adapter to 0.1.4.

## 3. Non-goals (explicitly deferred)

- **Per-tool sub-agent cost attribution** for v1.0. Sub-agent attribution in pi uses the subagent extension's `ToolResultMessage.details`. opencode's sub-agent model is different and unknown to us. Ship in v1.8 after we have data on how opencode's sub-agents work.
- **A standalone `costlens` CLI.** Real users want it (no pi/opencode dependency, just `costlens status`), but it's a v2 thing. v1.0 dashboard works in the browser; that's enough.
- **A web-hosted "share a view" feature.** Local-only, like everything else.
- **Multi-user / sync.** Localhost per machine. Always has been.

## 4. Architecture

```
costlens/                          (monorepo, pnpm workspaces)
├── packages/
│   ├── core/                      @costlens/core
│   │   ├── src/
│   │   │   ├── db/                 schema, openDb, queries
│   │   │   ├── server/            Bun.serve(), HTML/JS, uPlot
│   │   │   ├── lifecycle.ts        close/cancel/merge/reopen/setCap/tags/notes
│   │   │   ├── config.ts           config file format + IO
│   │   │   ├── migrate.ts          one-shot data migration (pi → costlens)
│   │   │   ├── pricing.ts          pricing confidence calc
│   │   │   ├── search.ts           search features
│   │   │   ├── export.ts           CSV / JSON export
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── pi/                        pi-costlens (existing package, refactored)
│   │   ├── src/
│   │   │   ├── index.ts            extension entry — ~30 lines, calls core
│   │   │   ├── notifications.ts    native OS notif, webhook, daily digest
│   │   │   ├── server.ts           spawn/kill the dashboard
│   │   │   ├── commands.ts         /feature <subcommand>
│   │   │   ├── footer.ts           status bar
│   │   │   ├── git.ts              branch detection
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── opencode/                  opencode-costlens (NEW)
│   │   ├── src/
│   │   │   ├── index.ts            plugin entry — ~150 lines
│   │   │   ├── capture.ts          hook into opencode session events
│   │   │   ├── footer.ts          opencode status bar integration
│   │   │   ├── server.ts          spawn the dashboard (same logic as pi)
│   │   │   └── git.ts             branch detection (opencode cwd)
│   │   └── package.json
│   │
│   └── claude-code/               claude-costlens (v2, not built yet)
│       └── (placeholder)
│
├── package.json                   workspaces root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .changeset/                     changesets for version bumps
└── package.json
```

**The data plane** (in `@costlens/core`) doesn't know which tool wrote each row. It just stores `(feature_id, model, provider, input_tokens, output_tokens, cache_read, cache_write, cost_usd, timestamp, source)` and exposes read/write APIs. The "source" field is new — it tags each row with the tool that produced it (e.g., `"pi"`, `"opencode"`, `"claude-code"`). This lets the dashboard show "this cost came from opencode" if you care.

**Each adapter** is a thin shim that:
1. Hooks into its tool's event system
2. Translates that tool's events into `core.db.insertMessage(...)` calls
3. Renders the footer in the tool's UI
4. Optionally spawns the dashboard server

The costlens dashboard already exists and is tool-agnostic. It reads from the same DB, the same URL, the same port. The only thing that changes is the data source — and that's a row-level difference, not a structural one.

## 5. Packages and their relationships

```
@costlens/core         ← no deps on adapters
       ↑
       ├── pi-costlens           ← deps: @costlens/core, @earendil-works/pi-coding-agent
       ├── opencode-costlens     ← deps: @costlens/core, @opencode-ai/sdk (or whatever opencode calls it)
       └── claude-costlens       ← deps: @costlens/core, chokidar (for session file watching)
```

**Workspace-level tooling:**
- `pnpm` for package management
- `tsc` per package (each has its own `tsconfig.json` extending `tsconfig.base.json`)
- `vitest` or `node:test` per package (each picks its own)
- A single root `package.json` with workspace-wide scripts: `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm publish -r`

**Versioning: Changesets.** Each package has its own version. The `core` package's semver is the contract. Adapters declare `^X.Y.Z` peer ranges. When core breaks compat, it bumps major; adapters that use the changed API get flagged in CI.

## 6. DB location and migration

**New path: `~/.costlens/`.** Tool-agnostic, future-proof.

**Old path: `~/.pi/costlens/`.** What every existing user has today.

**Migration: lazy, with a flag file.**
- On first read of `~/.costlens/` (in `core/db.ts`'s `openDb()`):
  - If `~/.costlens/` exists → use it. Done.
  - Else if `~/.pi/costlens/` exists with data → `fs.renameSync('~/.pi/costlens', '~/.costlens')`. Write `~/.costlens/.migrated-from-pi` flag. Done.
  - Else → create `~/.costlens/` empty. Use it.
- The flag file is a one-line marker (`{ "from": "pi-costlens", "at": "<iso>" }`) so we never re-run the migration.
- A first-run notification in the dashboard footer: "Welcome to v2 — your data was migrated from ~/.pi/costlens/." Shown once, dismissable.

**Why lazy, not postinstall:** postinstall scripts are a security concern; some package managers (yarn pnp, bun) handle them differently. Lazy-on-read is universal, idempotent, and the first-message-after-upgrade slowdown is imperceptible (one fs.stat + one rename).

**No new env var.** The `COSTLENS_HOME` env var already exists from Phase 4. Users who want a custom path keep using it; the migration respects it (only checks `~/.pi/costlens/` if `COSTLENS_HOME` is unset).

## 7. The `source` field — tagging rows by tool

Currently `messages.source` doesn't exist. New schema migration adds it:

```sql
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'pi';
```

Defaults to `'pi'` so the migration is backwards-compatible — every existing row looks like it came from pi, which is correct (it did).

**Possible values:** `'pi'`, `'opencode'`, `'claude-code'`, `'manual'` (for future manual entry). Free-form string, no enum constraint — easy to add a new tool without a migration.

**Where the new field surfaces:**
- `messages` table: every row has a source. The dashboard shows it as a small badge next to the model name ("minimax-m3 · opencode" or "minimax-m3 · pi").
- `features` table: optionally a `last_source` (the source of the most recent message). The dashboard can show "current feature's last activity: pi" if you want that level of detail.
- New `/api/overview` field: `bySource: { pi: { cost, turns }, opencode: {...} }`. Lets you see "how much of my cost this month came from pi vs opencode".

For v1.0, only the `messages.source` field is implemented. The aggregate fields come in v1.5+ once we have data flowing from multiple tools and the user's curiosity about cross-tool breakdown kicks in.

## 8. `pi-costlens` v2.0 — refactored adapter

The existing pi extension moves into `packages/pi/src/`. The npm package stays `pi-costlens` (no rename, no break for users). The new structure:

```
packages/pi/
├── src/
│   ├── index.ts        ← pi extension entry, calls core
│   ├── footer.ts       ← pi-specific setStatus
│   ├── commands.ts     ← /feature <subcommand> dispatcher
│   ├── server.ts       ← spawn/kill the dashboard
│   ├── notifications.ts ← native OS notif, webhook, daily digest
│   └── git.ts          ← branch detection
└── package.json
    name: "pi-costlens"
    version: 2.0.0     ← major bump for the refactor
    dependencies: ["@costlens/core"]
    pi: { extensions: ["./src/index.ts"] }
```

**The new `src/index.ts` is ~30 lines.** It calls `@costlens/core`'s default factory, which handles session_start (with the Y/n prompt), message_end (writing the message + updating feature totals), and exports pi-specific glue (footer, commands, server spawn). The pi adapter is now a thin shim.

**What stays pi-specific:**
- `notifications.ts` (uses `child_process.execFile` for `osascript` / `notify-send` — could move to core, but it's not tool-coupled, it's OS-coupled; v1.5 decision)
- `server.ts` (spawns bun — same for all adapters, but the auto-spawn-on-session-end is pi-specific; v1.5 might extract a shared spawn helper)
- `git.ts` (uses `git rev-parse` — tool-agnostic actually, should move to core)
- `commands.ts` (the `/feature` command dispatcher — pi-specific syntax)
- `footer.ts` (uses pi's `ctx.ui.setStatus` — tool-specific)

**v1.0 keeps the structure as drawn.** v1.5 can move more into core as patterns solidify.

## 9. `opencode-costlens` v1.0

A new npm package. The opencode plugin pattern (last I checked, opencode has a plugin/extension system similar to pi but with a different API). The plugin file is the adapter entry point.

**Scope for v1.0 (chosen by the user):**
- Capture: hook opencode's session events, write `messages` rows to costlens DB
- Footer: render the costlens status line in opencode's status bar
- Dashboard spawn: optional command (similar to `/feature dashboard` in pi) to open the browser

**Scope deferred to v1.5+:**
- Notifications (cap thresholds) — v1.5
- Tags, notes, search, export (commands) — v1.6
- Close/cancel/merge/reopen from opencode commands — v1.7
- Sub-agent cost attribution — v1.8 (research opencode's sub-agent API first)

**`opencode-costlens` v1.0 size estimate:** ~200 lines of TS. The capture hook is the main work; the footer is a thin wrapper around opencode's status bar API; the dashboard spawn is reused from a shared helper (we'll factor it out in v1.5 if both adapters want it).

## 10. `claude-costlens` v2.0

Deferred. The plan: a session-file watcher. Claude Code writes JSONL session files to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. We watch the file with `chokidar`, parse new entries, extract assistant messages with usage data, write to costlens DB. Same dashboard, same DB.

**Why v2:** opencode ships first, validates the multi-tool architecture. Claude Code's session format is well-documented but has unknowns (subscription vs API key pricing, exact entry shape, etc.). Better to ship opencode v1, learn from real data, then apply to Claude Code.

**Estimated scope:** ~300 lines of TS. The watcher is the only new piece; everything else reuses core.

## 11. Implementation order

Each step dogfoodable. The dogfooding session's `feat/phase-9-multi-tool` branch will see these commits land one by one.

1. **Monorepo scaffold.** Create `packages/`, `pnpm-workspace.yaml`, root `package.json` with workspace scripts, `tsconfig.base.json`. Move the existing repo into `packages/pi/` and `packages/core/` (extracting core from current state). **Verify:** `pnpm install`, `pnpm -r test` runs both packages' tests.

2. **`@costlens/core` package.** Extract from the current `server/`, `extension/db.ts`, `extension/lifecycle.ts` (the data parts), `extension/commands.ts` (the data parts), `extension/search.ts`, `extension/export.ts`. **Verify:** core's tests pass, `pi-costlens` (now an adapter) still works via the new `@costlens/core` dependency.

3. **Migration logic.** Write `migrate.ts` in core. The lazy-on-read check in `core/db.ts`'s `openDb()`. **Verify:** unit tests for migrate.ts covering: empty new path + old path with data → migrate; new path exists → no-op; both exist → no-op (don't overwrite); new path empty + no old path → create new.

4. **`source` field migration.** Schema version bump (v2). `ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'pi'`. Idempotent. **Verify:** existing users see no functional change, new rows from pi are tagged `'pi'`.

5. **First-run migration notification.** When the migration runs, write a flag. The dashboard's first render checks the flag and shows a small "Welcome to v2" notice (dismissable).

6. **`pi-costlens@2.0.0` publish.** Now a thin adapter. Existing users upgrade, get the data migrated on first read, see no functional change beyond the new `~/.costlens/` path and the optional welcome notice. **Verify:** install on a clean machine, run for a few minutes, observe the migration + dashboard work.

7. **`opencode-costlens@0.1.0` v1.0.** Write the opencode plugin: capture hook, footer, dashboard spawn. **Verify:** install in an opencode session, send a few messages, see costlens DB populate, see the dashboard reflect the opencode session.

8. **Opencode v1.0 dogfooding.** Use opencode exclusively for a day. Compare dashboard numbers to what opencode's own session log reports. Fix any discrepancies. **This is where v1.0 ships.**

9. **v1.5 (opencode notifications).** Add the native-notif + daily-digest path. Verify cap-hit notifications fire in opencode too.

10. **v1.6, v1.7, v1.8 (opencode parity).** Triage from the v1.5+ roadmap. Each release gets dogfooded.

11. **v2.0 (claude-costlens).** Watcher implementation. Triage after opencode v1.5+ ships.

## 12. Decisions worth flagging

1. **Core stays tool-agnostic.** Even if a feature (say, native OS notifications) doesn't make sense in core, we don't put it in core. If it's pure logic, it goes in core; if it's tied to a tool's UX, it stays in the adapter.
2. **No `costlens` CLI in v1.0.** Real users want it but it's a separate concern. The dashboard serves the same purpose (open in a browser, no install needed beyond a tool adapter). v2.
3. **Dashboard port stays 7331 by default.** All three adapters use the same port. If a user has both pi and opencode running, they can share one server. (v1.0's per-tool server spawn is wasteful; v1.5+ can share.) For v1.0, each adapter spawns its own server only when needed; the second spawn detects the first and reuses.
4. **Existing `pi-costlens` users don't lose settings.** The settings file format is unchanged. The data migrates. The commands are unchanged. The dashboard is unchanged. The "refactor" is invisible to the user.
5. **`source` field is free-form, not enum.** Adding a new tool is a config change, not a schema change. The schema accepts any string.
6. **The monorepo uses pnpm.** pnpm has the cleanest workspaces story. yarn and npm workspaces work too, but pnpm is faster and the symlink strategy matches our needs.
7. **No build step for `extension/` in pi-costlens.** Just like today, jiti loads the .ts directly. Same for opencode-costlens. The build step (tsc → dist) is only needed if we publish pre-compiled JS, which we don't.

## 13. Dogfooding plan

You're on `feat/phase-9-multi-tool` (newly created from `main` at v0.7.0).

- Step 1 (scaffold): do this in this session, with me. Verify `pnpm -r test` runs both packages.
- Step 2 (extract core): dogfood this in another pi instance, treat the refactor as the feature.
- Step 6 (pi-costlens@2.0.0): publish, install on a clean machine, verify.
- Step 7 (opencode v1.0): dogfood in an opencode instance.
- Step 8 (opencode v1.0 dogfooding): use opencode exclusively for a day, validate.

A typical pattern:
```bash
cd ~/Develop/costlens
git checkout feat/phase-9-multi-tool
# read MULTI-TOOL.md
# "start with step 1 (monorepo scaffold)"
```

The plan is detailed enough that each step is dogfoodable in one session.

## 14. Open questions / risks

- **Opencode's plugin API surface.** I haven't dug into it in detail. v1.0 is partly a "what does opencode's plugin API look like" exploration. If the API is significantly different from pi's, v1.0 might be 2-3 days of work instead of 1.
- **Opencode sub-agent API.** Unknown. v1.8 will require a research spike. The fallback is the same approach as Claude Code: parse opencode's session log and extract sub-agent calls from there. The sub-agent cost attribution question is answerable in two ways: hook-based (clean, real-time) or log-parsing (universal, delayed). Pick the right one for opencode.
- **Cross-tool session correlation.** When the user runs pi on `feat/foo` and opencode on `feat/foo` simultaneously, they're the same feature, two sessions. The dashboard already aggregates by feature_id (which is the branch name), so this is fine — both sessions' costs sum into `feat/foo`'s total. But the "two sessions" UI might be confusing. v1.5+ can show a sessions list per feature.
- **Dashboard server sharing across tools.** If pi and opencode both spawn a dashboard server on port 7331, the second detects the first and reuses it. This is the right behavior but the implementation needs a small "is the server up?" check. v1.0 might not have this and just error on port conflict; v1.5+ adds the reuse.
- **Pricing data per tool.** Pi's pricing table is baked into the model metadata. If opencode uses a different model with the same name, the cost might be wrong. v1.0 inherits whatever pricing pi has; v1.5 might need a per-tool pricing source. Low risk for now.

## 15. Rollback

The whole structure is additive and reversible. To roll back the refactor (back to single-package `pi-costlens`):
- `git revert` the scaffold commit
- `pnpm install` regenerates node_modules without workspaces
- Existing pi-costlens users see no change

To roll back just the opencode plugin:
- `pnpm remove opencode-costlens` from the user's opencode config
- No data impact (the costlens DB is shared; opencode just stops writing to it)

To roll back the DB migration:
- `mv ~/.costlens ~/.pi/costlens` (reverse the rename)
- Delete `~/.costlens/.migrated-from-pi` (so the next read re-tries the migration)
- No data loss; just a path change

To roll back the `source` field migration:
- `ALTER TABLE messages DROP COLUMN source` (SQLite 3.35+)
- All `source` values default to `'pi'` after the column is dropped; no data loss
