import { describe, expect, it } from "vitest";
import { classifyFocusTask, isFocusTask, ymdInZone } from "./today";

describe("ymdInZone", () => {
	it("formats Shanghai calendar date", () => {
		const date = new Date("2026-09-09T16:30:00.000Z");
		expect(ymdInZone(date, "Asia/Shanghai")).toBe("2026-09-10");
		expect(ymdInZone(date, "UTC")).toBe("2026-09-09");
	});
});

describe("classifyFocusTask", () => {
	it("marks overdue, today, next and p1 independently", () => {
		expect(
			classifyFocusTask(
				{ status: "inbox", priority: "none", dueAt: "2026-09-01" },
				"2026-09-10",
			),
		).toEqual(["overdue"]);
		expect(
			classifyFocusTask(
				{ status: "scheduled", priority: "none", dueAt: "2026-09-10" },
				"2026-09-10",
			),
		).toEqual(["today"]);
		expect(
			classifyFocusTask(
				{ status: "next", priority: "p1", dueAt: null },
				"2026-09-10",
			),
		).toEqual(["next", "p1"]);
	});

	it("ignores completed and cancelled", () => {
		expect(
			isFocusTask(
				{ status: "completed", priority: "p1", dueAt: "2026-01-01" },
				"2026-09-10",
			),
		).toBe(false);
	});
});
