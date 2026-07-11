// Human-readable formatting helpers for pi-loop.

import type { Loop } from "./store.ts";
import { describeSchedule, validateSchedule, type ParsedSchedule } from "./schedule.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Format an ISO timestamp (or ms) relative to now: "in 4m 12s", "due now", "paused", "—". */
export function formatRelative(iso: string | undefined, now: Date = new Date()): string {
	if (!iso) return "—";
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return "—";
	let diff = t - now.getTime();
	const past = diff <= 0;
	if (past && diff > -10_000) return "due now";
	if (past) diff = -diff;

	const parts: string[] = [];
	const d = Math.floor(diff / DAY);
	if (d > 0) parts.push(`${d}d`);
	const rem = diff - d * DAY;
	const h = Math.floor(rem / HOUR);
	if (h > 0) parts.push(`${h}h`);
	const rem2 = rem - h * HOUR;
	const m = Math.floor(rem2 / MINUTE);
	if (m > 0) parts.push(`${m}m`);
	const rem3 = rem2 - m * MINUTE;
	const s = Math.floor(rem3 / 1000);
	// only show seconds if nothing coarser shown, or to fill a second slot
	if (parts.length < 2) {
		if (s > 0 || parts.length === 0) parts.push(`${s}s`);
	}
	const out = parts.slice(0, 2).join(" ") || "0s";
	return past ? `${out} ago` : `in ${out}`;
}

/** Re-validate and describe a loop's schedule for display. Never throws. */
export function loopScheduleLabel(loop: Loop): string {
	try {
		const parsed = validateSchedule(loop.type, loop.schedule, new Date(), { allowPast: true });
		return describeSchedule(parsed);
	} catch {
		return loop.schedule || "(invalid)";
	}
}

/** Cached parsed schedule, or null if invalid. */
export function safeParsed(loop: Loop): ParsedSchedule | null {
	try {
		return validateSchedule(loop.type, loop.schedule, new Date(), { allowPast: true });
	} catch {
		return null;
	}
}

/** Short summary of the loop's payload (prompt text / message / command). */
export function loopPayloadPreview(loop: Loop): string {
	const raw = loop.prompt ?? loop.message ?? loop.command ?? "";
	if (!raw) return "";
	const oneLine = raw.replace(/\n/g, " ").trim();
	return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}
