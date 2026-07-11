// pi-loop — reliable scheduled loops for the Pi coding agent.
//
// Why this exists: three prior plugins each broke differently.
//   • trvon/pi-loop            — invisible status (over-engineered, 80+ files).
//   • tintinweb/pi-schedule-prompt — overlay swallowed ctx.ui.input keystrokes.
//   • jl1990/pi-scheduler       — disk read clobbered live reschedule state;
//                                 recurring jobs landed in a terminal state.
//
// This extension's three guarantees:
//   1. ALWAYS-VISIBLE status: footer chip ("🔁 2 loops · next 4m") + a widget
//      below the editor listing every loop with a live countdown.
//   2. NATIVE DIALOGS only for the add/manage flow. No overlays competing for
//      keyboard input — Enter always registers.
//   3. BULLETPROOF recurrence: in-memory Map is authoritative, disk is a
//      write-through mirror read ONCE at session_start. For interval loops the
//      next run is re-armed BEFORE the action executes, so a crash or throw
//      never loses the recurrence.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cron } from "croner";
import { join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	describeSchedule,
	inferType,
	nextRun,
	validateSchedule,
	type ActionType,
	type ScheduleType,
} from "../src/schedule.ts";
import { LoopStore, newId, planFire, type Loop } from "../src/store.ts";
import { formatRelative, loopPayloadPreview, loopScheduleLabel, safeParsed } from "../src/format.ts";

const CONFIG_DIR_NAME = ".pi";
const MAX_TIMER_DELAY_MS = 2_147_483_647; // setTimeout practical cap (~24.8d)
const DEFAULT_SHELL_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 8_000;
const UI_TICK_MS = 30_000;

type Handle = { kind: "timeout"; handle: NodeJS.Timeout } | { kind: "cron"; handle: Cron };

function truncateMiddle(text: string | undefined, max: number): string {
	const v = text ?? "";
	if (v.length <= max) return v;
	const head = Math.floor(max * 0.6);
	const tail = max - head - 60;
	return `${v.slice(0, head)}\n\n[… ${v.length - max} chars truncated …]\n\n${v.slice(-tail)}`;
}

function loopFilePath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "loops.json");
}

function statusGlyph(loop: Loop): string {
	switch (loop.status) {
		case "active":
			return loop.lastStatus === "error" ? "⚠" : "●";
		case "paused":
			return "❚❚";
		case "done":
			return "✓";
		case "error":
			return "✗";
	}
}

export default function loopExtension(pi: ExtensionAPI) {
	let store = new LoopStore(loopFilePath(process.cwd()));
	const handles = new Map<string, Handle>();
	const firing = new Set<string>();
	let activeCtx: ExtensionContext | undefined;
	let uiTick: NodeJS.Timeout | undefined;

	// ─── UI ────────────────────────────────────────────────────────────────────

	function updateUI(ctx = activeCtx) {
		if (!ctx?.hasUI) return;
		const theme = ctx.ui.theme;
		const visible = store.list();
		const active = visible.filter((l) => l.enabled && l.status !== "done" && l.status !== "error");

		// Footer chip — always visible when loops exist.
		if (active.length === 0) {
			ctx.ui.setStatus("loop", undefined);
		} else {
			const s = active.length === 1 ? "" : "s";
			const next = earliestNextRun(active);
			const nextLabel = next ? ` · next ${formatRelative(next, new Date())}` : "";
			ctx.ui.setStatus(
				"loop",
				theme.fg("accent", `🔁 ${active.length} loop${s}`) + theme.fg("dim", nextLabel),
			);
		}

		// Widget below the editor — one line per loop, live countdown.
		if (visible.length === 0) {
			ctx.ui.setWidget("loop", undefined);
			return;
		}
		const lines: string[] = [];
		const sorted = [...visible].sort((a, b) => {
			const order = { active: 0, paused: 1, error: 2, done: 3 } as const;
			if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
			return (Date.parse(a.nextRun ?? "") || 0) - (Date.parse(b.nextRun ?? "") || 0);
		});
		for (const l of sorted) {
			const glyph = theme.fg(l.status === "done" ? "success" : l.status === "error" ? "error" : "accent", statusGlyph(l));
			const name = l.name.padEnd(14).slice(0, 14);
			const sched = theme.fg("muted", loopScheduleLabel(l).padEnd(16).slice(0, 16));
			const nr = l.enabled && l.status !== "done" && l.status !== "error"
				? theme.fg("dim", formatRelative(l.nextRun, new Date()).padEnd(12).slice(0, 12))
				: theme.fg("dim", (l.status === "done" ? "done" : "paused").padEnd(12).slice(0, 12));
			const runs = theme.fg("dim", `×${l.runCount}`);
			const act = theme.fg("accent", l.action);
			lines.push(`  ${glyph} ${name} ${sched} ${nr} ${runs}  ${act}`);
		}
		ctx.ui.setWidget("loop", lines, { placement: "belowEditor" });
	}

	function earliestNextRun(loops: Loop[]): string | undefined {
		let best: number | undefined;
		for (const l of loops) {
			if (!l.nextRun) continue;
			const t = Date.parse(l.nextRun);
			if (Number.isFinite(t) && (best === undefined || t < best)) best = t;
		}
		return best !== undefined ? new Date(best).toISOString() : undefined;
	}

	function startTick(ctx: ExtensionContext) {
		stopTick();
		uiTick = setInterval(() => updateUI(ctx), UI_TICK_MS);
		// unref so the tick never keeps the process alive on its own.
		uiTick.unref?.();
	}
	function stopTick() {
		if (uiTick) {
			clearInterval(uiTick);
			uiTick = undefined;
		}
	}

	// ─── Scheduling (arm/disarm/reschedule) ────────────────────────────────────

	function disarm(id: string) {
		const h = handles.get(id);
		if (!h) return;
		if (h.kind === "cron") h.handle.stop();
		else clearTimeout(h.handle);
		handles.delete(id);
	}

	function disarmAll() {
		for (const id of [...handles.keys()]) disarm(id);
	}

	/** Arm (or re-arm) a single loop's timer. Recomputes the next run. */
	function arm(loop: Loop, ctx: ExtensionContext) {
		if (!loop.enabled || loop.status === "done" || loop.status === "error") return;
		const parsed = safeParsed(loop);
		if (!parsed) return;
		disarm(loop.id);

		if (parsed.type === "cron") {
			try {
				// protect:true + our firing-set guard = belt and suspenders against overlap.
				const cron = new Cron(
					parsed.schedule,
					{ protect: true },
					() => void fire(loop.id, ctx),
				);
				const next = cron.nextRun();
				handles.set(loop.id, { kind: "cron", handle: cron });
				if (next) {
					store.update(loop.id, { nextRun: next.toISOString() });
				}
			} catch {
				store.update(loop.id, { status: "error", enabled: false, lastError: "invalid cron" });
			}
			return;
		}

		// interval or once — setTimeout, capped at the engine max.
		const from = new Date();
		const next = nextRun(parsed, from);
		const dueAt = next.getTime();
		const delay = Math.max(0, dueAt - from.getTime());
		const timerDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

		const timer = setTimeout(() => {
			handles.delete(loop.id);
			// If the delay was capped (very far future), re-arm instead of firing early.
			if (Date.now() < dueAt) {
				arm(loop, ctx);
				return;
			}
			void fire(loop.id, ctx);
		}, timerDelay);
		timer.unref?.();
		handles.set(loop.id, { kind: "timeout", handle: timer });
		store.update(loop.id, { nextRun: next.toISOString() });
	}

	function rescheduleAll(ctx: ExtensionContext) {
		disarmAll();
		for (const l of store.list()) {
			if (l.enabled && l.status !== "done" && l.status !== "error") arm(l, ctx);
		}
		updateUI(ctx);
	}

	// ─── Firing ────────────────────────────────────────────────────────────────

	async function fire(id: string, ctx: ExtensionContext): Promise<void> {
		const loop = store.get(id);
		if (!loop || !loop.enabled || loop.status === "done" || loop.status === "error") return;
		if (firing.has(id)) return; // overlap guard
		firing.add(id);
		try {
			const now = new Date();
			const plan = planFire(loop, now);

			// Re-arm the NEXT run BEFORE executing the action. A throw or crash
			// during execute must not lose the recurrence. For cron, croner
			// re-fires on its own; we only stop it if terminal.
			if (plan.terminal) {
				disarm(id);
			} else if (loop.type === "interval" && plan.nextDelayMs !== undefined) {
				const delay = Math.min(plan.nextDelayMs, MAX_TIMER_DELAY_MS);
				const timer = setTimeout(() => {
					handles.delete(id);
					void fire(id, ctx);
				}, delay);
				timer.unref?.();
				handles.set(id, { kind: "timeout", handle: timer });
				store.update(id, { nextRun: new Date(now.getTime() + delay).toISOString() });
			}
			// cron non-terminal: croner holds the handle; nothing to do.

			store.update(id, { runCount: plan.runCount, lastRun: now.toISOString() });

			// Execute the action.
			let ok = true;
			let errMsg: string | undefined;
			try {
				await executeAction(loop, ctx);
			} catch (err) {
				ok = false;
				errMsg = err instanceof Error ? err.message : String(err);
			}

			// Finalize state.
			if (plan.terminal) {
				store.update(id, {
					enabled: false,
					status: ok ? "done" : "error",
					nextRun: undefined,
					lastStatus: ok ? "success" : "error",
					lastError: errMsg,
				});
			} else {
				store.update(id, {
					lastStatus: ok ? "success" : "error",
					lastError: errMsg,
				});
			}
			void store.persist();
			updateUI(ctx);
		} finally {
			firing.delete(id);
		}
	}

	async function executeAction(loop: Loop, ctx: ExtensionContext): Promise<void> {
		const label = loop.name || loop.id;

		if (loop.action === "notify") {
			const message = loop.message || `🔔 ${label}`;
			if (ctx.hasUI) ctx.ui.notify(message, "info");
			record(ctx, `🔔 ${message}`, { loop });
			return;
		}

		if (loop.action === "prompt") {
			const prompt = buildPromptHeader(loop) + (loop.prompt || "");
			sendAgentPrompt(ctx, prompt);
			return;
		}

		if (loop.action === "message") {
			const message = loop.message || `⏰ ${label}`;
			const triggerTurn = loop.triggerTurn !== false; // default true
			pi.sendMessage(
				{ customType: "loop-fire", content: message, display: true, details: { loop } },
				{ triggerTurn },
			);
			return;
		}

		if (loop.action === "shell") {
			const cwd = loop.cwd || ctx.cwd;
			const timeout = loop.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
			if (ctx.hasUI) ctx.ui.notify(`▶ ${label}: ${loop.command}`, "info");
			const result = await pi.exec("bash", ["-lc", loop.command || ""], { cwd, timeout });
			const summary = {
				command: loop.command,
				cwd,
				code: result.code,
				killed: result.killed,
				ok: result.code === 0 && !result.killed,
				stdout: truncateMiddle(result.stdout, MAX_OUTPUT_CHARS),
				stderr: truncateMiddle(result.stderr, MAX_OUTPUT_CHARS),
			};
			record(ctx, `▣ ${label}: exit ${result.code}`, { loop, result: summary });
			if (loop.followUpPrompt) {
				const block = [
					buildPromptHeader(loop),
					"A scheduled shell command completed.",
					"",
					`Command: \`${loop.command}\``,
					`CWD: \`${cwd}\``,
					`Exit code: ${result.code}${result.killed ? " (killed/timeout)" : ""}`,
					"",
					"STDOUT:",
					"```",
					summary.stdout,
					"```",
					"STDERR:",
					"```",
					summary.stderr,
					"```",
					"",
					loop.followUpPrompt,
				].join("\n");
				sendAgentPrompt(ctx, block);
			}
			return;
		}

		throw new Error(`Unsupported action: ${loop.action}`);
	}

	function buildPromptHeader(loop: Loop): string {
		const parsed = safeParsed(loop);
		const schedLabel = parsed ? describeSchedule(parsed) : loopScheduleLabel(loop);
		return [
			`[Loop "${loop.name || loop.id}" fired]`,
			`Action: ${loop.action}  ·  Schedule: ${schedLabel}`,
			`Run ${loop.runCount + 1}${loop.maxFires ? ` of ${loop.maxFires}` : ""}`,
			"",
		].join("\n");
	}

	function sendAgentPrompt(ctx: ExtensionContext, prompt: string) {
		if (ctx.isIdle()) pi.sendUserMessage(prompt);
		else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
	}

	function record(ctx: ExtensionContext, content: string, details?: Record<string, unknown>) {
		pi.sendMessage({ customType: "loop-fire", content, display: true, details }, { triggerTurn: false });
	}

	// ─── Create helper ─────────────────────────────────────────────────────────

	function createLoop(params: {
		action: ActionType;
		type?: ScheduleType;
		schedule: string;
		name?: string;
		prompt?: string;
		message?: string;
		command?: string;
		cwd?: string;
		timeoutMs?: number;
		followUpPrompt?: string;
		triggerTurn?: boolean;
		enabled?: boolean;
		maxFires?: number;
	}, ctx: ExtensionContext): Loop {
		const type = params.type ?? inferType(params.schedule);
		const parsed = validateSchedule(type, params.schedule, new Date());
		// payload validation per action
		if (params.action === "prompt" && !(params.prompt?.trim())) throw new Error("prompt is required for action 'prompt'");
		if (params.action === "notify" && !(params.message?.trim())) throw new Error("message is required for action 'notify'");
		if (params.action === "message" && !(params.message?.trim())) throw new Error("message is required for action 'message'");
		if (params.action === "shell" && !(params.command?.trim())) throw new Error("command is required for action 'shell'");

		const id = newId();
		const loop = store.add(
			{
				name: params.name,
				action: params.action,
				type: parsed.type,
				schedule: parsed.schedule,
				intervalMs: parsed.intervalMs,
				prompt: params.prompt,
				message: params.message,
				command: params.command,
				cwd: params.cwd ?? ctx.cwd,
				timeoutMs: params.timeoutMs,
				followUpPrompt: params.followUpPrompt,
				triggerTurn: params.triggerTurn,
				enabled: params.enabled,
				maxFires: params.maxFires,
			},
			id,
		);
		arm(loop, ctx);
		updateUI(ctx);
		return loop;
	}

	// ─── Lifecycle ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		store = new LoopStore(loopFilePath(ctx.cwd));
		await store.load();
		activeCtx = ctx;
		rescheduleAll(ctx);
		startTick(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTick();
		disarmAll();
		await store.persist(); // flush write-through mirror before exit
		if (ctx.hasUI) {
			ctx.ui.setStatus("loop", undefined);
			ctx.ui.setWidget("loop", undefined);
		}
		activeCtx = undefined;
	});

	// ─── Renderer for transcript entries ───────────────────────────────────────

	pi.registerMessageRenderer("loop-fire", (message, options, theme) => {
		let text = `${theme.fg("accent", theme.bold("loop"))} ${message.content}`;
		if (options.expanded && message.details) {
			text += `\n${theme.fg("dim", JSON.stringify(message.details, null, 2))}`;
		}
		return new Text(text, 0, 0);
	});

	// ─── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("loop", {
		description: "Create or manage scheduled loops. Usage: /loop [schedule] [prompt]",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			// Quick create: /loop <schedule> <prompt...>
			if (trimmed) {
				const firstSpace = trimmed.search(/\s/);
				if (firstSpace === -1) {
					ctx.ui.notify("Usage: /loop <schedule> <prompt>", "warning");
					return;
				}
				const schedule = trimmed.slice(0, firstSpace);
				const prompt = trimmed.slice(firstSpace + 1).trim();
				if (!prompt) {
					ctx.ui.notify("Usage: /loop <schedule> <prompt>", "warning");
					return;
				}
				try {
					const loop = createLoop({ action: "prompt", schedule, prompt }, ctx);
					ctx.ui.notify(`Created loop "${loop.name}" (${loopScheduleLabel(loop)})`, "info");
				} catch (err) {
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
				}
				return;
			}

			// Interactive manager — native dialogs only (no overlay).
			await manage(ctx);
		},
	});

	pi.registerCommand("loops", {
		description: "List all scheduled loops",
		handler: async (_args, ctx) => {
			await listLoops(ctx);
		},
	});

	async function manage(ctx: ExtensionContext) {
		const choice = await ctx.ui.select("Loops", ["Add a loop…", "List / manage…", "Pause all", "Resume all", "Clear all"]);
		if (!choice) return;
		if (choice === "Add a loop…") return addLoop(ctx);
		if (choice === "List / manage…") return manageOne(ctx);
		if (choice === "Pause all") {
			for (const l of store.list()) {
				if (l.enabled) {
					disarm(l.id);
					store.update(l.id, { enabled: false, status: "paused", nextRun: undefined });
				}
			}
			void store.persist();
			updateUI(ctx);
			ctx.ui.notify("All loops paused", "info");
			return;
		}
		if (choice === "Resume all") {
			for (const l of store.list()) {
				if (!l.enabled && l.status !== "done" && l.status !== "error") {
					store.update(l.id, { enabled: true, status: "active" });
					arm(store.get(l.id)!, ctx);
				}
			}
			updateUI(ctx);
			ctx.ui.notify("All loops resumed", "info");
			return;
		}
		if (choice === "Clear all") {
			const ok = await ctx.ui.confirm("Clear all loops?", "This removes every loop. Cannot be undone.");
			if (!ok) return;
			disarmAll();
			store.clear();
			updateUI(ctx);
			ctx.ui.notify("All loops cleared", "info");
		}
	}

	async function addLoop(ctx: ExtensionContext) {
		// 1. Action
		const actionChoice = await ctx.ui.select("What should the loop do?", [
			"Prompt — wake the agent with a prompt",
			"Notify — show a reminder (no agent wake)",
			"Shell — run a command on a schedule",
			"Message — post a message in the transcript",
		]);
		if (!actionChoice) return;
		const actionMap: Record<string, ActionType> = {
			"Prompt — wake the agent with a prompt": "prompt",
			"Notify — show a reminder (no agent wake)": "notify",
			"Shell — run a command on a schedule": "shell",
			"Message — post a message in the transcript": "message",
		};
		const action = actionMap[actionChoice];

		// 2. Schedule type
		const typeChoice = await ctx.ui.select("Schedule type", [
			"Interval — every N minutes/hours",
			"Once — one-shot at a time",
			"Cron — cron expression",
		]);
		if (!typeChoice) return;
		const typeMap: Record<string, ScheduleType> = {
			"Interval — every N minutes/hours": "interval",
			"Once — one-shot at a time": "once",
			"Cron — cron expression": "cron",
		};
		const type = typeMap[typeChoice];

		// 3. Schedule value (re-prompt on validation error)
		const placeholder: Record<ScheduleType, string> = {
			interval: "e.g. 5m, 1h, 30s, 2h",
			once: "e.g. +10m, tomorrow 9am, 2026-01-01T09:00",
			cron: "e.g. */5 * * * * (every 5 min), 0 9 * * 1-5 (9am weekdays)",
		};
		let schedule: string | undefined;
		let ph = placeholder[type];
		while (true) {
			schedule = await ctx.ui.input("Schedule", ph);
			if (!schedule) return; // cancel
			try {
				validateSchedule(type, schedule.trim());
				schedule = schedule.trim();
				break;
			} catch (err) {
				ph = err instanceof Error ? err.message : "Invalid schedule";
			}
		}

		// 4. Payload per action
		let prompt: string | undefined;
		let message: string | undefined;
		let command: string | undefined;
		let followUpPrompt: string | undefined;
		if (action === "prompt") {
			prompt = await ctx.ui.input("Prompt", "What should the agent do when this fires?");
			if (!prompt) return;
		} else if (action === "notify") {
			message = await ctx.ui.input("Reminder text", "e.g. Standup in 5 minutes");
			if (!message) return;
		} else if (action === "message") {
			message = await ctx.ui.input("Message", "Text to post in the transcript");
			if (!message) return;
		} else {
			command = await ctx.ui.input("Shell command", "e.g. npm test");
			if (!command) return;
			followUpPrompt = (await ctx.ui.input("Follow-up prompt (optional, Enter to skip)", "Wake the agent with the output?")) || undefined;
		}

		// 5. Name (optional)
		const name = (await ctx.ui.input("Name (optional)", "e.g. build-check")) || undefined;

		// 6. maxFires for recurring (optional)
		let maxFires: number | undefined;
		if (type !== "once") {
			const raw = await ctx.ui.input("Max fires (optional, Enter = run forever)", "e.g. 20");
			if (raw) {
				const n = Number(raw);
				if (Number.isInteger(n) && n > 0) maxFires = n;
			}
		}

		try {
			const loop = createLoop(
				{ action, type, schedule, name, prompt, message, command, followUpPrompt, maxFires },
				ctx,
			);
			ctx.ui.notify(`Created loop "${loop.name}" (${loopScheduleLabel(loop)})`, "info");
		} catch (err) {
			ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		}
	}

	async function manageOne(ctx: ExtensionContext) {
		const loops = store.list();
		if (loops.length === 0) {
			ctx.ui.notify("No loops yet. Use /loop to add one.", "info");
			return;
		}
		// ctx.ui.select takes string[]. Build one descriptive line per loop,
		// prefixed with the short id so we can map the choice back uniquely.
		const labelToId = new Map<string, string>();
		const options = loops.map((l) => {
			const glyph = statusGlyph(l);
			const next = l.nextRun && l.enabled ? formatRelative(l.nextRun, new Date()) : l.status;
			const preview = loopPayloadPreview(l);
			const shortId = l.id.slice(0, 12);
			const label = `${glyph} ${l.name} [${shortId}] ${loopScheduleLabel(l)} · ${next} · ×${l.runCount} · ${l.action}${preview ? ` :: ${preview}` : ""}`;
			labelToId.set(label, l.id);
			return label;
		});
		const chosen = await ctx.ui.select("Select a loop", options);
		if (!chosen) return;
		const loop = store.get(labelToId.get(chosen)!);
		if (!loop) return;

		const opts: string[] = [];
		if (loop.enabled) opts.push("Pause");
		else if (loop.status !== "done" && loop.status !== "error") opts.push("Resume");
		opts.push("Run now", "Delete");

		const action = await ctx.ui.select(`${loop.name} (${loopScheduleLabel(loop)})`, opts);
		if (!action) return;

		if (action === "Pause") {
			disarm(loop.id);
			store.update(loop.id, { enabled: false, status: "paused", nextRun: undefined });
			void store.persist();
			updateUI(ctx);
			ctx.ui.notify(`Paused "${loop.name}"`, "info");
		} else if (action === "Resume") {
			const updated = store.update(loop.id, { enabled: true, status: "active" })!;
			arm(updated, ctx);
			ctx.ui.notify(`Resumed "${loop.name}"`, "info");
		} else if (action === "Run now") {
			ctx.ui.notify(`Firing "${loop.name}" now…`, "info");
			void fire(loop.id, ctx);
		} else if (action === "Delete") {
			disarm(loop.id);
			store.remove(loop.id);
			updateUI(ctx);
			ctx.ui.notify(`Deleted "${loop.name}"`, "info");
		}
	}

	async function listLoops(ctx: ExtensionContext) {
		const loops = store.list();
		if (loops.length === 0) {
			record(ctx, "No loops scheduled. Use /loop to create one.", {});
			return;
		}
		const lines = ["Loops:"];
		for (const l of loops) {
			const next = l.nextRun && l.enabled ? formatRelative(l.nextRun, new Date()) : l.status;
			const payload = loopPayloadPreview(l);
			lines.push(
				`  ${statusGlyph(l)} ${l.id} ${l.name} [${l.action}/${l.type}] ${loopScheduleLabel(l)} next=${next} runs=${l.runCount}${l.lastStatus === "error" ? " last=error" : ""}${payload ? ` :: ${payload}` : ""}`,
			);
		}
		record(ctx, lines.join("\n"), { loops });
		updateUI(ctx);
	}

	// ─── Tools (for the LLM to self-schedule) ──────────────────────────────────

	pi.registerTool({
		name: "schedule_loop",
		label: "Schedule Loop",
		description:
			"Schedule a recurring or one-shot loop in this Pi session that can wake the agent with a prompt, run a shell command, post a message, or notify the user. Persists across restarts. Shows in the status bar.",
		promptSnippet: "Schedule a recurring or one-shot loop (prompt/notify/shell/message) on a timer or cron",
		promptGuidelines: [
			"Use schedule_loop when the user asks to do something periodically or later — 'check CI every 5 min', 'remind me at 9am', 'poll the build'.",
			"Use type='interval' for durations (5m, 1h), type='once' for one-shot ('+10m', 'tomorrow 9am'), type='cron' for cron expressions ('*/5 * * * *').",
			"For bounded polling, set maxFires so interval loops don't run forever.",
		],
		parameters: Type.Object({
			action: StringEnum(["prompt", "notify", "shell", "message"] as const, {
				description: "What the loop does when it fires. 'prompt' wakes the agent.",
			}),
			type: Type.Optional(
				StringEnum(["interval", "once", "cron"] as const, {
					description: "Schedule type. If omitted, inferred from the schedule string.",
				}),
			),
			schedule: Type.String({
				description: "Interval '5m'/'1h'/'30s', once '+10m'/'tomorrow 9am'/ISO, or cron '*/5 * * * *'.",
			}),
			prompt: Type.Optional(Type.String({ description: "Required for action 'prompt'." })),
			message: Type.Optional(Type.String({ description: "Required for actions 'notify' and 'message'." })),
			command: Type.Optional(Type.String({ description: "Required for action 'shell'." })),
			followUpPrompt: Type.Optional(
				Type.String({ description: "Shell: wake the agent with command output + this prompt after it runs." }),
			),
			cwd: Type.Optional(Type.String({ description: "Shell working directory. Defaults to current cwd." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Shell timeout ms.", minimum: 1000 })),
			name: Type.Optional(Type.String({ description: "Human-readable loop name." })),
			maxFires: Type.Optional(
				Type.Number({ description: "Stop after this many fires (recurring only).", minimum: 1 }),
			),
			enabled: Type.Optional(Type.Boolean({ description: "Start enabled. Default true." })),
			triggerTurn: Type.Optional(
				Type.Boolean({ description: "Message action: trigger an agent turn. Default true." }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loop = createLoop(params as Parameters<typeof createLoop>[0], ctx);
			return {
				content: [{ type: "text", text: `Created loop "${loop.name}" (${loopScheduleLabel(loop)}, ${loop.action}). id=${loop.id}` }],
				details: { loop },
			};
		},
		renderCall(args, theme) {
			return new Text(
				`${theme.fg("toolTitle", theme.bold("schedule_loop"))} ${theme.fg("muted", args.action)}/${theme.fg("muted", args.type ?? "auto")} ${theme.fg("accent", args.schedule ?? "")}`,
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content?.[0];
			return new Text(theme.fg("success", "✓ ") + (text?.type === "text" ? text.text : "Loop created"), 0, 0);
		},
	});

	pi.registerTool({
		name: "list_loops",
		label: "List Loops",
		description: "List all scheduled loops with status, schedule, next run, and run count.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const loops = store.list();
			if (loops.length === 0) {
				return { content: [{ type: "text", text: "No loops scheduled." }], details: {} };
			}
			const lines = loops.map((l) => {
				const next = l.nextRun && l.enabled ? formatRelative(l.nextRun, new Date()) : l.status;
				return `- ${l.id} ${l.name} [${l.action}/${l.type}] ${loopScheduleLabel(l)} next=${next} runs=${l.runCount}${l.lastStatus === "error" ? " last=error" : ""}`;
			});
			return {
				content: [{ type: "text", text: `${loops.length} loop(s):\n${lines.join("\n")}` }],
				details: { loops },
			};
		},
	});

	pi.registerTool({
		name: "stop_loop",
		label: "Stop Loop",
		description: "Pause or delete a scheduled loop by id, id prefix, or unique name.",
		parameters: Type.Object({
			query: Type.String({ description: "Loop id, id prefix, or unique name." }),
			delete: Type.Optional(Type.Boolean({ description: "Permanently delete instead of pausing. Default false." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const loop = store.find(params.query);
			if (!loop) throw new Error(`No loop matching "${params.query}"`);
			if (params.delete) {
				disarm(loop.id);
				store.remove(loop.id);
				updateUI(ctx);
				return { content: [{ type: "text", text: `Deleted loop "${loop.name}".` }], details: { loop } };
			}
			disarm(loop.id);
			store.update(loop.id, { enabled: false, status: "paused", nextRun: undefined });
			void store.persist();
			updateUI(ctx);
			return { content: [{ type: "text", text: `Paused loop "${loop.name}".` }], details: { loop } };
		},
	});
}
