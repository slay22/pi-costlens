# Costlens

A pi extension that books the real dollar cost of every assistant message to a **feature** (a git branch you're working on), with a local web dashboard for stats.

> **Status: Phase 3 (footer polish).** The extension loads, captures message costs, writes them to SQLite, supports the full lifecycle, and renders an ANSI-coloured status footer that reflects cap ratio (green / yellow / red). Dashboard comes in Phase 4 — see [PLAN.md](./PLAN.md).

## What it does (so far)

- Registers as a pi extension
- On every assistant message, writes the token usage + dollar cost to `~/.pi/costlens/ledger.db`
- Groups costs by feature (= git branch; `main` and friends go to an `unassigned` pool)
- On a fresh branch, prompts once: "Start a feature for `branch`? [Y/n]"
- Closes/cancels preserve the cost; reopen via `/feature reopen`
- Renders an ANSI-coloured status footer (green at <50% of cap, yellow at 50-80%, bright yellow at 80-100%, red above) with text fallbacks (`! near cap`, `✗ over cap by $X.XX`)
- Computes a `pricing_confidence` per feature (`complete` / `partial` / `unknown`)

## Footer colour scheme

| Cost vs cap | Colour | Marker |
|---|---|---|
| no cap | default | (none) |
| < 50% | green | (none) |
| 50–80% | yellow | (none) |
| 80–100% | bright yellow | `! 80% of $X cap` |
| > 100% | bright red | `✗ over cap by $X.XX` |

Text markers are always present, even if pi's TUI strips ANSI — you can always tell the level from a glance.

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

## Verify Phase 3

1. Start pi on a non-main branch and confirm the feature prompt.
2. Send a few prompts. The footer should be green (cost is well under any cap you set).
3. Try `/feature set-cap 0.10` and run more prompts. Watch the colour change:
   - Green → yellow at 50% (≈ $0.05)
   - Yellow → bright yellow at 80% (≈ $0.08)
   - Bright yellow → red above 100% (over $0.10), marker changes to `✗ over cap by $X.XX`
4. If pi's TUI strips the ANSI codes, you'll still see the text markers (`! near cap`, `✗ over cap`).
5. Run `/feature help` for the grouped command list.

## Layout

```
costlens/
├── extension/         # runs in pi (Node, loaded via jiti)
│   ├── index.ts       # entry
│   ├── db.ts          # SQLite schema + queries
│   ├── hooks.ts       # message_end handler
│   ├── lifecycle.ts   # feature creation/lookup
│   ├── git.ts         # branch detection
│   ├── commands.ts    # /feature <subcommand>
│   ├── pricing.ts     # confidence calc
│   └── footer.ts      # status bar (Phase 3)
├── server/            # runs in Bun (Phase 4 — dashboard)
└── test/              # smoke tests
```

See [PLAN.md](./PLAN.md) for the full design, phasing, and v2 deferred work.

## Commands (current)

| Command | Phase | What it does |
|---|---|---|
| `/feature help` | 1 | List available subcommands (grouped) |
| `/feature status` | 1 | Current feature detail (with cap warning) |
| `/feature list` | 2 | All features, sorted by recent activity |
| `/feature close [note]` | 2 | Mark current feature done, freeze cost |
| `/feature cancel [note]` | 2 | Mark current feature abandoned, freeze cost |
| `/feature rename <name>` | 2 | Rename current feature (id stays) |
| `/feature set-cap <usd>` | 2 | Set soft cap (0 to clear) |
| `/feature reopen` | 2 | Reopen a closed/cancelled feature |
| `/feature dashboard` | 4 | (Phase 4) Open browser |
| `/feature open <name>` | 4 | (Phase 4) Deep-link |
| `/feature note <text>` | 5 | (Phase 5) Attach note |
| `/feature tag add\|remove <t>` | 5 | (Phase 5) Categorize |
| `/feature merge` | 5 | (Phase 5) Mark branch merged |
| `/feature search <q>` | 5 | (Phase 5) Find by name |
| `/feature export <fmt>` | 5 | (Phase 5) csv \| json |

## License

MIT.
