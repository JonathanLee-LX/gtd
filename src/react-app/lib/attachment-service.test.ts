import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "../../shared/limits";
import { AttachmentValidationFailure, attachmentService } from "./attachment-service";

function fakeFile(name: string, size: number, type: string) {
	return { name, size, type } as File;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("attachmentService.upload", () => {
	it("blocks oversize / wrong type before any network call", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const putBytes = vi.fn();
		await expect(
			attachmentService.upload("t1", fakeFile("big.pdf", MAX_ATTACHMENT_BYTES + 1, "application/pdf"), {
				existingCount: 0,
				putBytes,
			}),
		).rejects.toBeInstanceOf(AttachmentValidationFailure);
		await expect(
			attachmentService.upload("t1", fakeFile("a.mp4", 10, "video/mp4"), { existingCount: 0, putBytes }),
		).rejects.toThrow(/类型不支持/);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(putBytes).not.toHaveBeenCalled();
	});

	it("request → put (with progress) → confirm", async () => {
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push(`${init.method ?? "GET"} ${url}`);
				if (url.endsWith("/uploads")) {
					expect(JSON.parse(String(init.body))).toEqual({ fileName: "a.png", size: 5, mime: "image/png" });
					return Response.json(
						{ uploadId: "u1", uploadUrl: "/api/attachments/uploads/u1/content", headers: { "Content-Type": "image/png" }, kind: "image", expiresAt: "x" },
						{ status: 201 },
					);
				}
				return Response.json({ attachment: { id: "a1", taskId: "t1" } });
			}),
		);
		const progress = vi.fn();
		const putBytes = vi.fn(async (_url: string, _file: Blob, _headers: Record<string, string>, onProgress?: (p: { loaded: number; total: number }) => void) => {
			onProgress?.({ loaded: 5, total: 5 });
		});
		const result = await attachmentService.upload("t1", fakeFile("a.png", 5, "image/png"), {
			existingCount: 0,
			putBytes,
			onProgress: progress,
		});
		expect(result.id).toBe("a1");
		expect(putBytes).toHaveBeenCalledWith("/api/attachments/uploads/u1/content", expect.anything(), { "Content-Type": "image/png" }, progress);
		expect(progress).toHaveBeenCalledWith({ loaded: 5, total: 5 });
		expect(calls).toEqual(["POST /api/tasks/t1/attachments/uploads", "POST /api/tasks/t1/attachments/uploads/u1/confirm"]);
	});
});
