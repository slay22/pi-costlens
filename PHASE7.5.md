# Phase 7.5 — Dashboard actions

The dashboard is read-only today. You can see the data but you have to drop back to the pi TUI to act on it. Phase 7.5 closes the loop: manage a feature (close, cancel, merge, reopen, cap, tags, notes) from the browser, without leaving the dashboard tab.

**Status:** not started. Dogfood target: branch `feat/phase-7.5-dashboard-actions`.

---

## 1. Why this phase exists

You built the dashboard to *see* cost data. But the natural workflow is: "I'm $4.50 into a $5 cap, let me close this before I go over." Right now that means:

1. Glance at the dashboard.
2. Switch to pi.
3. Type `/feature close shipped`.
4. Switch back to the dashboard to refresh.

Phase 7.5 collapses steps 2-4. Click a button in the dashboard → feature status changes → page reflects it within 5s (the existing polling interval).

This is the small, high-leverage piece between the data plane (Phases 4-5) and "shipping it" (Phase 8).

## 2. Goals

- **Close / cancel / merge / reopen** from the feature page.
- **Set / clear cap** from the feature page.
- **Add / remove tag** from the feature page.
- **Add note** from the feature page.
- **Status transitions feel right**: confirmation modal for close/cancel/merge (these freeze cost), inline input for tags/notes/cap.
- **No data loss on race**: if the user clicks close at the same moment the extension's `message_end` writes a new message, the close wins (it's the user's intent). Extension's subsequent message inserts still go through; the closed feature stays closed; the cap is no longer relevant.

## 3. Non-goals (deferred)

- **Inline edit** of feature name (id stays, name can change) — keep the rename as a command for v1.
- **Bulk close** of multiple features — Phase 7+ scope.
- **Undo**: close is irreversible except via `/feature reopen`; UI surfaces that.
- **Authentication / multi-user**: the dashboard is localhost-only. Anyone on the machine can act. (Same as the rest of costlens.)

## 4. Architecture

**The single big change:** drop `readonly: true` on the server's `bun:sqlite` connection, and add a tightly-scoped write API.

The server was read-only because:
- Defense in depth (server crashes can't corrupt the DB).
- Clear ownership: extension writes, server reads.
- WAL was set up for the extension as the writer.

But:
- SQLite WAL serializes writes — both processes writing concurrently is safe.
- The cost of "no actions in the UI" is high (the workflow gap above).
- We can keep the read endpoints as-is and add only **specific, audited** write endpoints. Each write endpoint maps to one prepared statement, one transaction. No generic SQL surface.

### Writes go through `server/lifecycle.ts`

To avoid duplicating business logic (close validation, state transitions, side effects), and to keep the server's behavior consistent with `/feature close` in the extension, the server gets its own lifecycle module:

```
server/
├── lifecycle.ts         NEW — mirrors extension/lifecycle.ts for writes
├── db.ts                MODIFIED — opens DB in read-write mode for the same
│                                  process; `bun:sqlite` WAL works the same
├── api.ts               MODIFIED — adds POST/PATCH/DELETE handlers
├── write.ts             NEW — thin layer that wraps lifecycle writes in
│                              transactions and returns canonical JSON
└── web/
    ├── feature.html      MODIFIED — Actions section, modals
    ├── feature.js        MODIFIED — fetch + render + show toast
    ├── overview.js       MODIFIED — refresh after a global action
    └── style.css         MODIFIED — button + modal styles
```

`server/lifecycle.ts` has the same shape as `extension/lifecycle.ts`:
- `closeFeature(id, note?)` — set `status='done'`, `closed_at`, attach note
- `cancelFeature(id, note?)` — set `status='abandoned'`, `closed_at`, attach note
- `mergeFeature(id, note?)` — set `status='merged'`, `closed_at`, attach note
- `reopenFeature(id)` — set `status='open'`, clear `closed_at`
- `setCap(id, capUsd | null)` — set or clear `cap_usd`
- `addTag(id, tag)` — insert into `tags`, dedupe
- `removeTag(id, tag)` — delete from `tags`
- `attachNote(id, body)` — insert into `notes`

All wrapped in a transaction by the caller. The functions return the updated `Feature` (or a domain-specific error type).

**Duplication is intentional and bounded.** We could extract a shared `core/` module, but:
- Extension is Node, server is Bun. Sharing requires a build step or careful ESM.
- The functions are small (~10 lines each) and stable.
- A future v2 could extract; for v1, two files is fine.

### Concurrency model

SQLite WAL serializes writes. The DB at `~/.pi/costlens/ledger.db` has the extension as the primary writer (every `message_end`) and the server as a secondary writer (user actions).

Scenarios:
- User clicks "Close" on a feature. The server does `BEGIN; UPDATE features SET status='done', closed_at=...; COMMIT;`. Concurrently, the extension's `message_end` tries to insert a new message for that feature. The message insert goes through (no schema conflict). The feature stays `done`. The new message's `cost_usd` is still added to the feature's `total_cost_usd` — but the user has been told it's closed. That's a known quirk: closing doesn't drop subsequent messages, but it does freeze the *status*. The cost keeps tracking, the dashboard just shows status=done.
  - Decision: this is fine. Closing is a status transition, not a freeze. The cost continues to accumulate until the user stops using the feature.

- User clicks "Reopen" on a feature. The server writes `status='open'`, `closed_at=NULL`. The extension's `message_end` happily inserts more messages. Feature is back to tracking.

- User clicks "Close" twice. Idempotent: if the feature is already `done`, the second click is a no-op (or returns a 409 with a clear message). Same as the extension's `/feature close` behavior.

## 5. API additions

| Method | Route | Body | Response |
|---|---|---|---|
| `POST` | `/api/features/:id/close` | `{ note?: string }` | `200 Feature` or `409 LifecycleError` |
| `POST` | `/api/features/:id/cancel` | `{ note?: string }` | `200 Feature` or `409 LifecycleError` |
| `POST` | `/api/features/:id/merge` | `{ note?: string }` | `200 Feature` or `409 LifecycleError` |
| `POST` | `/api/features/:id/reopen` | (none) | `200 Feature` or `409 LifecycleError` |
| `PATCH` | `/api/features/:id/cap` | `{ capUsd: number \| null }` | `200 Feature` or `400 LifecycleError` |
| `POST` | `/api/features/:id/tags` | `{ tag: string }` | `200 { tags: string[] }` |
| `DELETE` | `/api/features/:id/tags/:tag` | (none) | `200 { tags: string[] }` |
| `POST` | `/api/features/:id/notes` | `{ body: string }` | `200 Note` |

**Errors are JSON:**

```json
{ "error": "lifecycle", "code": "INVALID_STATE", "message": "Feature \"foo\" is already done." }
```

Codes: `NOT_FOUND` (404), `INVALID_STATE` (409), `UNASSIGNED` (409), `BAD_REQUEST` (400).

The 5-second polling on the feature page will pick up the new state automatically. For a snappier feel, the dashboard's JS can:
- Disable the button while the request is in flight
- Show a toast on success / error
- Trigger an immediate fetch of the feature detail (don't wait for the next poll)

## 6. UI: Actions section on the feature page

A new card at the top of the feature page (right under the header, above "Details"):

```
┌─ Actions ────────────────────────────────────────────┐
│                                                       │
│  Status: [open]  (Change: ▾ close / cancel / merge)   │
│                                                       │
│  Cap: $5.00   [Set cap: ___ USD  ]  [Clear]            │
│                                                       │
│  Tags: [client:acme] [v1] [×]   [+ add tag...      ]   │
│                                                       │
│  Notes:                                               │
│    • shipped to prod   2026-07-04                    │
│    • needs review      2026-07-03                    │
│    [Add note: ________________________________]       │
│      [Save note]                                       │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Each action shows a small confirmation modal for status transitions (close/cancel/merge), inline edit for tags/notes/cap.

**Confirmation modal** (for close/cancel/merge):
- Title: "Close `feat/foo`?"
- Body: "Cost will freeze at $X.XX. Use `/feature reopen` to undo."
- Buttons: [Cancel] [Close]
- Same for cancel and merge with appropriate text.

**Status transition** is shown with a brief inline confirmation toast at the top of the page (auto-dismiss after 3s).

**Empty states:**
- No tags: show "+ add tag" with a placeholder.
- No notes: show a single line with "no notes yet" and the add-note form.
- No cap: show "no cap" with a Set input.

## 7. UI: small refinements

- **Connection status pill** in the header (already exists, just ensure it's visible after a write).
- **Optimistic update on tag add / remove**: append the chip immediately, roll back on error. (Sub-100ms perceived latency.)
- **Polling on success**: trigger an immediate re-fetch of the feature after a successful write, so the rest of the page reflects the new state without waiting up to 5s.
- **Cap input validation**: 0 or positive number, max 7 digits. Show inline error if invalid.
- **Tag input**: lowercase on save, trim, no spaces inside the tag. Show "saved!" briefly.

## 8. Tests

`bun test test/server.test.ts` (extend):
- `POST /api/features/:id/close` (happy path, with note, without note, double-close → 409, missing feature → 404)
- `POST /api/features/:id/cancel` / `merge` / `reopen` (same pattern)
- `PATCH /api/features/:id/cap` (set, clear, invalid number, negative)
- `POST /api/features/:id/tags` (add, dedupe, lowercase, trim, empty)
- `DELETE /api/features/:id/tags/:tag` (existing tag, missing tag)
- `POST /api/features/:id/notes` (empty body → 400, whitespace-only body → 400, normal)

`test/lifecycle-server.test.ts` (new, node:test):
- Mirrors the extension's lifecycle tests but for `server/lifecycle.ts`. Same shape, same assertions. Verifies the duplication is consistent.

`test/extension.test.ts` (extend, optional):
- Add a small test that the extension's lifecycle and the server's lifecycle produce the same DB state for the same operations. (Sanity check on the duplication.)

## 9. Implementation order

Each step dogfoodable.

1. **`server/lifecycle.ts`** — write the lifecycle functions (close, cancel, merge, reopen, setCap, addTag, removeTag, attachNote). Each in a transaction. Test in `bun test`.
2. **`server/db.ts`** — drop `readonly: true`. Confirm `bun:sqlite` allows writes on the same WAL-mode DB the extension is writing to. Verify with a test.
3. **`server/api.ts`** — add the 8 endpoints. Each validates input, calls lifecycle, returns JSON. Test in `bun test`.
4. **`server/web/feature.html` + `feature.js`** — render the Actions section. Wire up close/cancel/merge/reopen buttons + confirmation modal. Verify visually.
5. **Cap + tags + notes** — extend the Actions section with cap input, tag editor, note form. Verify visually with real data.
6. **Toast / error handling** — show success toasts, error toasts, optimistic updates where appropriate.
7. **Polling integration** — after a successful write, re-fetch the feature immediately. The 5s polling continues in the background.
8. **Overview refresh** — when a user closes a feature from the feature page, the next visit to `/` should reflect the new status. (Already handled by 5s polling; just verify.)

## 10. Decisions worth flagging

1. **Server has write access.** `bun:sqlite` opens the DB in read-write mode. The 8 endpoints are the only writers. No generic SQL surface. SQLite WAL handles concurrent writes.
2. **Duplication of `lifecycle.ts` is intentional.** Extension and server both have their own. A future v2 could extract; for v1, the cost of duplication is bounded and the cost of a build step is high.
3. **Status transitions are not atomic with the cost freeze.** A closed feature can still receive `message_end` writes from the extension; its `total_cost_usd` keeps tracking. This is a deliberate quirk: closing is a status, not a freeze. The dashboard shows the status; the cost keeps being honest.
4. **No undo button.** Close / cancel / merge are reversible only via `/feature reopen` (and the dashboard's Reopen button). We surface that in the modal copy.
5. **Tag and note edits are optimistic for UX.** Cap / status changes wait for the server response (more important to be right).
6. **Polling remains the only update channel.** No SSE, no WebSocket. v1: 5s polling. v2: real-time.
7. **No bulk operations.** Single-feature actions only. Bulk can come in Phase 7+ if needed.
8. **No multi-user / locking.** The dashboard is localhost-only. If two browsers open the same feature and both try to close it, the second one gets a 409. That's enough.

## 11. Dogfooding plan

You're on `feat/phase-7.5-dashboard-actions` (newly created from `main` at v0.6.0).

- Set a tight cap on a fresh feature: `/feature set-cap 0.50`.
- Open the dashboard for that feature: `/feature open feat/phase-7.5-...`.
- Click the cap input, type `0.30`, save → see the cap update.
- Click `+ add tag`, type `dogfooding`, see the chip appear.
- Click `+ add note`, type `started Phase 7.5 build`, see it in the list.
- Do a few more pi turns to burn through the cap. Watch the footer go yellow → bright yellow → red.
- In the dashboard, click `[Close]` → confirmation modal → confirm.
- Watch the feature page reflect `status: done` within 5s.
- Verify the DB: `SELECT * FROM features WHERE id = 'feat/phase-7.5-...'`.
- Close: `/feature close dashboard-actions shipped`.

## 12. Rollback

Phase 7.5 is additive. The 8 new endpoints are server-side. If something's broken:
- The dashboard JS can fall back to "actions are disabled" (just don't render the Actions section).
- The server can revert to `readonly: true` and the dashboard becomes read-only again.
- The lifecycle functions are isolated to `server/lifecycle.ts`; they don't affect the extension's `extension/lifecycle.ts`.

To fully remove Phase 7.5: revert the 8 endpoints in `server/api.ts` and the Actions section in the HTML/JS/CSS. The server is back to read-only.

No schema changes. No migrations. No risk of losing data.
