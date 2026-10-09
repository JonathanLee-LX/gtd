import { describe, expect, it } from "vitest";
import { contentDisposition, parseByteRange, toAttachmentDto } from "./attachments";

describe("attachment routes helpers", () => {
	it("parses single byte ranges", () => {
		expect(parseByteRange("bytes=0-9", 100)).toEqual({ offset: 0, length: 10 });
		expect(parseByteRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
		expect(parseByteRange("bytes=-5", 100)).toEqual({ offset: 95, length: 5 });
		expect(parseByteRange("bytes=100-", 100)).toBeNull();
		expect(parseByteRange("bytes=0-1,5-6", 100)).toBeNull();
	});

	it("encodes non-ASCII file names", () => {
		expect(contentDisposition("合同.pdf", true)).toBe(
			"inline; filename=\"__.pdf\"; filename*=UTF-8''%E5%90%88%E5%90%8C.pdf",
		);
		expect(contentDisposition('a"b.png', false)).toMatch(/^attachment; filename="a_b.png"/);
	});

	it("never exposes r2Key / userId", () => {
		const dto = toAttachmentDto({
			id: "a1",
			userId: "u1",
			taskId: "t1",
			kind: "image",
			status: "ready",
			r2Key: "attachments/u1/t1/x",
			filename: "a.png",
			mime: "image/png",
			size: 1,
			url: null,
			createdAt: "x",
			updatedAt: "x",
			deletedAt: null,
		});
		expect(dto).not.toHaveProperty("r2Key");
		expect(dto).not.toHaveProperty("userId");
		expect(dto.contentUrl).toBe("/api/attachments/a1/content");
	});
});
