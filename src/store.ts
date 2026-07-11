// LoopStore — authoritative in-memory state with a write-through disk mirror.
//
// INVARIANTS (these are what make recurring loops bulletproof, unlike jl1990
// which reloaded from disk mid-fire and clobbered live reschedule state):
//   1. In-memory Map is the single source of truth while pi is running.
//   2. Disk is a write-through mirror: every mutation persists immediately.
//   3. Disk is read ONCE, at session_start (load). No command/tool handler
//      ever reloads from disk into the live map. This eliminates the entire
//      class of "runtime state clobbered by stale disk read" bugs.
//   4. Writes are atomic (temp file + rename) and serialized via a promise
//      queue so concurrent mutations never tear the JSON.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nextRun, validateSchedule, type ActionType, type ScheduleType } from "./schedule.ts";

export type LoopStatus = "active" | "paused" | "done" | "error";

export interface Loop {
	id: string;
	name: string;
	action: ActionType;
	type: ScheduleType;
	/** Normalized schedule expression. */
	schedule: string;
	/** Only for interval / relative once. */
	intervalMs?: number;
	/** Action payloads. */
	prompt?: string;
	message?: string;
	command?: string;
	cwd?: string;
	timeoutMs?: number;
	/** Shell: wake the agent with this prompt + command output after it runs. */
	followUpPrompt?: string;
	/** Message action: whether to trigger an agent turn. Default true. */
	triggerTurn?: boolean;
	/** Lifecycle. */
	enabled: boolean;
	maxFires?: number;
	runCount: number;
	createdAt: string;
	lastRun?: string;
	lastStatus?: "success" | "error";
	lastError?: string;
	nextRun?: string;
	status: LoopStatus;
}

interface FileShape {
	version: 1;
	updatedAt: string;
	loops: Loop[];
}

export interface NewLoopInput {
	name?: string;
	action: ActionType;
	type: ScheduleType;
	schedule: string;
	intervalMs?: number;
	prompt?: string;
	message?: string;
	command?: string;
	cwd?: string;
	timeoutMs?: number;
	followUpPrompt?: string;
	triggerTurn?: boolean;
	enabled?: boolean;
	maxFires?: number;
}

export function newId(): string {
	return `loop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Pure recurrence decision for a single fire. Exported so fire() and tests share one code path. */
export interface FirePlan {
	/** Run count AFTER this fire fires. */
	runCount: number;
	/** True if this fire makes the loop terminal (one-shot, or maxFires reached). */
	terminal: boolean;
	/** For non-terminal interval loops: ms from `now` until the next run. Undefined for cron (croner owns recurrence). */
	nextDelayMs?: number;
}

function safeParsedSchedule(loop: Loop) {
	try {
		return validateSchedule(loop.type, loop.schedule, new Date(), { allowPast: true });
	} catch {
		return null;
	}
}

/** Compute what a fire of `loop` at `now` should do to its bookkeeping and next-run schedule. */
export function planFire(loop: Loop, now: Date = new Date()): FirePlan {
	const runCount = loop.runCount + 1;
	const reachedMax = loop.maxFires !== undefined && runCount >= loop.maxFires;
	const terminal = loop.type === "once" || reachedMax;
	let nextDelayMs: number | undefined;
	if (!terminal && loop.type === "interval") {
		const parsed = safeParsedSchedule(loop);
		if (parsed) {
			const next = nextRun(parsed, now);
			nextDelayMs = Math.max(0, next.getTime() - now.getTime());
		}
	}
	return { runCount, terminal, nextDelayMs };
}

export class LoopStore {
	private loops = new Map<string, Loop>();
	private filePath: string;
	private saveQueue: Promise<void> = Promise.resolve();
	private loaded = false;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	/** Load from disk. Call once at session_start. Safe to call again (idempotent overwrite). */
	async load(): Promise<void> {
		this.loaded = true;
		let raw: string;
		try {
			raw = await readFile(this.filePath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				this.loops.clear();
				return;
			}
			throw err;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<FileShape>;
			const list = Array.isArray(parsed.loops) ? parsed.loops : [];
			this.loops.clear();
			for (const raw of list) {
				const loop = normalizeLoop(raw);
				if (loop) this.loops.set(loop.id, loop);
			}
		} catch {
			// corrupt file: start empty rather than crash. (ponytail: no backup dance.)
			this.loops.clear();
		}
	}

	list(): Loop[] {
		return [...this.loops.values()];
	}

	get(id: string): Loop | undefined {
		return this.loops.get(id);
	}

	/** Find by exact id, unique id prefix, or unique case-insensitive name. */
	find(query: string): Loop | undefined {
		const q = query.trim();
		if (!q) return undefined;
		const byId = this.loops.get(q);
		if (byId) return byId;
		const prefixMatches = this.list().filter((l) => l.id.startsWith(q));
		if (prefixMatches.length === 1) return prefixMatches[0];
		const nameMatches = this.list().filter((l) => l.name.toLowerCase() === q.toLowerCase());
		if (nameMatches.length === 1) return nameMatches[0];
		return undefined;
	}

	add(input: NewLoopInput, id: string): Loop {
		const now = new Date().toISOString();
		const loop: Loop = {
			id,
			name: input.name?.trim() || id,
			action: input.action,
			type: input.type,
			schedule: input.schedule,
			intervalMs: input.intervalMs,
			prompt: input.prompt,
			message: input.message,
			command: input.command,
			cwd: input.cwd,
			timeoutMs: input.timeoutMs,
			followUpPrompt: input.followUpPrompt,
			triggerTurn: input.triggerTurn,
			enabled: input.enabled ?? true,
			maxFires: input.maxFires,
			runCount: 0,
			createdAt: now,
			status: "active",
		};
		this.loops.set(id, loop);
		void this.persist();
		return loop;
	}

	update(id: string, patch: Partial<Loop>): Loop | undefined {
		const loop = this.loops.get(id);
		if (!loop) return undefined;
		Object.assign(loop, patch);
		void this.persist();
		return loop;
	}

	remove(id: string): Loop | undefined {
		const loop = this.loops.get(id);
		if (!loop) return undefined;
		this.loops.delete(id);
		void this.persist();
		return loop;
	}

	clear(): void {
		this.loops.clear();
		void this.persist();
	}

	/** Atomic, serialized write to disk. */
	persist(): Promise<void> {
		const payload: FileShape = {
			version: 1,
			updatedAt: new Date().toISOString(),
			loops: this.list(),
		};
		const json = `${JSON.stringify(payload, null, 2)}\n`;
		this.saveQueue = this.saveQueue.then(async () => {
			try {
				await mkdir(dirname(this.filePath), { recursive: true });
				const tmp = `${this.filePath}.${process.pid}.tmp`;
				await writeFile(tmp, json, "utf8");
				await rename(tmp, this.filePath);
			} catch {
				// best-effort: a failed persist must not crash the agent.
			}
		});
		return this.saveQueue;
	}

	get isLoaded(): boolean {
		return this.loaded;
	}
}

/** Coerce a raw persisted object into a valid Loop, or drop it. */
function normalizeLoop(raw: unknown): Loop | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || typeof r.schedule !== "string") return undefined;
	const actions: ActionType[] = ["prompt", "notify", "shell", "message"];
	const types: ScheduleType[] = ["interval", "once", "cron"];
	const action = actions.includes(r.action as ActionType) ? (r.action as ActionType) : "prompt";
	const type = types.includes(r.type as ScheduleType) ? (r.type as ScheduleType) : "interval";
	const statuses: LoopStatus[] = ["active", "paused", "done", "error"];
	const status = statuses.includes(r.status as LoopStatus) ? (r.status as LoopStatus) : "active";
	return {
		id: r.id,
		name: typeof r.name === "string" ? r.name : r.id,
		action,
		type,
		schedule: r.schedule,
		intervalMs: typeof r.intervalMs === "number" ? r.intervalMs : undefined,
		prompt: typeof r.prompt === "string" ? r.prompt : undefined,
		message: typeof r.message === "string" ? r.message : undefined,
		command: typeof r.command === "string" ? r.command : undefined,
		cwd: typeof r.cwd === "string" ? r.cwd : undefined,
		timeoutMs: typeof r.timeoutMs === "number" ? r.timeoutMs : undefined,
		followUpPrompt: typeof r.followUpPrompt === "string" ? r.followUpPrompt : undefined,
		triggerTurn: typeof r.triggerTurn === "boolean" ? r.triggerTurn : undefined,
		enabled: typeof r.enabled === "boolean" ? r.enabled : status === "active",
		maxFires: typeof r.maxFires === "number" ? r.maxFires : undefined,
		runCount: typeof r.runCount === "number" ? r.runCount : 0,
		createdAt: typeof r.createdAt === "string" ? r.createdAt : new Date().toISOString(),
		lastRun: typeof r.lastRun === "string" ? r.lastRun : undefined,
		lastStatus: r.lastStatus === "success" || r.lastStatus === "error" ? r.lastStatus : undefined,
		lastError: typeof r.lastError === "string" ? r.lastError : undefined,
		nextRun: typeof r.nextRun === "string" ? r.nextRun : undefined,
		status,
	};
}
