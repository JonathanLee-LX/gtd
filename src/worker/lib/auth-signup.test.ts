import { describe, expect, it } from "vitest";
import { isSignupEnabled } from "./auth";

describe("isSignupEnabled", () => {
	it("defaults to false when unset", () => {
		expect(isSignupEnabled({})).toBe(false);
		expect(isSignupEnabled({ ALLOW_SIGNUP: undefined })).toBe(false);
		expect(isSignupEnabled({ ALLOW_SIGNUP: "" })).toBe(false);
	});

	it("rejects non-explicit truthy values", () => {
		expect(isSignupEnabled({ ALLOW_SIGNUP: "yes" })).toBe(false);
		expect(isSignupEnabled({ ALLOW_SIGNUP: "on" })).toBe(false);
		expect(isSignupEnabled({ ALLOW_SIGNUP: "false" })).toBe(false);
		expect(isSignupEnabled({ ALLOW_SIGNUP: "0" })).toBe(false);
	});

	it("enables only for true or 1", () => {
		expect(isSignupEnabled({ ALLOW_SIGNUP: "true" })).toBe(true);
		expect(isSignupEnabled({ ALLOW_SIGNUP: "TRUE" })).toBe(true);
		expect(isSignupEnabled({ ALLOW_SIGNUP: "1" })).toBe(true);
		expect(isSignupEnabled({ ALLOW_SIGNUP: " true " })).toBe(true);
	});
});
