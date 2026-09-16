// LoopStore — authoritative in-memory state with a write-through disk mirror.
//
// INVARIANTS (these are what make recurring loops bulletproof, unlike jl1990
// which reloaded from disk mid-fire and clobbered live reschedule state):
//   1. In-memory Map is the single source of truth while pi is running.
//   2. Disk is a write-through mirror: every mutation persists immediately,
//      partitioned by scope: global loops → shared project file, session loops
//      → .pi/loops/<sessionId>.json (one writer per file, no cross-session races).
//   3. Disk is read ONCE, at session_start (load). No command/tool handler
//      ever reloads from disk into the live map. This eliminates the entire
//      class of "runtime state clobbered by stale disk read" bugs.
//   4. Writes are atomic (temp file + rename) and serialized via a promise
//      queue so concurrent mutations never tear the JSON.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { nextRun, validateSchedule, type ActionType, type ScheduleType } from "./schedule.ts";

export type LoopStatus = "active" | "paused" | "done" | "error";
export type LoopScope = "session" | "global";

export interface Loop {
	id: string;
	name?: string;
	/** Arming scope: "session" fires only in the owner session; "global" in every pi on this path (legacy behavior). */
	scope: LoopScope;
	/** Session id of the loop's owner (required for session scope; provenance only for global). */
	owner?: string;
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
	/** Force delivery: when the agent is busy, steer this loop's fire in at the next tool-call boundary instead of deferring to agent_settled. */
	force?: boolean;
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
	scope?: LoopScope;
	owner?: string;
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
	force?: boolean;
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

/** Arming decision: global loops arm in every session on the path; session loops only in the session that owns them. */
export function shouldArm(loop: Loop, sessionId: string | undefined): boolean {
	if (loop.scope !== "session") return true;
	return !!sessionId && loop.owner === sessionId;
}

export class LoopStore {
	private loops = new Map<string, Loop>();
	private filePath: string;
	/** Per-session file for session-scoped loops. Only the owner session ever reads/writes it. */
	private sessionFilePath?: string;
	private saveQueue: Promise<void> = Promise.resolve();
	private loaded = false;

	/** @param filePath shared project file (global loops). @param sessionFilePath per-session file (session loops); when omitted, the store behaves exactly like the legacy single-file store. */
	constructor(filePath: string, sessionFilePath?: string) {
		this.filePath = filePath;
		this.sessionFilePath = sessionFilePath;
	}

	/** Load from disk: the shared global file plus (when configured) this session's own file.
	 * Call once at session_start. Safe to call again (idempotent overwrite).
	 * Other sessions' files are deliberately NOT read — a session loop is invisible outside its owner. */
	async load(): Promise<void> {
		this.loaded = true;
		this.loops.clear();
		const paths = this.sessionFilePath ? [this.filePath, this.sessionFilePath] : [this.filePath];
		for (const p of paths) {
			let raw: string;
			try {
				raw = await readFile(p, "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw err;
			}
			try {
				const parsed = JSON.parse(raw) as Partial<FileShape>;
				const list = Array.isArray(parsed.loops) ? parsed.loops : [];
				for (const item of list) {
					const loop = normalizeLoop(item);
					if (loop) this.loops.set(loop.id, loop);
				}
			} catch {
				// corrupt file: skip it, keep whatever loaded so far. (ponytail: no backup dance.)
			}
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
		const q = query.trim().toLowerCase();
		if (!q) return undefined;
		const byId = this.loops.get(query.trim());
		if (byId) return byId;
		const idPrefix = this.list().filter((l) => l.id.toLowerCase().startsWith(q));
		if (idPrefix.length === 1) return idPrefix[0];
		const named = this.list().filter((l) => l.name !== undefined);
		const nameExact = named.filter((l) => l.name!.toLowerCase() === q);
		if (nameExact.length === 1) return nameExact[0];
		const namePrefix = named.filter((l) => l.name!.toLowerCase().startsWith(q));
		if (namePrefix.length === 1) return namePrefix[0];
		// Untitled loops: match by payload prefix so `/loop pause <payload-text>` still works.
		const payloadPrefix = this.list().filter((l) => payloadOf(l).startsWith(q));
		if (payloadPrefix.length === 1) return payloadPrefix[0];
		return undefined;
	}

	add(input: NewLoopInput, id: string): Loop {
		const now = new Date().toISOString();
		const loop: Loop = {
			id,
			name: input.name?.trim() || undefined,
			scope: input.scope ?? "global",
			owner: input.owner,
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
			force: input.force,
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

	/** Atomic, serialized write to disk. Partitions by scope: global loops to the
	 * shared project file, session loops to this session's file (single writer each).
	 * Without a session path, everything writes to the shared file — legacy single-file mode. */
	persist(): Promise<void> {
		const loops = this.list();
		const globalLoops = this.sessionFilePath ? loops.filter((l) => l.scope !== "session") : loops;
		const sessionLoops = this.sessionFilePath ? loops.filter((l) => l.scope === "session") : [];
		this.saveQueue = this.saveQueue.then(async () => {
			await this.writeLoops(this.filePath, globalLoops);
			if (this.sessionFilePath) await this.writeLoops(this.sessionFilePath, sessionLoops);
		});
		return this.saveQueue;
	}

	/** Atomic write (temp + rename) of one file's payload. Best-effort: never crashes the agent. */
	private async writeLoops(path: string, loops: Loop[]): Promise<void> {
		const payload: FileShape = {
			version: 1,
			updatedAt: new Date().toISOString(),
			loops,
		};
		const json = `${JSON.stringify(payload, null, 2)}\n`;
		try {
			await mkdir(dirname(path), { recursive: true });
			const tmp = `${path}.${process.pid}.tmp`;
			await writeFile(tmp, json, "utf8");
			await rename(tmp, path);
		} catch {
			// best-effort: a failed persist must not crash the agent.
		}
	}

	get isLoaded(): boolean {
		return this.loaded;
	}
}

/** Coerce a raw persisted object into a valid Loop, or drop it. */
function payloadOf(loop: Loop): string {
	return (loop.prompt ?? loop.message ?? loop.command ?? "").replace(/\n/g, " ").trim().toLowerCase();
}


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
	// Back-compat: records from before scopes existed (no scope/owner) load as global — today's shared behavior.
	const owner = typeof r.owner === "string" && r.owner.trim() ? r.owner : undefined;
	const scope: LoopScope = r.scope === "session" && owner ? "session" : "global";
	return {
		id: r.id,
		name: typeof r.name === "string" && r.name.trim() ? r.name : undefined,
		scope,
		owner,
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
		force: typeof r.force === "boolean" ? r.force : undefined,
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
