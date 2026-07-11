# pi-loop

Reliable scheduled loops for the [Pi](https://github.com/earendil-works/pi-mono) coding agent.

Schedule a prompt, notification, shell command, or transcript message to fire on an **interval**, **once**, or **cron**. Always-visible status, working input, and bulletproof recurrence that survives restarts.

## Why

Three existing loop/scheduler plugins each broke differently. This one is built to fix all three:

| Plugin | Bug | How pi-loop fixes it |
|---|---|---|
| trvon/pi-loop | No visible status indicator; 80+ files of sprawl | Always-on footer chip **+** a widget below the editor listing every loop with a live countdown. One file of extension glue. |
| tintinweb/pi-schedule-prompt | Pressing Enter in the input makes text disappear | Add/manage flow uses **native dialogs only** (`select`/`input`/`confirm`). No overlays competing for keystrokes. |
| jl1990/pi-scheduler | Interval/cron loops get cancelled right after the first fire | Authoritative state lives **in memory**; disk is a write-through mirror read **once** at startup. The next run is re-armed **before** the action runs, so a crash never loses recurrence. |

## Install

```bash
pi install github.com/davidroman0O/pi-loop
```

Or clone into your extensions dir:

```bash
git clone https://github.com/davidroman0O/pi-loop ~/.pi/agent/extensions/pi-loop
cd ~/.pi/agent/extensions/pi-loop && npm install
```

## Usage

### Commands

```
/loop 5m check the build         # quick: interval prompt loop named "check the build"
/loop                            # interactive manager (add / list / pause / resume / delete)
/loops                           # list all loops in the transcript
```

The `/loop` manager walks you through: action → schedule type → schedule → payload → name → max fires, re-prompting on invalid input. It never loses what you've already typed.

### Tools (the agent can self-schedule)

| Tool | What it does |
|---|---|
| `schedule_loop` | Create a loop (prompt / notify / shell / message) on interval / once / cron. |
| `list_loops` | List all loops with status and next run. |
| `stop_loop` | Pause or delete a loop by id, id prefix, or unique name. |

Let the agent poll CI, watch a build, or wake itself up: *"schedule a loop that runs `npm test` every 5 minutes and tells me the result, max 20 times."*

### Schedules

- **Interval** — `5m`, `1h30m`, `30s`, `2h`, `hourly`, `daily`, `every 10m`, `in 1 hour`
- **Once** — relative (`+10m`, `in 2 hours`) or absolute (`tomorrow 9am`, `9am`, `18:30`, `2026-01-01T09:00`)
- **Cron** — standard 5-field expressions: `*/5 * * * *` (every 5 min), `0 9 * * 1-5` (9am weekdays), `0 */2 * * *` (every 2h)

### Actions

- **prompt** — wake the agent with a prompt (the headline use case: *"check the build"* on a loop)
- **notify** — show a reminder toast (no agent wake)
- **shell** — run a command on a schedule; optionally wake the agent with the output via `followUpPrompt`
- **message** — post a line in the transcript, optionally triggering a turn

## Visibility

While any loop is active you'll see, at all times:

- **Footer:** `🔁 2 loops · next 4m`
- **Widget below the editor:**
  ```
    ● build-check   every 5m        in 4m         ×3   prompt
    ○ standup       cron 0 9 * * 1-5 in 14h       ×0   prompt
    ❚❚ deploys      every 1h        paused        ×12  shell
  ```

## Persistence

Loops persist to `.pi/loops.json` in the project. Reopening the project re-arms them automatically. State is authoritative in memory while pi runs — the file is a write-through mirror, never reloaded mid-session (this is what avoids the disk-clobber recurrence bug).

**One pi per project:** loops are project-scoped. If two pi instances run in the same project simultaneously, both will fire shared loops. The common single-developer case just works.

## Architecture

```
extensions/loop.ts     # Pi glue: events, commands, tools, UI, fire loop (~600 lines)
src/schedule.ts        # Parse + validate interval / once / cron, compute nextRun
src/store.ts           # LoopStore (in-memory + write-through disk) + planFire (recurrence decision)
src/format.ts          # Relative-time + schedule labels
test/check.mjs         # Self-check: parsing, store round-trip, recurrence. Run: npx tsx test/check.mjs
```

Three guarantees, one place each:

1. **Visible** — `setStatus` + `setWidget` in `updateUI()`, ticked every 30s and on every change/fire.
2. **Input works** — `manage()` / `addLoop()` use only `ctx.ui.select/input/confirm`.
3. **Recurrence holds** — `planFire()` (pure, tested) + re-arm-before-execute in `fire()`.

Cron recurrence is handled by [`croner`](https://github.com/hexagon/croner) (the single runtime dependency).

## License

MIT
