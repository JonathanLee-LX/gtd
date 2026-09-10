/** In-memory per-user counters. Fine for single-Worker personal use. */

export const AI_PARSE_LIMIT_PER_MINUTE = 10;
export const AI_PARSE_LIMIT_PER_DAY = 100;

type Window = {
	minuteStart: number;
	minuteCount: number;
	dayStart: number;
	dayCount: number;
};

const store = new Map<string, Window>();

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

function dayKey(now: number): number {
	return Math.floor(now / DAY_MS) * DAY_MS;
}

function minuteKey(now: number): number {
	return Math.floor(now / MINUTE_MS) * MINUTE_MS;
}

export type RateLimitResult =
	| { ok: true }
	| { ok: false; scope: "minute" | "day"; limit: number };

/**
 * Check and consume one request for `key` (e.g. user id).
 * Returns whether the request is allowed under per-minute / per-day caps.
 */
export function consumeRateLimit(
	key: string,
	opts: {
		perMinute?: number;
		perDay?: number;
		now?: number;
	} = {},
): RateLimitResult {
	const perMinute = opts.perMinute ?? AI_PARSE_LIMIT_PER_MINUTE;
	const perDay = opts.perDay ?? AI_PARSE_LIMIT_PER_DAY;
	const now = opts.now ?? Date.now();
	const mStart = minuteKey(now);
	const dStart = dayKey(now);

	let window = store.get(key);
	if (!window) {
		window = {
			minuteStart: mStart,
			minuteCount: 0,
			dayStart: dStart,
			dayCount: 0,
		};
		store.set(key, window);
	}

	if (window.dayStart !== dStart) {
		window.dayStart = dStart;
		window.dayCount = 0;
	}
	if (window.minuteStart !== mStart) {
		window.minuteStart = mStart;
		window.minuteCount = 0;
	}

	if (window.dayCount >= perDay) {
		return { ok: false, scope: "day", limit: perDay };
	}
	if (window.minuteCount >= perMinute) {
		return { ok: false, scope: "minute", limit: perMinute };
	}

	window.minuteCount += 1;
	window.dayCount += 1;
	return { ok: true };
}

/** Test helper — clear all counters. */
export function resetRateLimits(): void {
	store.clear();
}

/** Test helper — inspect counters for a key. */
export function peekRateLimit(key: string): Window | undefined {
	const w = store.get(key);
	return w ? { ...w } : undefined;
}
