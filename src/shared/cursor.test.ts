import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

describe("cursor", () => {
	it("round-trips unicode timestamps", () => {
		const cursor = { createdAt: "2026-09-10T08:00:00.000Z", id: "abc-123" };
		expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
	});

	it("returns null for garbage", () => {
		expect(decodeCursor("%%%")).toBeNull();
	});
});
