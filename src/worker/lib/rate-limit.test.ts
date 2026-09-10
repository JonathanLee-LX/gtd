import { afterEach, describe, expect, it } from "vitest";
import {
	AI_PARSE_LIMIT_PER_DAY,
	AI_PARSE_LIMIT_PER_MINUTE,
	consumeRateLimit,
	peekRateLimit,
	resetRateLimits,
} from "./rate-limit";

afterEach(() => {
	resetRateLimits();
});

describe("consumeRateLimit", () => {
	it("allows requests under per-minute and per-day caps", () => {
		const now = 1_700_000_000_000;
		for (let i = 0; i < AI_PARSE_LIMIT_PER_MINUTE; i++) {
			expect(consumeRateLimit("u1", { now }).ok).toBe(true);
		}
		const peek = peekRateLimit("u1");
		expect(peek?.minuteCount).toBe(AI_PARSE_LIMIT_PER_MINUTE);
		expect(peek?.dayCount).toBe(AI_PARSE_LIMIT_PER_MINUTE);
	});

	it("blocks when per-minute limit is exceeded", () => {
		const now = 1_700_000_000_000;
		for (let i = 0; i < 3; i++) {
			expect(consumeRateLimit("u1", { perMinute: 3, perDay: 100, now }).ok).toBe(
				true,
			);
		}
		const blocked = consumeRateLimit("u1", { perMinute: 3, perDay: 100, now });
		expect(blocked).toEqual({ ok: false, scope: "minute", limit: 3 });
	});

	it("resets minute window after 60s", () => {
		const now = 1_700_000_000_000;
		for (let i = 0; i < 2; i++) {
			expect(consumeRateLimit("u1", { perMinute: 2, perDay: 100, now }).ok).toBe(
				true,
			);
		}
		expect(consumeRateLimit("u1", { perMinute: 2, perDay: 100, now }).ok).toBe(
			false,
		);
		const nextMinute = now + 60_000;
		expect(
			consumeRateLimit("u1", { perMinute: 2, perDay: 100, now: nextMinute }).ok,
		).toBe(true);
	});

	it("blocks when per-day limit is exceeded even if minute is free", () => {
		const dayStart = Math.floor(1_700_000_000_000 / 86_400_000) * 86_400_000;
		let now = dayStart;
		for (let i = 0; i < 5; i++) {
			expect(
				consumeRateLimit("u1", { perMinute: 100, perDay: 5, now }).ok,
			).toBe(true);
			now += 60_000; // new minute each time
		}
		const blocked = consumeRateLimit("u1", {
			perMinute: 100,
			perDay: 5,
			now,
		});
		expect(blocked).toEqual({ ok: false, scope: "day", limit: 5 });
	});

	it("resets day window on a new UTC day", () => {
		const dayStart = Math.floor(1_700_000_000_000 / 86_400_000) * 86_400_000;
		expect(
			consumeRateLimit("u1", { perMinute: 10, perDay: 1, now: dayStart }).ok,
		).toBe(true);
		expect(
			consumeRateLimit("u1", {
				perMinute: 10,
				perDay: 1,
				now: dayStart + 1_000,
			}).ok,
		).toBe(false);
		expect(
			consumeRateLimit("u1", {
				perMinute: 10,
				perDay: 1,
				now: dayStart + 86_400_000,
			}).ok,
		).toBe(true);
	});

	it("isolates counters by key (user)", () => {
		const now = 1_700_000_000_000;
		expect(consumeRateLimit("a", { perMinute: 1, perDay: 1, now }).ok).toBe(
			true,
		);
		expect(consumeRateLimit("a", { perMinute: 1, perDay: 1, now }).ok).toBe(
			false,
		);
		expect(consumeRateLimit("b", { perMinute: 1, perDay: 1, now }).ok).toBe(
			true,
		);
	});

	it("exports default AI parse caps", () => {
		expect(AI_PARSE_LIMIT_PER_MINUTE).toBe(10);
		expect(AI_PARSE_LIMIT_PER_DAY).toBe(100);
	});
});
