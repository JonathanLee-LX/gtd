import { describe, expect, it } from "vitest";
import {
	addDaysYmd,
	formatDueDigest,
	formatTomorrowDigest,
	nextQuarterFireUtc,
	quarterHourOptions,
	truncateDigestLine,
	zonedLocalToUtc,
} from "./digest";

describe("digest schedule", () => {
	it("keeps quarter-hour options on :00/:15/:30/:45", () => {
		const options = quarterHourOptions();
		expect(options).toHaveLength(96);
		expect(options).toContain("09:00");
		expect(options).toContain("21:45");
		expect(options).not.toContain("09:10");
	});

	it("maps Shanghai 09:00 to 01:00Z and skips a slot that has already started", () => {
		expect(zonedLocalToUtc("2026-10-16", "09:00", "Asia/Shanghai").toISOString()).toBe("2026-10-16T01:00:00.000Z");
		expect(nextQuarterFireUtc(new Date("2026-10-16T00:30:00.000Z"), "Asia/Shanghai", "09:00")).toBe(
			"2026-10-16T01:00:00.000Z",
		);
		expect(nextQuarterFireUtc(new Date("2026-10-16T01:00:00.000Z"), "Asia/Shanghai", "09:00")).toBe(
			"2026-10-17T01:00:00.000Z",
		);
	});

	it("uses the daylight-saving offset and skips a local time that does not exist", () => {
		expect(nextQuarterFireUtc(new Date("2026-07-01T12:00:00.000Z"), "America/New_York", "09:00")).toBe(
			"2026-07-01T13:00:00.000Z",
		);
		expect(nextQuarterFireUtc(new Date("2026-01-15T13:00:00.000Z"), "America/New_York", "09:00")).toBe(
			"2026-01-15T14:00:00.000Z",
		);
		// 2026-03-08 02:30 does not exist in New York (spring forward). Next real 02:30 is March 9.
		expect(nextQuarterFireUtc(new Date("2026-03-08T06:30:00.000Z"), "America/New_York", "02:30")).toBe(
			"2026-03-09T06:30:00.000Z",
		);
	});

	it("adds calendar days without drifting through a timezone", () => {
		expect(addDaysYmd("2026-01-31", 1)).toBe("2026-02-01");
		expect(addDaysYmd("2024-02-28", 1)).toBe("2024-02-29");
	});
});

describe("digest copy", () => {
	it("formats the today title and truncates after three lines", () => {
		expect(formatDueDigest({ dueCount: 0, overdueCount: 0, titles: [] })).toBeNull();
		const long = "写".repeat(40);
		const copy = formatDueDigest({
			dueCount: 2,
			overdueCount: 3,
			titles: ["逾期一", "逾期二", long, "今天一", "今天二"],
		});
		expect(copy?.title).toBe("今天 2 条到期 · 3 条逾期");
		expect(copy?.body.split("\n")).toEqual(["逾期一", "逾期二", `${"写".repeat(35)}…`, "还有 2 条"]);
		expect(truncateDigestLine("短标题")).toBe("短标题");
	});

	it("formats tomorrow without an overdue count", () => {
		expect(formatTomorrowDigest([])).toBeNull();
		expect(formatTomorrowDigest(["买牛奶"])).toEqual({ title: "明天 1 条到期", body: "买牛奶" });
	});
});
