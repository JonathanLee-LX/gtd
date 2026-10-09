import { describe, expect, it } from "vitest";
import {
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS_PER_TASK,
	deriveUploadKind,
	isInlineImageMime,
	resolveAttachmentMime,
	sniffAttachmentMime,
	validateAttachmentFile,
} from "./limits";

describe("attachment limits", () => {
	it("is 10MB per file, images + PDF only", () => {
		expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
		expect(deriveUploadKind("image/png")).toBe("image");
		expect(deriveUploadKind("application/pdf")).toBe("file");
		expect(deriveUploadKind("image/svg+xml")).toBeNull();
		expect(deriveUploadKind("video/mp4")).toBeNull();
		expect(deriveUploadKind("application/zip")).toBeNull();
		expect(isInlineImageMime("image/svg+xml")).toBe(false);
	});

	it("falls back to extension when the browser gives no type", () => {
		expect(resolveAttachmentMime("photo.JPG", "")).toBe("image/jpeg");
		expect(resolveAttachmentMime("scan.pdf", "")).toBe("application/pdf");
		expect(resolveAttachmentMime("a.docx", "")).toBeNull();
		expect(resolveAttachmentMime("a.png", "image/jpg")).toBe("image/jpeg");
		expect(resolveAttachmentMime("a.pdf", "text/html")).toBeNull();
	});

	it("validates before upload with a clear message", () => {
		expect(validateAttachmentFile({ name: "a.png", size: 100, type: "image/png" })).toBeNull();
		const big = validateAttachmentFile({
			name: "big.pdf",
			size: MAX_ATTACHMENT_BYTES + 1,
			type: "application/pdf",
		});
		expect(big?.code).toBe("file_too_large");
		expect(big?.message).toContain("10MB");
		const wrong = validateAttachmentFile({ name: "a.zip", size: 10, type: "application/zip" });
		expect(wrong?.code).toBe("unsupported_type");
		expect(wrong?.message).toContain("PDF");
		expect(validateAttachmentFile({ name: "e.png", size: 0, type: "image/png" })?.code).toBe(
			"empty_file",
		);
		expect(
			validateAttachmentFile({ name: "a.png", size: 1, type: "image/png" }, MAX_ATTACHMENTS_PER_TASK)
				?.code,
		).toBe("task_attachment_limit");
	});

	it("sniffs real file type from magic bytes", () => {
		const enc = new TextEncoder();
		expect(sniffAttachmentMime(enc.encode("%PDF-1.7"))).toBe("application/pdf");
		expect(sniffAttachmentMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
		expect(sniffAttachmentMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
		expect(sniffAttachmentMime(enc.encode("GIF89a"))).toBe("image/gif");
		expect(sniffAttachmentMime(enc.encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
		expect(sniffAttachmentMime(enc.encode("\0\0\0\x18ftypheic"))).toBe("image/heic");
		expect(sniffAttachmentMime(enc.encode("<svg xmlns="))).toBeNull();
		expect(sniffAttachmentMime(enc.encode("<html>"))).toBeNull();
	});
});
