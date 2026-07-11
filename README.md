# pi-loop

Scheduled loops for the [Pi](https://github.com/earendil-works/pi-mono) coding agent.

Wake the agent with a prompt, fire a reminder, run a command, or post a message — on an **interval**, **once**, or **cron**. Always-visible status, reliable recurrence, survives restarts. Loops coalesce cleanly during long agent runs; prefix `!` to force one to **interrupt mid-run**.

## Install

```bash
pi install npm:@davidroman/pi-loop
```

Then `/reload` in pi. You'll see the `🔁 loops` chip in the footer once a loop exists.

## Quick start

Type this in your pi prompt:

```
/loop 5m check the build
```

That's it — an interval loop now wakes the agent with *"check the build"* every 5 minutes. The footer shows `🔁 1 loop · next 4m` and a widget below the editor tracks it with a live countdown.

## Command grammar

Everything is one command. The **first token** decides what happens:

```
/loop                                  wizard (add / list / pause / resume / delete)
/loop <schedule> <prompt>              quick prompt loop (schedule-first shortcut)
/loop <action> <schedule> <payload>    explicit action: prompt / notify / shell / message
/loop !<schedule> <prompt>             forced loop — interrupt mid-run if the agent is busy
/loop <verb> <name|id>                 control: pause / resume / delete / run
```

There's no list command — the widget under the editor (see below) always shows every loop with a live countdown. Pick a loop by name or id for control verbs.

### Creating loops

**Schedule-first** (default action = `prompt`):

```
/loop 5m check the build               # prompt, every 5m
/loop +10m review the diff             # prompt, once in 10m
/loop tomorrow 9am write notes         # prompt, once at a clock time
/loop "*/5 * * * *" poll queue depth   # prompt, cron (quote it — it has spaces)
```

**Action-first** (any of the four actions):

```
/loop shell 5m npm test                # run a command every 5m
/loop notify 9am standup               # reminder toast at 9am
/loop notify +5m break time            # reminder in 5 minutes
/loop message 1h heartbeat             # post a transcript line hourly
/loop prompt 1h sync the cache         # explicit prompt (same as schedule-first)
```

To wake the agent with a shell command's output, add a `followUpPrompt` — via the wizard or by asking the agent.

**Forced loops (`!`)** — prefix `!` to make a loop **interrupt** the agent mid-run instead of waiting for it to finish (see [When the agent is busy](#when-the-agent-is-busy)):

```
/loop !5m check ci                     # forced: inject at the next tool-call boundary if busy
/loop !+10m remind me to review        # forced one-shot
/loop !shell 1h npm test               # forced shell
```

**Interactive wizard** — for cron with a follow-up prompt, a custom name, or a max-fire count:

```
/loop
```

Walks you through action → type → schedule → payload → name → max fires, re-prompting on invalid input (you never lose what you already typed).

### Controlling loops

**By name or id — no menu needed:**

```
/loop pause build-check                # stop firing, keep the loop (resumable)
/loop resume build-check               # re-arm a paused loop
/loop run build-check                  # fire immediately, ignoring the schedule
/loop delete build-check               # permanently remove
```

Name matching is flexible: full id, id prefix, or unique name. With a single active loop you can even omit the name — `/loop pause` targets it.

**Bulk + browse** via the wizard:

```
/loop  →  Pause all · Resume all · Clear all · List/manage (pick → Pause/Resume/Run now/Delete)
```

### Schedules

| Type | Examples |
|---|---|
| **interval** | `5m`, `1h30m`, `30s`, `2h`, `hourly`, `daily`, `every 10m`, `in 1 hour` |
| **once** | `+10m`, `in 2 hours`, `tomorrow 9am`, `9am`, `18:30`, `2026-01-01T09:00` |
| **cron** | `*/5 * * * *` (every 5 min), `0 9 * * 1-5` (9am weekdays), `0 */2 * * *` (every 2h) |

> A leading `+` or `in ` means a one-shot. `5m` / `every …` / bare durations mean interval. Cron is detected from the 5-field shape — **quote it** on the command line since it contains spaces.

### Actions

| Action | Fires as | Use for |
|---|---|---|
| **prompt** | wakes the agent with a prompt | polling CI, periodic work — the main use |
| **notify** | a toast reminder (no agent wake) | "standup in 5 min" |
| **shell** | runs a command on schedule | `npm test` every 5m; optional `followUpPrompt` wakes the agent with the output |
| **message** | a line in the transcript | logging, breadcrumbs; optionally triggers a turn |

## When the agent is busy

A loop can fire while the agent is mid-run (a long task, a goal skill, a stuck loop of tool calls). To understand the two delivery policies, it helps to see how a run flows.

### How a run flows (and where your loop lands)

A Pi run is a loop of **turns**. A loop that fires mid-run has two places it can deliver — pick which one with `!`:

```
you send a prompt
   │
   ▼
┌─ turn 1 ──────────────────────┐   a turn = one LLM reply + its tool calls
│  think → bash → edit → …      │
└───────────────────────────────┘
   │  ◄── turn boundary: tools done, before the next LLM call   ← ! lands here
   ▼
┌─ turn 2 ──────────────────────┐
│  think → bash → …             │
└───────────────────────────────┘
   │  ◄── turn boundary
   ▼
   … a goal skill can loop here for an hour …
   ▼
 settled                          the whole run is done — agent idle, nothing queued   ← default lands here
```

- **Turn boundary** — the yield point between one turn's tool calls and the next LLM call. Happens every few seconds.
- **Settled** — the entire run is finished. Seconds away for a quick task; potentially an hour away for a long autonomous run.

That gap is the whole reason `!` exists:

| | Agent idle | Agent busy |
|---|---|---|
| **default** | fires immediately | coalesces → **one** delivery at **settled** (even if that's an hour away) |
| **`!` forced** | fires immediately | coalesces per-turn → **steers in at the next turn boundary** (lands in seconds) |

- **default** stays out of the way and batches into one message when the agent finishes. Good for background polling ("check CI every 5m").
- **`!`** interrupts within seconds — use it when waiting for the run to finish would defeat the trigger ("remind me in 10m", "wake me if health checks fail"). Coalesced so a `!5m` loop never bursts (max one injection per turn).

## See what's running

No command needed — the widget under the editor always shows every loop:

```
  ● build-check    every 5m         in 4m        ×3   prompt !
  ○ standup        cron 0 9 * * 1-5 in 14h       ×0   prompt
  ❚❚ deploys       every 1h         paused       ×12  shell
  ✗ broken-watch   every 30s        errored      ×2   shell
```

| Glyph / marker | Meaning |
|---|---|
| `●` | active |
| `❚❚` | paused |
| `✗` | errored (last run failed) |
| `!` | forced loop — interrupts mid-run when busy |
| `⏳` | a fire is buffered (waiting to deliver) |

Finished loops (a `once` that fired, or one that hit `maxFires`) are removed automatically — the widget shows only loops that still have work to do.

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
Schedule a forced loop: remind me in 10 minutes no matter what I'm doing.
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
