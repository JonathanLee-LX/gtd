import { describe, expect, it } from "vitest";
import {
	D1_LIKE_PATTERN_MAX_BYTES,
	SEARCH_Q_MAX_BYTES,
	sanitizeSearchQuery,
	truncateUtf8Bytes,
} from "./search";

describe("search LIKE helpers", () => {
	it("keeps short ASCII and Chinese queries intact", () => {
		expect(sanitizeSearchQuery("week")).toBe("week");
		expect(sanitizeSearchQuery("周报")).toBe("周报");
	});

	it("strips LIKE wildcards and trims", () => {
		expect(sanitizeSearchQuery("  %foo_bar%  ")).toBe("foobar");
	});

	it("truncates to SEARCH_Q_MAX_BYTES without splitting UTF-8", () => {
		const longZh = "测".repeat(30); // 90 bytes
		const term = sanitizeSearchQuery(longZh);
		const termBytes = new TextEncoder().encode(term).length;
		expect(termBytes).toBeLessThanOrEqual(SEARCH_Q_MAX_BYTES);
		expect(termBytes % 3).toBe(0); // each 测 is 3 bytes
		expect(term).toBe("测".repeat(SEARCH_Q_MAX_BYTES / 3));

		const needle = `%${term}%`;
		expect(new TextEncoder().encode(needle).length).toBeLessThanOrEqual(
			D1_LIKE_PATTERN_MAX_BYTES,
		);
	});

	it("truncateUtf8Bytes never emits a broken trailing byte", () => {
		const mixed = "ab测cd"; // a b + 3-byte + c d
		expect(truncateUtf8Bytes(mixed, 3)).toBe("ab");
		expect(truncateUtf8Bytes(mixed, 5)).toBe("ab测");
		expect(truncateUtf8Bytes(mixed, 0)).toBe("");
	});
});
