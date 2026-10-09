import { describe, expect, it } from "vitest";
import {
	TASK_DETAIL_ASIDE_MIN_WIDTH,
	TASK_DETAIL_ASIDE_QUERY,
	taskDetailLayoutForWidth,
} from "./task-detail-layout";

describe("taskDetailLayoutForWidth (#94)", () => {
	it("uses the Tailwind lg breakpoint so every width has exactly one detail presentation", () => {
		expect(TASK_DETAIL_ASIDE_MIN_WIDTH).toBe(1024);
		expect(TASK_DETAIL_ASIDE_QUERY).toBe("(min-width: 1024px)");
		for (const width of [320, 375, 767, 768, 800, 1000, 1023]) {
			expect(taskDetailLayoutForWidth(width)).toBe("mobile");
		}
		for (const width of [1024, 1280, 1920]) {
			expect(taskDetailLayoutForWidth(width)).toBe("aside");
		}
	});
});
