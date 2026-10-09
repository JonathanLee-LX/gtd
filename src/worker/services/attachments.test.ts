import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_TASK } from "../../shared/limits";
import { createTestDb, seedUser } from "../test/db";
import { FakeR2, PDF_BYTES, PNG_BYTES, streamOf } from "../test/fake-r2";
import {
	buildR2Key,
	confirmUpload,
	deleteAttachment,
	getAttachment,
	listTaskAttachments,
	purgeAttachments,
	putUploadObject,
	requestUpload,
	sanitizeFilename,
	type AttachmentBucket,
} from "./attachments";
import { runDailyCleanup } from "./cleanup";
import { createProject, deleteProject } from "./projects";
import { createTask, deleteTask, listDeletedTasks, restoreTask } from "./tasks";
import { recordPendingDeletions } from "./attachments";

type TestDb = ReturnType<typeof createTestDb>["db"];
const DAY = 24 * 60 * 60 * 1000;

async function upload(
	db: TestDb,
	r2: FakeR2,
	userId: string,
	taskId: string,
	file: { name: string; bytes: Uint8Array; mime: string },
) {
	const req = await requestUpload(db as never, userId, taskId, {
		fileName: file.name,
		size: file.bytes.byteLength,
		mime: file.mime,
	});
	await putUploadObject(db as never, r2 as unknown as AttachmentBucket, userId, req.uploadId, streamOf(file.bytes));
	return confirmUpload(db as never, r2 as unknown as AttachmentBucket, userId, taskId, req.uploadId, "human");
}

async function setup() {
	const { db, sqlite } = createTestDb();
	const r2 = new FakeR2();
	const a = await seedUser(db, "a@example.com");
	const b = await seedUser(db, "b@example.com");
	const task = await createTask(db as never, a.id, { title: "报销" }, "human");
	return { db, sqlite, r2, a, b, task, bucket: r2 as unknown as AttachmentBucket };
}

describe("attachment service", () => {
	it("two-step upload: server key, real type from bytes, confirm idempotent", async () => {
		const { db, r2, a, task, bucket } = await setup();
		const req = await requestUpload(db as never, a.id, task.id, {
			fileName: "../../发票.png",
			size: PNG_BYTES.byteLength,
			mime: "image/png",
		});
		expect(req.uploadUrl).toBe(`/api/attachments/uploads/${req.uploadId}/content`);
		expect(req.kind).toBe("image");
		await putUploadObject(db as never, bucket, a.id, req.uploadId, streamOf(PNG_BYTES));
		const key = buildR2Key(a.id, task.id, req.uploadId);
		expect(r2.objects.get(key)?.contentType).toBe("image/png");

		const first = await confirmUpload(db as never, bucket, a.id, task.id, req.uploadId, "human");
		const again = await confirmUpload(db as never, bucket, a.id, task.id, req.uploadId, "human");
		expect(again.id).toBe(first.id);
		expect(first.filename).toBe("发票.png");
		expect(first.size).toBe(PNG_BYTES.byteLength);
		expect(first.r2Key).toBe(key);

		const pdf = await upload(db, r2, a.id, task.id, { name: "合同.pdf", bytes: PDF_BYTES, mime: "application/pdf" });
		expect(pdf.kind).toBe("file");
		expect(pdf.mime).toBe("application/pdf");
		const list = await listTaskAttachments(db as never, a.id, task.id);
		expect(list.map((row) => row.id)).toEqual([first.id, pdf.id]);
	});

	it("rejects oversize / wrong type at request time and fake content at PUT", async () => {
		const { db, a, task, bucket } = await setup();
		await expect(
			requestUpload(db as never, a.id, task.id, { fileName: "a.pdf", size: MAX_ATTACHMENT_BYTES + 1, mime: "application/pdf" }),
		).rejects.toMatchObject({ status: 413, code: "file_too_large" });
		await expect(
			requestUpload(db as never, a.id, task.id, { fileName: "a.zip", size: 10, mime: "application/zip" }),
		).rejects.toMatchObject({ status: 415, code: "unsupported_type" });
		await expect(
			requestUpload(db as never, a.id, task.id, { fileName: "x.svg", size: 10, mime: "image/svg+xml" }),
		).rejects.toMatchObject({ status: 415 });

		// 声明是 PDF，实际是 HTML：PUT 时按文件头拒绝，不落 R2。
		const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
		const req = await requestUpload(db as never, a.id, task.id, { fileName: "evil.pdf", size: html.byteLength, mime: "application/pdf" });
		await expect(
			putUploadObject(db as never, bucket, a.id, req.uploadId, streamOf(html)),
		).rejects.toMatchObject({ status: 415 });
		await expect(
			confirmUpload(db as never, bucket, a.id, task.id, req.uploadId, "human"),
		).rejects.toMatchObject({ status: 409 });

		// 声明大小与实际不一致。
		const req2 = await requestUpload(db as never, a.id, task.id, { fileName: "a.png", size: 999, mime: "image/png" });
		await expect(
			putUploadObject(db as never, bucket, a.id, req2.uploadId, streamOf(PNG_BYTES)),
		).rejects.toMatchObject({ code: "upload_mismatch" });
	});

	it("confirm re-validates the real R2 object (size / content-type)", async () => {
		const { db, r2, a, task, bucket } = await setup();
		const req = await requestUpload(db as never, a.id, task.id, { fileName: "a.png", size: PNG_BYTES.byteLength, mime: "image/png" });
		// 绕过 PUT 直接往 R2 塞一个类型不对的对象。
		r2.objects.set(buildR2Key(a.id, task.id, req.uploadId), { bytes: PNG_BYTES, contentType: "text/html" });
		await expect(
			confirmUpload(db as never, bucket, a.id, task.id, req.uploadId, "human"),
		).rejects.toMatchObject({ code: "upload_mismatch" });
		expect(r2.objects.size).toBe(0);
	});

	it("enforces the per-task quota", async () => {
		const { db, sqlite, a, task } = await setup();
		const now = new Date().toISOString();
		const insert = sqlite.prepare(
			"insert into attachments (id, user_id, task_id, kind, status, r2_key, filename, mime, size, created_at, updated_at) values (?, ?, ?, 'image', 'ready', ?, 'x.png', 'image/png', 10, ?, ?)",
		);
		for (let i = 0; i < MAX_ATTACHMENTS_PER_TASK; i += 1) {
			insert.run(`att-${i}`, a.id, task.id, `k-${i}`, now, now);
		}
		await expect(
			requestUpload(db as never, a.id, task.id, { fileName: "a.png", size: 10, mime: "image/png" }),
		).rejects.toMatchObject({ status: 409, code: "task_attachment_limit" });
	});

	it("isolates users: another user gets 404 on every path", async () => {
		const { db, r2, a, b, task, bucket } = await setup();
		const att = await upload(db, r2, a.id, task.id, { name: "a.png", bytes: PNG_BYTES, mime: "image/png" });
		const pending = await requestUpload(db as never, a.id, task.id, { fileName: "b.png", size: PNG_BYTES.byteLength, mime: "image/png" });

		await expect(listTaskAttachments(db as never, b.id, task.id)).rejects.toMatchObject({ status: 404 });
		await expect(getAttachment(db as never, b.id, att.id)).rejects.toMatchObject({ status: 404 });
		await expect(
			deleteAttachment(db as never, bucket, b.id, task.id, att.id, "human"),
		).rejects.toMatchObject({ status: 404 });
		await expect(
			requestUpload(db as never, b.id, task.id, { fileName: "x.png", size: 10, mime: "image/png" }),
		).rejects.toMatchObject({ status: 404 });
		await expect(
			putUploadObject(db as never, bucket, b.id, pending.uploadId, streamOf(PNG_BYTES)),
		).rejects.toMatchObject({ status: 404 });
		await expect(
			confirmUpload(db as never, bucket, b.id, task.id, pending.uploadId, "human"),
		).rejects.toMatchObject({ status: 404 });

		// 跨任务：用 A 的另一个任务 URL 删这个附件 → 404，且附件仍在。
		const other = await createTask(db as never, a.id, { title: "别的" }, "human");
		await expect(
			deleteAttachment(db as never, bucket, a.id, other.id, att.id, "human"),
		).rejects.toMatchObject({ status: 404 });
		expect((await getAttachment(db as never, a.id, att.id)).id).toBe(att.id);
	});

	it("delete removes the row and the R2 object; R2 failure is retried by cron", async () => {
		const { db, sqlite, r2, a, task, bucket } = await setup();
		const one = await upload(db, r2, a.id, task.id, { name: "a.png", bytes: PNG_BYTES, mime: "image/png" });
		const two = await upload(db, r2, a.id, task.id, { name: "b.pdf", bytes: PDF_BYTES, mime: "application/pdf" });

		const res = await deleteAttachment(db as never, bucket, a.id, task.id, one.id, "human");
		expect(res.r2Deleted).toBe(true);
		expect(r2.objects.has(one.r2Key!)).toBe(false);
		expect(sqlite.prepare("select count(*) as n from attachments where id = ?").get(one.id)).toEqual({ n: 0 });

		r2.failDelete = true;
		const res2 = await deleteAttachment(db as never, bucket, a.id, task.id, two.id, "human");
		expect(res2.r2Deleted).toBe(false);
		expect((await listTaskAttachments(db as never, a.id, task.id)).length).toBe(0);
		expect(r2.objects.has(two.r2Key!)).toBe(true);

		r2.failDelete = false;
		const later = new Date(Date.now() + 5 * 60 * 1000);
		const result = await purgeAttachments(db as never, bucket, { now: later });
		expect(result.deletedAttachments).toBe(1);
		expect(r2.objects.has(two.r2Key!)).toBe(false);
		expect(sqlite.prepare("select count(*) as n from attachments").get()).toEqual({ n: 0 });
	});

	it("recycle bin hides attachments, restore brings them back", async () => {
		const { db, r2, a, task } = await setup();
		const att = await upload(db, r2, a.id, task.id, { name: "a.png", bytes: PNG_BYTES, mime: "image/png" });

		await deleteTask(db as never, a.id, task.id, "human");
		await expect(listTaskAttachments(db as never, a.id, task.id)).rejects.toMatchObject({ status: 404 });
		await expect(getAttachment(db as never, a.id, att.id)).rejects.toMatchObject({ status: 404 });
		await expect(
			requestUpload(db as never, a.id, task.id, { fileName: "x.png", size: 10, mime: "image/png" }),
		).rejects.toMatchObject({ status: 404 });
		expect(r2.objects.has(att.r2Key!)).toBe(true);

		await restoreTask(db as never, a.id, task.id, "human");
		const list = await listTaskAttachments(db as never, a.id, task.id);
		expect(list.map((row) => row.id)).toEqual([att.id]);
		expect((await getAttachment(db as never, a.id, att.id)).id).toBe(att.id);
	});

	it("daily cron purges R2 objects of expired recycle-bin tasks before hard-deleting them", async () => {
		const { db, sqlite, r2, a, b, task, bucket } = await setup();
		const expiredAtt = await upload(db, r2, a.id, task.id, { name: "a.png", bytes: PNG_BYTES, mime: "image/png" });
		const expiredPending = await requestUpload(db as never, a.id, task.id, { fileName: "p.pdf", size: PDF_BYTES.byteLength, mime: "application/pdf" });
		await putUploadObject(db as never, bucket, a.id, expiredPending.uploadId, streamOf(PDF_BYTES));

		const fresh = await createTask(db as never, a.id, { title: "刚删" }, "human");
		const freshAtt = await upload(db, r2, a.id, fresh.id, { name: "f.png", bytes: PNG_BYTES, mime: "image/png" });
		const live = await createTask(db as never, b.id, { title: "别人在用" }, "human");
		const liveAtt = await upload(db, r2, b.id, live.id, { name: "l.pdf", bytes: PDF_BYTES, mime: "application/pdf" });

		await deleteTask(db as never, a.id, task.id, "human");
		await deleteTask(db as never, a.id, fresh.id, "human");
		const now = new Date(Date.now() + 1000);
		sqlite.prepare("update tasks set deleted_at = ? where id = ?").run(new Date(now.getTime() - 31 * DAY).toISOString(), task.id);
		sqlite.prepare("update tasks set deleted_at = ? where id = ?").run(new Date(now.getTime() - 2 * DAY).toISOString(), fresh.id);

		const result = await runDailyCleanup(db as never, bucket, now);
		expect(result.recycleBin).toMatchObject({ tasks: 1 });
		expect(result.attachments).toMatchObject({ expiredTaskAttachments: 1, blockTaskPurge: false });

		expect(r2.objects.has(expiredAtt.r2Key!)).toBe(false);
		expect(r2.objects.has(buildR2Key(a.id, task.id, expiredPending.uploadId))).toBe(false);
		expect(sqlite.prepare("select count(*) as n from attachments where task_id = ?").get(task.id)).toEqual({ n: 0 });
		expect(sqlite.prepare("select count(*) as n from attachment_uploads where task_id = ?").get(task.id)).toEqual({ n: 0 });
		expect(sqlite.prepare("select count(*) as n from tasks where id = ?").get(task.id)).toEqual({ n: 0 });

		// 回收站里未到期的任务、其他用户的附件都不动。
		expect(r2.objects.has(freshAtt.r2Key!)).toBe(true);
		expect(r2.objects.has(liveAtt.r2Key!)).toBe(true);
		expect((await listDeletedTasks(db as never, a.id)).items.map((t) => t.id)).toEqual([fresh.id]);
		await restoreTask(db as never, a.id, fresh.id, "human");
		expect((await listTaskAttachments(db as never, a.id, fresh.id)).map((r) => r.id)).toEqual([freshAtt.id]);
	});

	it("cron skips task hard-delete when R2 cleanup fails (no orphaned objects)", async () => {
		const { db, sqlite, r2, a, task, bucket } = await setup();
		const att = await upload(db, r2, a.id, task.id, { name: "a.png", bytes: PNG_BYTES, mime: "image/png" });
		await deleteTask(db as never, a.id, task.id, "human");
		const now = new Date(Date.now() + 1000);
		sqlite.prepare("update tasks set deleted_at = ? where id = ?").run(new Date(now.getTime() - 31 * DAY).toISOString(), task.id);

		r2.failDelete = true;
		const blocked = await runDailyCleanup(db as never, bucket, now);
		expect(blocked.recycleBin).toMatchObject({ skipped: expect.any(String) });
		expect(sqlite.prepare("select count(*) as n from tasks where id = ?").get(task.id)).toEqual({ n: 1 });
		expect(r2.objects.has(att.r2Key!)).toBe(true);

		r2.failDelete = false;
		const ok = await runDailyCleanup(db as never, bucket, now);
		expect(ok.recycleBin).toMatchObject({ tasks: 1 });
		expect(r2.objects.size).toBe(0);

		// 绑定缺失：附件清理报错，任务硬删同样跳过。
		const missing = await runDailyCleanup(db as never, undefined, now);
		expect(missing.attachments).toMatchObject({ error: expect.any(String) });
		expect(missing.recycleBin).toMatchObject({ skipped: expect.any(String) });
	});

	it("cron expires stale unconfirmed uploads and later drops old upload records", async () => {
		const { db, sqlite, r2, a, task, bucket } = await setup();
		const req = await requestUpload(db as never, a.id, task.id, { fileName: "a.png", size: PNG_BYTES.byteLength, mime: "image/png" });
		await putUploadObject(db as never, bucket, a.id, req.uploadId, streamOf(PNG_BYTES));
		const key = buildR2Key(a.id, task.id, req.uploadId);
		expect(r2.objects.has(key)).toBe(true);

		const first = await purgeAttachments(db as never, bucket, { now: new Date(Date.now() + 16 * 60 * 1000) });
		expect(first.staleUploads).toBe(1);
		expect(r2.objects.has(key)).toBe(false);
		expect(sqlite.prepare("select status from attachment_uploads where id = ?").get(req.uploadId)).toEqual({ status: "expired" });
		await expect(
			confirmUpload(db as never, bucket, a.id, task.id, req.uploadId, "human"),
		).rejects.toMatchObject({ code: "upload_expired" });

		const second = await purgeAttachments(db as never, bucket, { now: new Date(Date.now() + 8 * DAY) });
		expect(second.uploadRecords).toBe(1);
		expect(sqlite.prepare("select count(*) as n from attachment_uploads").get()).toEqual({ n: 0 });
	});

	it("sanitizes file names", () => {
		expect(sanitizeFilename("C:\\Users\\me\\a.pdf")).toBe("a.pdf");
		expect(sanitizeFilename("\u0000\u0001")).toBe("未命名文件");
		expect(sanitizeFilename("x".repeat(400)).length).toBe(255);
	});

	it("deleteProject removes R2 objects of all its tasks (incl. recycle bin + unconfirmed uploads)", async () => {
		const { db, sqlite, r2, a, b, bucket } = await setup();
		const project = await createProject(db as never, a.id, { name: "装修" }, "human");
		const t1 = await createTask(db as never, a.id, { title: "报价", projectId: project.id }, "human");
		const t2 = await createTask(db as never, a.id, { title: "已删", projectId: project.id }, "human");
		const keep = await createTask(db as never, a.id, { title: "别的项目" }, "human");
		const other = await createTask(db as never, b.id, { title: "别人" }, "human");
		const att1 = await upload(db, r2, a.id, t1.id, { name: "a.png", bytes: PNG_BYTES, mime: "image/png" });
		const att2 = await upload(db, r2, a.id, t2.id, { name: "b.pdf", bytes: PDF_BYTES, mime: "application/pdf" });
		const pending = await requestUpload(db as never, a.id, t1.id, { fileName: "c.png", size: PNG_BYTES.byteLength, mime: "image/png" });
		await putUploadObject(db as never, bucket, a.id, pending.uploadId, streamOf(PNG_BYTES));
		const keepAtt = await upload(db, r2, a.id, keep.id, { name: "k.png", bytes: PNG_BYTES, mime: "image/png" });
		const otherAtt = await upload(db, r2, b.id, other.id, { name: "o.png", bytes: PNG_BYTES, mime: "image/png" });
		await deleteTask(db as never, a.id, t2.id, "human");

		// 别人不能删我的项目，也不会动到 R2。
		await expect(deleteProject(db as never, b.id, project.id, "human", bucket)).rejects.toMatchObject({ status: 404 });
		expect(r2.objects.size).toBe(5);

		await deleteProject(db as never, a.id, project.id, "human", bucket);
		expect(r2.objects.has(att1.r2Key!)).toBe(false);
		expect(r2.objects.has(att2.r2Key!)).toBe(false);
		expect(r2.objects.has(buildR2Key(a.id, t1.id, pending.uploadId))).toBe(false);
		expect(r2.objects.has(keepAtt.r2Key!)).toBe(true);
		expect(r2.objects.has(otherAtt.r2Key!)).toBe(true);
		expect(sqlite.prepare("select count(*) as n from attachments where task_id in (?, ?)").get(t1.id, t2.id)).toEqual({ n: 0 });
		expect(sqlite.prepare("select count(*) as n from attachment_uploads where task_id = ?").get(t1.id)).toEqual({ n: 0 });
		expect(sqlite.prepare("select count(*) as n from r2_pending_deletions").get()).toEqual({ n: 0 });
	});

	it("deleteProject: R2 failure is recorded durably and retried by the daily cron", async () => {
		const { db, sqlite, r2, a, bucket } = await setup();
		const project = await createProject(db as never, a.id, { name: "旅行" }, "human");
		const t1 = await createTask(db as never, a.id, { title: "机票", projectId: project.id }, "human");
		const att = await upload(db, r2, a.id, t1.id, { name: "a.pdf", bytes: PDF_BYTES, mime: "application/pdf" });

		r2.failDelete = true;
		await deleteProject(db as never, a.id, project.id, "human", bucket);
		// 项目、任务、附件行都没了，但 key 留在待删清单里，R2 对象还在。
		expect(sqlite.prepare("select count(*) as n from tasks where id = ?").get(t1.id)).toEqual({ n: 0 });
		expect(sqlite.prepare("select count(*) as n from attachments").get()).toEqual({ n: 0 });
		const row = sqlite.prepare("select r2_key, user_id, reason, attempts, last_error from r2_pending_deletions").get() as Record<string, unknown>;
		expect(row).toMatchObject({ r2_key: att.r2Key, user_id: a.id, reason: "project_delete", attempts: 1, last_error: "r2 down" });
		expect(r2.objects.has(att.r2Key!)).toBe(true);

		// 宽限期内 cron 不碰；R2 恢复后，过了宽限期的下一轮 cron 删掉对象并清掉清单。
		r2.failDelete = false;
		const early = await runDailyCleanup(db as never, bucket, new Date(Date.now() + 60 * 1000));
		expect(early.attachments).toMatchObject({ pendingDeleted: 0 });
		expect(r2.objects.has(att.r2Key!)).toBe(true);
		const later = await runDailyCleanup(db as never, bucket, new Date(Date.now() + 10 * 60 * 1000));
		expect(later.attachments).toMatchObject({ pendingDeleted: 1, pendingFailed: 0 });
		expect(r2.objects.has(att.r2Key!)).toBe(false);
		expect(sqlite.prepare("select count(*) as n from r2_pending_deletions").get()).toEqual({ n: 0 });
	});

	it("cron never deletes a pending key that a live attachment still references", async () => {
		const { db, sqlite, r2, a, task, bucket } = await setup();
		const att = await upload(db, r2, a.id, task.id, { name: "a.png", bytes: PNG_BYTES, mime: "image/png" });
		// 模拟「记了清单但删库失败」：清单里有 key，附件行还活着。
		await recordPendingDeletions(db as never, a.id, [att.r2Key!], "project_delete");
		const result = await runDailyCleanup(db as never, bucket, new Date(Date.now() + 10 * 60 * 1000));
		expect(result.attachments).toMatchObject({ pendingDeleted: 0 });
		expect(r2.objects.has(att.r2Key!)).toBe(true);
		expect(sqlite.prepare("select count(*) as n from r2_pending_deletions").get()).toEqual({ n: 0 });
		expect((await getAttachment(db as never, a.id, att.id)).id).toBe(att.id);
	});

	it("confirm rejects an expired upload and drops its object", async () => {
		const { db, sqlite, r2, a, task, bucket } = await setup();
		const req = await requestUpload(db as never, a.id, task.id, { fileName: "a.png", size: PNG_BYTES.byteLength, mime: "image/png" });
		await putUploadObject(db as never, bucket, a.id, req.uploadId, streamOf(PNG_BYTES));
		await expect(
			confirmUpload(db as never, bucket, a.id, task.id, req.uploadId, "human", { now: new Date(Date.now() + 16 * 60 * 1000) }),
		).rejects.toMatchObject({ status: 409, code: "upload_expired" });
		expect(r2.objects.size).toBe(0);
		expect(sqlite.prepare("select status from attachment_uploads where id = ?").get(req.uploadId)).toEqual({ status: "expired" });
		expect(sqlite.prepare("select count(*) as n from attachments").get()).toEqual({ n: 0 });
	});

	it("concurrent upload requests cannot exceed the per-task quota", async () => {
		const { db, sqlite, a, task } = await setup();
		const now = new Date().toISOString();
		const insert = sqlite.prepare(
			"insert into attachments (id, user_id, task_id, kind, status, r2_key, filename, mime, size, created_at, updated_at) values (?, ?, ?, 'image', 'ready', ?, 'x.png', 'image/png', 10, ?, ?)",
		);
		for (let i = 0; i < MAX_ATTACHMENTS_PER_TASK - 1; i += 1) insert.run(`att-${i}`, a.id, task.id, `k-${i}`, now, now);
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, (_, i) =>
				requestUpload(db as never, a.id, task.id, { fileName: `r${i}.png`, size: 10, mime: "image/png" }),
			),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		for (const r of results.filter((r) => r.status === "rejected")) {
			expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
		}
		expect(sqlite.prepare("select count(*) as n from attachment_uploads where task_id = ?").get(task.id)).toEqual({ n: 1 });
	});

	it("confirm re-checks the quota atomically and discards the object when over", async () => {
		const { db, sqlite, r2, a, task, bucket } = await setup();
		const now = new Date().toISOString();
		const insert = sqlite.prepare(
			"insert into attachments (id, user_id, task_id, kind, status, r2_key, filename, mime, size, created_at, updated_at) values (?, ?, ?, 'image', 'ready', ?, 'x.png', 'image/png', 10, ?, ?)",
		);
		for (let i = 0; i < MAX_ATTACHMENTS_PER_TASK - 1; i += 1) insert.run(`att-${i}`, a.id, task.id, `k-${i}`, now, now);
		const req = await requestUpload(db as never, a.id, task.id, { fileName: "a.png", size: PNG_BYTES.byteLength, mime: "image/png" });
		await putUploadObject(db as never, bucket, a.id, req.uploadId, streamOf(PNG_BYTES));
		// 另一路（例如 MCP 并发）抢先落了第 20 个。
		insert.run("att-racer", a.id, task.id, "k-racer", now, now);
		await expect(
			confirmUpload(db as never, bucket, a.id, task.id, req.uploadId, "human"),
		).rejects.toMatchObject({ status: 409, code: "task_attachment_limit" });
		expect(r2.objects.has(buildR2Key(a.id, task.id, req.uploadId))).toBe(false);
		expect(sqlite.prepare("select count(*) as n from attachments where task_id = ?").get(task.id)).toEqual({ n: MAX_ATTACHMENTS_PER_TASK });
	});
});
