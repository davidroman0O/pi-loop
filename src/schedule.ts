// Schedule parsing & validation for pi-loop.
// Three types: interval (duration), once (relative or absolute time), cron (croner expr).
// Pure functions, no Pi deps — easy to unit-test in isolation.

import { Cron } from "croner";

export type ScheduleType = "interval" | "once" | "cron";
export type ActionType = "prompt" | "notify" | "shell" | "message";

export interface ParsedSchedule {
	type: ScheduleType;
	/** Normalized schedule expression stored on the loop. */
	schedule: string;
	/** Milliseconds, only for interval. */
	intervalMs?: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const UNITS: Array<[RegExp, number]> = [
	[/w(?:eeks?|k)?/i, WEEK],
	[/d(?:ays?)?/i, DAY],
	[/h(?:rs?|ours?)?/i, HOUR],
	[/m(?:ins?|inutes?)?/i, MINUTE],
	[/s(?:ecs?|econds?)?/i, SECOND],
];

/** Parse a human duration into ms. Accepts "5m", "1h30m", "90s", "2d", "in 10 minutes", "every 5m", "+5m". Returns null if unparseable. */
export function parseDurationMs(text: string): number | null {
	let s = text.trim().toLowerCase();
	if (!s) return null;
	s = s
		.replace(/^in\s+/, "")
		.replace(/^every\s+/, "")
		.replace(/^a\s+/, "") // "an hour" / "a day"
		.replace(/^\+/, "")
		.trim();
	if (!s) return null;

	// bare word forms: "hourly" → 1h, "daily" → 1d, "weekly" → 1w
	const bare: Record<string, number> = {
		hourly: HOUR,
		daily: DAY,
		weekly: WEEK,
		minutely: MINUTE,
	};
	if (bare[s]) return bare[s];

	// "an hour" / "a minute" after stripping leading "a "
	if (s === "hour") return HOUR;
	if (s === "minute") return MINUTE;
	if (s === "second") return SECOND;
	if (s === "day") return DAY;
	if (s === "week") return WEEK;

	const re = /(\d+(?:\.\d+)?)\s*(weeks?|w|days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)/gi;
	let total = 0;
	let cursor = 0;
	let matched = false;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		// reject gaps between matches (e.g. "5m and 3h" ok only if "and"/spaces)
		const between = s.slice(cursor, m.index).replace(/[\s,]/g, "").replace(/\band\b/gi, "");
		if (between !== "") return null;
		const val = Number(m[1]);
		const unitMs = unitToMs(m[2]);
		if (!Number.isFinite(val) || val <= 0 || !unitMs) return null;
		total += val * unitMs;
		matched = true;
		cursor = re.lastIndex;
	}
	if (!matched) return null;
	// trailing junk → invalid
	if (s.slice(cursor).replace(/[\s,]/g, "").replace(/\band\b/gi, "") !== "") return null;
	return Math.round(total);
}

function unitToMs(unit: string): number | undefined {
	for (const [re, ms] of UNITS) {
		if (re.test(unit)) return ms;
	}
	return undefined;
}

/** Parse a clock-time expression to an epoch ms. Returns null if not a clock expression. */
function parseClockExpression(text: string, now: Date): number | null {
	let s = text.trim().toLowerCase();
	if (!s) return null;

	// "tomorrow" → same time tomorrow; "today" → now
	if (s === "tomorrow") return now.getTime() + DAY;
	if (s === "today") return now.getTime();

	let dayOffset: number | undefined;
	if (s.startsWith("tomorrow ")) {
		dayOffset = 1;
		s = s.slice("tomorrow ".length).trim();
	} else if (s.startsWith("today ")) {
		dayOffset = 0;
		s = s.slice("today ".length).trim();
	}

	let hadAt = false;
	if (s.startsWith("at ")) {
		hadAt = true;
		s = s.slice(3).trim();
	}
	if (!s) return null;

	const tm = parseTimeToken(s, hadAt || dayOffset !== undefined);
	if (!tm) return null;

	const target = new Date(now.getTime());
	if (dayOffset !== undefined) target.setDate(target.getDate() + dayOffset);
	target.setHours(tm.hour, tm.minute, 0, 0);

	// if no explicit day and the time already passed today, roll to tomorrow
	if (dayOffset === undefined && target.getTime() <= now.getTime()) {
		target.setDate(target.getDate() + 1);
	}
	return target.getTime();
}

function parseTimeToken(text: string, allowBareHour: boolean): { hour: number; minute: number } | null {
	const m = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
	if (!m) return null;
	const hasColon = m[2] !== undefined;
	const suffix = m[3]?.toLowerCase();
	if (!hasColon && !suffix && !allowBareHour) return null;

	let hour = Number(m[1]);
	const minute = m[2] === undefined ? 0 : Number(m[2]);
	if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

	if (suffix) {
		if (hour < 1 || hour > 12) return null;
		if (suffix === "am") hour = hour === 12 ? 0 : hour;
		else hour = hour === 12 ? 12 : hour + 12; // pm
	} else if (hour < 0 || hour > 23) {
		return null;
	}
	return { hour, minute };
}

export interface ValidateOptions {
	/** Allow past absolute times for `once` (used when restoring state). Defaults to false. */
	allowPast?: boolean;
}

/** Validate and normalize a schedule expression for the given type. Throws on invalid input. */
export function validateSchedule(
	type: ScheduleType,
	schedule: string,
	_now: Date = new Date(),
	opts: ValidateOptions = {},
): ParsedSchedule {
	const s = schedule.trim();
	if (!s) throw new Error("Schedule is required");

	if (type === "interval") {
		const ms = parseDurationMs(s);
		if (!ms || ms < 1000) throw new Error(`Invalid interval: "${s}". Use a duration like 5m, 1h, 30s.`);
		return { type, schedule: s, intervalMs: ms };
	}

	if (type === "once") {
		// relative duration?
		const ms = parseDurationMs(s);
		if (ms !== null) {
			return { type, schedule: s, intervalMs: ms };
		}
		// clock expression ("9am", "tomorrow 9am", "at 18:30")
		const clockMs = parseClockExpression(s, _now);
		if (clockMs !== null) {
			if (!opts.allowPast && clockMs <= _now.getTime()) {
				throw new Error(`Scheduled time is in the past: "${s}"`);
			}
			return { type, schedule: s };
		}
		// absolute ISO / Date-parseable
		const absMs = Date.parse(s);
		if (!Number.isNaN(absMs)) {
			if (!opts.allowPast && absMs <= _now.getTime()) {
				throw new Error(`Scheduled time is in the past: "${s}"`);
			}
			return { type, schedule: s };
		}
		throw new Error(`Could not parse time: "${s}". Try "5m", "tomorrow 9am", or an ISO timestamp.`);
	}

	// cron
	try {
		const job = new Cron(s, { paused: true }, () => {});
		const next = job.nextRun(_now);
		job.stop();
		if (!next) throw new Error("No future run for this cron expression");
		return { type, schedule: s };
	} catch (err) {
		throw new Error(`Invalid cron expression: "${s}"${err instanceof Error ? ` (${err.message})` : ""}`);
	}
}

/** Compute the next run Date for a parsed schedule from the given origin. */
export function nextRun(parsed: ParsedSchedule, from: Date = new Date()): Date {
	if (parsed.type === "interval" || (parsed.type === "once" && parsed.intervalMs !== undefined)) {
		const ms = parsed.intervalMs ?? 0;
		return new Date(from.getTime() + ms);
	}
	if (parsed.type === "once") {
		// absolute clock/ISO — the stored schedule string is the target; recompute clock
		const clockMs = parseClockExpression(parsed.schedule, from);
		if (clockMs !== null) return new Date(clockMs);
		const absMs = Date.parse(parsed.schedule);
		if (!Number.isNaN(absMs)) return new Date(absMs);
		return new Date(from.getTime() + 60_000); // fallback: 1m
	}
	// cron
	const job = new Cron(parsed.schedule, { paused: true }, () => {});
	const next = job.nextRun(from);
	job.stop();
	return next ?? new Date(from.getTime() + 60_000);
}

/** Human-readable description, e.g. "every 5m", "at 9am", "cron every-5-min". */
export function describeSchedule(parsed: ParsedSchedule): string {
	if (parsed.type === "interval") return `every ${parsed.schedule}`;
	if (parsed.type === "once") {
		if (parsed.intervalMs !== undefined) return `once in ${parsed.schedule}`;
		return `once at ${parsed.schedule}`;
	}
	return `cron ${parsed.schedule}`;
}

/** Infer schedule type heuristically from a raw string, for the quick-create command. */
export function inferType(raw: string): ScheduleType {
	const s = raw.trim();
	// 5+ field whitespace-separated with digit/*/- → cron
	if (/^(\S+\s+){3,}\S+$/.test(s) && /[*0-9/,-]/.test(s) && !parseDurationMs(s)) {
		return "cron";
	}
	if (parseDurationMs(s) !== null) return "interval";
	return "once";
}
