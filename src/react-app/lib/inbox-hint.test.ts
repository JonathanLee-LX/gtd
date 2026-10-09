// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { clearInboxHint, INBOX_HINT_KEY, readInboxHint, writeInboxHint } from "./inbox-hint";

beforeEach(() => localStorage.clear());

describe("inbox hint (#101)", () => {
	it("remembers the inbox project id for the next cold start", () => {
		expect(readInboxHint()).toBeNull();
		writeInboxHint("inbox-1");
		expect(readInboxHint()).toBe("inbox-1");
		expect(localStorage.getItem(INBOX_HINT_KEY)).toBe("inbox-1");
	});
	it("is cleared on the login page (account switch)", () => {
		writeInboxHint("inbox-1");
		clearInboxHint();
		expect(readInboxHint()).toBeNull();
	});
});
