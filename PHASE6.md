# Phase 6 — Notifications & digest

Make the cap actually matter. Right now if you cross 80% or 100% of your cap, the only signal is a coloured footer you might not be looking at. Phase 6 makes it impossible to miss: native OS notifications on cap hit, an optional daily digest at session start, and an optional webhook for Slack/Discord.

**Status:** not started. Dogfood target: branch `feat/phase-6-notifications`.

---

## 1. Goals

- **Native OS notification** when a feature's total cost crosses 50% / 80% / 100% / 110% of its cap. Each threshold fires once per feature per session.
- **Daily digest** at session_start: if any feature spent >$X yesterday, show a one-line summary in pi.
- **Optional webhook** (Slack/Discord incoming webhook, or any HTTP POST) on cap crossings.
- All three are **opt-in via config** with sensible defaults: notifications ON, digest ON, webhook OFF.
- Zero new runtime dependencies (Node 22+ has `fetch` built in).

## 2. Non-goals (still deferred)

- Sub-agent / per-tool cost attribution (Phase 8)
- Latency / model performance comparison (Phase 8)
- Cross-machine / team sync (Phase 9)
- WebSocket real-time dashboard updates (v2)
- Custom pricing overrides (v2)
- Native toast sounds (we'll use system defaults)

## 3. Architecture

No new components. Lives entirely in the extension:

```
extension/
├── notifications.ts       NEW — native notif + webhook + debounce state
├── lifecycle.ts           MODIFIED — addCapAwareTotals() helper, getDailySpend()
├── hooks.ts               MODIFIED — on message_end, check thresholds, notify
├── config.ts              MODIFIED — extend CostlensConfig with notifications{}
├── commands.ts            MODIFIED — /feature notify-test, /feature notify-config
├── index.ts               MODIFIED — session_start runs daily digest
```

`notifications.ts` owns:
- `notify(title, body, level)` — platform-aware (mac/linux/win) + in-pi fallback
- `postWebhook(url, payload)` — 2s timeout, fire-and-forget
- `fireThresholdNotification(feature, level, cost, cap, ratio)` — debounced
- `computeDailyDigest()` — yesterday's top spenders

## 4. Files

```
costlens/
├── extension/
│   ├── notifications.ts            NEW — ~150 lines
│   ├── hooks.ts                     MODIFIED — call into notifications on message_end
│   ├── lifecycle.ts                 MODIFIED — add getDailySpend()
│   ├── config.ts                    MODIFIED — extend CostlensConfig shape
│   ├── commands.ts                  MODIFIED — /feature notify-test, /feature notify-config
│   └── index.ts                     MODIFIED — session_start runs daily digest
├── test/
│   └── notifications.test.ts        NEW — test debounce, threshold logic, digest
├── server/                          UNCHANGED
├── package.json                     UNCHANGED
└── PHASE6.md                        this file
```

No schema changes. No new npm dependencies.

## 5. Configuration

`~/.pi/costlens/config.json` gains an optional `notifications` field. Backwards compatible — missing field = defaults.

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
| `enabled` | bool | `true` | Master switch for all notifications |
| `thresholds` | number[] | `[0.5, 0.8, 1.0, 1.1]` | Ratios that fire (0.5 = 50% of cap) |
| `webhook` | string \| null | `null` | URL to POST on threshold crossing |
| `dailyDigest` | bool | `true` | Show yesterday's spend on session_start |
| `dailyDigestThresholdUsd` | number | `0.5` | Only mention features above this $ |

Persist via `/feature notify-config webhook <url>`, `/feature notify-config daily-digest on`, etc. Or just edit the JSON.

## 6. Notification primitives

### `notify(title, body, level)` — platform dispatch

```typescript
type Level = "info" | "warn" | "critical";

export async function notify(title: string, body: string, level: Level): Promise<void> {
  if (level === "critical") {
    // Always use the loudest channel
    await sendNative(title, body, level);
  }
  // Always also show in-pi (works headless / over SSH)
  if (ctx.hasUI) ctx.ui.notify(`${title}\n${body}`, level === "info" ? "info" : "warning");
}
```

Platform commands:
- **macOS**: `osascript -e 'display notification "body" with title "title" subtitle "level"'`
- **Linux**: `notify-send -u <low|normal|critical> "title" "body"` (graceful fallback if not installed)
- **Windows**: PowerShell with `New-BurntToastNotification` (or just log if BurntToast isn't installed)

`sendNative` is best-effort: 1.5s timeout, never throws, logs on failure.

### `postWebhook(url, payload)` — fire and forget

```typescript
export async function postWebhook(url: string, payload: object): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // Silently log; never crash on webhook failure
    process.stderr.write(`[costlens-webhook] ${err}\n`);
  } finally {
    clearTimeout(timer);
  }
}
```

Slack-compatible payload (just works as a Slack incoming webhook):
```json
{
  "text": "🟡 *feat/phase-6-notifications* hit 80% of $5.00 cap — $4.00 / $5.00"
}
```

## 7. Threshold logic + debounce

State: in-memory `Set<"featureId:level">` per session. Lost on session shutdown (intentional — see "Debounce semantics" below).

```typescript
const fired = new Set<string>();  // "featureId:level" pairs

function thresholdKey(featureId: string, level: CostLevel): string {
  return `${featureId}:${level}`;
}

export function fireThresholdNotification(
  feature: Feature,
  cost: number,
  cap: number,
  level: CostLevel,
): void {
  if (!config.notifications.enabled) return;
  if (!config.notifications.thresholds.includes(thresholdRatio(level))) return;
  if (fired.has(thresholdKey(feature.id, level))) return;  // already fired this session
  fired.add(thresholdKey(feature.id, level));
  // ... fire notify + webhook
}
```

`CostLevel` is already defined in `extension/footer.ts` as `ok | warn | high | over | default`. Map to ratios:
- `warn` (50-80%) → 0.5
- `high` (80-100%) → 0.8
- `over` (>100%) → 1.0
- (110% threshold maps to "over-cap-by-10%" — a stricter `over` level not currently used; for v1, treat `over` as both 1.0 and 1.1)

### Debounce semantics

- **Within a session**: each threshold fires at most once per feature.
- **Across sessions**: if a feature is opened on day 1 at 70%, you get the 50% notification, but not the 80% (not crossed). On day 2 the feature is at 90% — you do NOT get a re-notification for 80%, because:
  - On session_start we **mark all currently-crossed thresholds as "already fired"** for that feature.
  - This avoids notification spam when you reopen a session.
- **Reopen with `/feature reopen`**: resets the feature to `open`, clears the in-memory "fired" set for that feature. (TBD: maybe re-notify? Probably not — user explicitly reopened, they know.)

## 8. Daily digest

Triggered from `session_start` (after `ensureFeatureForSession`):

```typescript
// In extension/index.ts, after featureId resolved
if (config.notifications.dailyDigest) {
  const digest = computeDailyDigest(db, config.notifications.dailyDigestThresholdUsd);
  if (digest.lines.length > 0 && ctx.hasUI) {
    await ctx.ui.notify(
      `Costlens — yesterday's spend:\n${digest.lines.join("\n")}`,
      "info"
    );
  }
}
```

`computeDailyDigest(db, thresholdUsd)`:
- Query: `SELECT feature_id, SUM(cost_usd) AS cost, COUNT(*) AS turns FROM messages WHERE date(timestamp) = date('now', '-1 day') GROUP BY feature_id HAVING cost > ? ORDER BY cost DESC`
- Format: `feat/phase-5-polish  $1.23 (4 turns)`
- If a single feature dominates, mention it; if many, top 3 + "and N more"

## 9. Commands added to `/feature`

| Command | Behaviour |
|---|---|
| `/feature notify-test` | Fire a test notification (in-pi + native) to verify the platform command works. |
| `/feature notify-config` | Print the current notification config (enabled, thresholds, webhook, digest). |
| `/feature notify-config on\|off` | Master switch. |
| `/feature notify-config webhook <url> \| clear` | Set or clear the webhook URL. |
| `/feature notify-config daily-digest on\|off` | Toggle the daily digest. |
| `/feature notify-config daily-threshold <usd>` | Set the digest threshold. |
| `/feature notify-config thresholds <list>` | Override thresholds (comma-separated, e.g., `0.5,0.8,1.0,1.1`). |

All commands write through to `config.json`.

## 10. Hooks integration

`extension/hooks.ts` `message_end` handler — after the cost update, check the new total against thresholds and fire notifications:

```typescript
pi.on("message_end", async (event, ctx) => {
  // ... existing message insert + totals update ...
  const feature = getFeature(featureId);
  if (feature?.cap_usd) {
    const level = costLevel(feature.total_cost_usd, feature.cap_usd);
    fireThresholdNotification(feature, feature.total_cost_usd, feature.cap_usd, level);
  }
});
```

`costLevel` is already exported from `extension/footer.ts` — we reuse it.

## 11. Tests

`test/notifications.test.ts` (new, runs with `node --import tsx --test`):

- `fireThresholdNotification` fires for the right levels
- `fireThresholdNotification` doesn't fire when disabled
- Debounce: same level for same feature fires once, not twice
- Reopen a feature: clears the debounce (in-memory set is per-feature, keyed on feature id)
- `postWebhook` returns cleanly on 404, timeout, network error
- `computeDailyDigest` returns the right top spenders
- `computeDailyDigest` returns empty when nothing crossed threshold
- `CostlensConfig` defaults applied when `notifications` field missing
- `/feature notify-config` command paths write the right config

`bun test` extension: unchanged. Server tests unchanged.

## 12. Implementation order

Each step is dogfoodable.

1. **`notifications.ts` skeleton** — `notify()`, `postWebhook()`, level mapping. Unit tests for these primitives. No config integration yet — just verify the platform commands work on your Mac (`/feature notify-test` placeholder).
2. **Threshold detection in `hooks.ts`** — wire `fireThresholdNotification` into `message_end`. Add in-memory debounce. Verify: cross 50% / 80% / 100% in a session, see notifications fire once each.
3. **`config.ts` extension** — add `notifications` field with defaults. Persist via `/feature notify-config`. Verify config round-trips.
4. **Daily digest** — `computeDailyDigest` in `lifecycle.ts`, called from `session_start`. Verify: after a session that spent $X, restart, see the digest in the notification.
5. **Webhook** — `postWebhook` from `fireThresholdNotification`. Verify: start a local listener (e.g., `nc -l 9000` or a quick `python3 -m http.server` mock), set webhook URL, cross 80%, see the POST.
6. **Commands polish** — `/feature notify-test`, `/feature notify-config` (subcommands). Update help text.
7. **README update** — document notifications, config, webhook.

## 13. Decisions worth flagging

1. **In-memory debounce, no DB persistence.** Simpler. We seed the "fired" set on session_start with all currently-crossed thresholds, so no spam on reload. Trade-off: if pi crashes mid-session and you restart, you might re-notify — but that's a rare edge case and the user just sees an extra popup.
2. **50% / 80% / 100% / 110% thresholds are the defaults.** User-configurable via `thresholds` array. Anything not in the array is silent. The 110% lets you know you're $0.50 over a $5 cap (vs. just knowing you're "over").
3. **Webhook is fire-and-forget, 2s timeout.** We don't retry. The user can wire it to a durable Slack channel or to a local logger. If they need reliability, that's v2.
4. **Notifications always show in-pi AND native.** Belt and suspenders. The in-pi notification is the always-works channel; the native notification is the "I can actually see this" channel.
5. **Daily digest is a one-line summary, not a chart.** Keeps it cheap. The dashboard has the full view.
6. **No toast sound customization.** macOS picks the default sound. If you want silent, that's a system-level setting.
7. **Throttle native notifs.** If you cross 50% and 80% in the same turn (possible if a turn is huge), we fire both — but no more than 4 thresholds per feature per session. After that, we go quiet.

## 14. Dogfooding plan

You're on `feat/phase-6-notifications` (newly created from `feat/phase-5-polish` at the latest commit).

- Set a tight cap early: `/feature set-cap 0.50` — you'll see the 50% / 80% / 100% thresholds fire as you (and the dogfooding model) build.
- Step 2 is the most testable: do a turn, cross a threshold, see the native notification.
- For the webhook test, run a quick local listener and set the URL:
  ```bash
  # in one terminal
  python3 -c "import http.server, json; s = http.server.HTTPServer(('localhost', 9000), http.server.BaseHTTPRequestHandler); s.handle_request(); print(json.loads(s.rfile.read().decode()))" || true
  # in pi
  /feature notify-config webhook http://localhost:9000
  ```
- After step 6, run `/feature help` to confirm the new subcommands show up.
- After step 7, the README has the new section.
- Close: `/feature close notifications shipped` (or similar).

## 15. Rollback

Phase 6 is purely additive. If something's annoying:
- `/feature notify-config off` — disables everything
- `/feature notify-config daily-digest off` — kills the digest
- `/feature notify-config webhook clear` — kills the webhook

Native notifications are best-effort: if the platform command fails, we fall back to in-pi only. No new schema, no new tables.

To remove the extension from sending anything, revert the `fireThresholdNotification` call in `hooks.ts` to a no-op. The native command files (`osascript`, `notify-send`) won't even be invoked.
