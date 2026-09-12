import { describe, expect, it } from "vitest";
import { CONTEXT_TAG_EXAMPLES, isContextTagName } from "./constants";

describe("context tag convention", () => {
	it("lists the three default contexts", () => {
		expect([...CONTEXT_TAG_EXAMPLES]).toEqual(["@电脑", "@出门", "@电话"]);
	});

	it("detects @-prefixed names", () => {
		expect(isContextTagName("@电脑")).toBe(true);
		expect(isContextTagName("工作")).toBe(false);
		expect(isContextTagName(" @出门")).toBe(true);
	});
});
