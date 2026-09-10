import { describe, expect, it } from "vitest";
import { parseAiOutput } from "./schemas";

describe("parseAiOutput", () => {
	it("accepts a valid draft payload", () => {
		const parsed = parseAiOutput.parse({
			tasks: [
				{
					title: "交周报",
					notes: null,
					status: "next",
					priority: "p1",
					dueAt: "2026-09-12",
					waitingOn: null,
					tagNames: ["工作"],
				},
			],
		});
		expect(parsed.tasks[0]?.title).toBe("交周报");
	});

	it("rejects a missing title", () => {
		const result = parseAiOutput.safeParse({
			tasks: [
				{
					title: "",
					notes: null,
					status: "next",
					priority: "none",
					dueAt: null,
					waitingOn: null,
					tagNames: [],
				},
			],
		});
		expect(result.success).toBe(false);
	});
});
