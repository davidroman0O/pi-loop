# pi-loop

Scheduled loops for the [Pi](https://github.com/earendil-works/pi-mono) coding agent.

Wake the agent with a prompt, fire a reminder, run a command, or post a message — on an **interval**, **once**, or **cron**. Always-visible status, reliable recurrence, survives restarts.

## Install

```bash
pi install github.com/davidroman0O/pi-loop
```

Or clone into your extensions dir, then `/reload`:

```bash
git clone https://github.com/davidroman0O/pi-loop ~/.pi/agent/extensions/pi-loop
cd ~/.pi/agent/extensions/pi-loop && npm install
```

## Quick start

Type this in your pi prompt:

```
/loop 5m check the build
```

That's it — an interval loop now wakes the agent with *"check the build"* every 5 minutes. The footer shows `🔁 1 loop · next 4m` and a widget below the editor tracks it with a live countdown.

## Creating loops

### One-liner (fastest)

```
/loop <schedule> <prompt>
```

The prompt becomes the loop **name** (first few words) and the payload. Type is inferred from the schedule.

```
/loop 30s poll health            # interval
/loop 1h30m sync the cache       # interval (compound duration)
/loop +10m review the diff       # once, in 10 minutes
/loop tomorrow 9am write notes   # once, at a clock time
```

### Interactive wizard — `/loop` with no args

For **cron**, **non-prompt actions**, or to set a **max fire count**, use the wizard:

```
/loop
```

It walks you through, re-prompting on invalid input (you never lose what you already typed):

1. **Action** → Prompt / Notify / Shell / Message
2. **Schedule type** → Interval / Once / Cron
3. **Schedule** → `5m`, `+10m`, `tomorrow 9am`, `*/5 * * * *`, …
4. **Payload** → the prompt text / reminder / command
5. **Name** → optional, defaults to an id
6. **Max fires** → optional, stops after N runs (recurring only)

### Schedules

| Type | Examples |
|---|---|
| **interval** | `5m`, `1h30m`, `30s`, `2h`, `hourly`, `daily`, `every 10m`, `in 1 hour` |
| **once** | `+10m`, `in 2 hours`, `tomorrow 9am`, `9am`, `18:30`, `2026-01-01T09:00` |
| **cron** | `*/5 * * * *` (every 5 min), `0 9 * * 1-5` (9am weekdays), `0 */2 * * *` (every 2h) |

### Actions

| Action | Fires as | Use for |
|---|---|---|
| **prompt** | wakes the agent with a prompt | polling CI, periodic work — the main use |
| **notify** | a toast reminder (no agent wake) | "standup in 5 min" |
| **shell** | runs a command on schedule | `npm test` every 5m; optional `followUpPrompt` wakes the agent with the output |
| **message** | a line in the transcript | logging, breadcrumbs; optionally triggers a turn |

## Controlling loops

### Pause / Resume / Delete (one loop)

```
/loop  →  List / manage…  →  pick a loop  →  Pause · Resume · Run now · Delete
```

- **Pause** stops the timer but keeps the loop (widget shows `❚❚ paused`). Resumable.
- **Resume** re-arms a paused loop.
- **Delete** permanently removes it.
- **Run now** fires immediately without waiting for the schedule.

### Bulk

From the `/loop` menu:

- **Pause all** — stop every loop
- **Resume all** — restart every paused loop
- **Clear all** — permanently remove everything (asks for confirmation)

### See what's running

```
/loops                          # lists every loop in the transcript
```

Or just glance at the widget under the editor:

```
  ● build-check    every 5m         in 4m        ×3   prompt
  ○ standup        cron 0 9 * * 1-5 in 14h       ×0   prompt
  ❚❚ deploys       every 1h         paused       ×12  shell
  ✓ morning-sync   once +1h         done         ×1   prompt
```

| Glyph | Meaning |
|---|---|
| `●` | active |
| `❚❚` | paused |
| `✓` | done (one-shot fired, or maxFires reached) |
| `✗` | errored |

## Let the agent schedule itself

The agent has `schedule_loop`, `list_loops`, and `stop_loop` tools — just ask in plain language:

```
Watch the build — run `npm test` every 5 minutes and tell me the result, max 20 times.
```
```
Remind me to review the PR at 9am tomorrow.
```
```
Poll /health every 30s and wake me up if it's not 200.
```
```
pause the build-check loop
```
```
delete the standup loop
```

`stop_loop` finds a loop by **id, id prefix, or unique name**.

## Persistence & limits

- Loops persist to `.pi/loops.json` in the project. Reopening the project re-arms them automatically; paused loops stay paused.
- **One pi per project:** loops are project-scoped. Two pi instances in the same cwd will both fire shared loops — the single-developer case just works.

## License

MIT
