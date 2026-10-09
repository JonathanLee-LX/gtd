/**
 * #68 任务附件服务（迁移自 gtd-attach-exp 的 services/attachments.ts，v1 收窄为图片 + PDF）。
 *
 * D1 只存元数据，二进制一律在 R2（绑定 `UPLOADS`，生产桶 `gtd-uploads`）。
 * 两段式上传（request → PUT 字节 → confirm），服务端是唯一权威：
 *  - r2_key 由服务端生成（attachments/<userId>/<taskId>/<uploadId>），客户端给什么都不参与拼 key；
 *  - 上传 / 下载都经 Worker 代理，不下发任何 R2 访问凭据或预签名 URL；
 *  - PUT 时按文件头识别真实类型，按真实字节数校验大小；confirm 再用 R2 HEAD 回验 size / content-type；
 *  - 所有查询都带 user_id；任务在回收站时附件一律视为不存在（404），恢复任务后自然回来；
 *  - 任务被 cron 彻底清理前，先由本服务删 R2 对象 + 附件行（见 purgeAttachments）。
 *
 * 与实验版的差异：去掉「链接 / 视频」附件、去掉单个附件的 30 天软删恢复（删除即删 R2，
 * 失败才留 deleted_at 给 cron 兜底）、去掉 gc_runs 记账表（结果写日志）。
 */

import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { attachments, attachmentUploads, r2PendingDeletions, tasks } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import {
	ATTACHMENT_PURGE_GRACE_MS,
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENT_FILENAME_LENGTH,
	MAX_ATTACHMENTS_PER_TASK,
	MAX_USER_ATTACHMENT_BYTES,
	MAX_USER_ATTACHMENT_COUNT,
	UPLOAD_URL_TTL_SECONDS,
	ALLOWED_ATTACHMENT_MIMES,
	deriveUploadKind,
	formatLimitBytes,
	normalizeMime,
	resolveAttachmentMime,
	sniffAttachmentMime,
	type AttachmentKind,
} from "../../shared/limits";
import type { RequestAttachmentUploadInput, TaskSource } from "../../shared/schemas";
import { AppError } from "../lib/errors";
import { newId, nowIso } from "../lib/ids";
import { logActivity } from "./activity";
import { softDeleteCutoffIso } from "./tasks";

export type AttachmentRow = typeof attachments.$inferSelect;
export type AttachmentUploadRow = typeof attachmentUploads.$inferSelect;

/** 只用到 R2 的这几个方法；测试里用内存实现替身。 */
export type AttachmentBucket = Pick<R2Bucket, "put" | "get" | "head" | "delete">;

const R2_KEY_PREFIX = "attachments";

/** 终态 upload 行（expired/failed/confirmed）的保留期：7 天，之后 cron 删行。 */
export const UPLOAD_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL_UPLOAD_STATUSES = ["expired", "failed", "confirmed"] as const;

/** D1 单条语句最多 100 个绑定参数；R2 delete 一次最多 1000 个 key。 */
const ID_BATCH = 50;

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

function badRequest(message: string, code = "bad_request"): AppError {
	return new AppError(400, code, message);
}

function conflict(message: string, code: string): AppError {
	return new AppError(409, code, message);
}

function unsupportedType(message = "只能上传图片（JPG/PNG/GIF/WebP/HEIC）或 PDF"): AppError {
	return new AppError(415, "unsupported_type", message);
}

function tooLarge(): AppError {
	return new AppError(
		413,
		"file_too_large",
		`单个文件不能超过 ${formatLimitBytes(MAX_ATTACHMENT_BYTES)}`,
	);
}

function attachmentNotFound(): AppError {
	return new AppError(404, "not_found", "附件不存在");
}

function uploadNotFound(): AppError {
	return new AppError(404, "not_found", "上传记录不存在");
}

/** 上传地址：同源，经 Worker 落 R2；需要登录态 + 服务端签发的 uploadId。 */
export function uploadContentPath(uploadId: string): string {
	return `/api/attachments/uploads/${uploadId}/content`;
}

export function attachmentContentPath(attachmentId: string): string {
	return `/api/attachments/${attachmentId}/content`;
}

/** 去掉路径/控制字符，防止 `../../` 之类的文件名污染任何拼串。 */
export function sanitizeFilename(raw: string): string {
	const base = raw.split(/[\\/]/).pop() ?? raw;
	// eslint-disable-next-line no-control-regex
	const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	const name = cleaned.length > 0 ? cleaned : "未命名文件";
	return name.length > MAX_ATTACHMENT_FILENAME_LENGTH
		? name.slice(0, MAX_ATTACHMENT_FILENAME_LENGTH)
		: name;
}

/** r2_key 只由服务端拼：attachments/<userId>/<taskId>/<uploadId>。 */
export function buildR2Key(userId: string, taskId: string, uploadId: string): string {
	return `${R2_KEY_PREFIX}/${userId}/${taskId}/${uploadId}`;
}

/** 任务必须属于当前用户且不在回收站，否则附件相关操作一律 404。 */
async function assertTaskOwned(db: AppDatabase, userId: string, taskId: string) {
	const rows = await db
		.select({ id: tasks.id })
		.from(tasks)
		.where(and(eq(tasks.id, taskId), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
		.limit(1);
	if (!rows[0]) throw new AppError(404, "not_found", "任务不存在");
	return rows[0];
}

/**
 * 已用额度：未删除的附件（含回收站里任务的附件——它们还占着 R2）+ 未过期的 pending 上传。
 * 过期占位不占额度：选了文件又取消留下的废弃占位不该把任务锁死到下次 cron。
 */
export async function attachmentUsage(
	db: AppDatabase,
	userId: string,
	options: { now?: Date } = {},
) {
	const nowIsoStr = (options.now ?? new Date()).toISOString();
	const ready = await db
		.select({
			count: sql<number>`count(*)`,
			bytes: sql<number>`coalesce(sum(${attachments.size}), 0)`,
		})
		.from(attachments)
		.where(and(eq(attachments.userId, userId), isNull(attachments.deletedAt)));
	const pending = await db
		.select({
			count: sql<number>`count(*)`,
			bytes: sql<number>`coalesce(sum(${attachmentUploads.size}), 0)`,
		})
		.from(attachmentUploads)
		.where(
			and(
				eq(attachmentUploads.userId, userId),
				eq(attachmentUploads.status, "pending"),
				gt(attachmentUploads.expiresAt, nowIsoStr),
			),
		);
	return {
		count: Number(ready[0]?.count ?? 0) + Number(pending[0]?.count ?? 0),
		bytes: Number(ready[0]?.bytes ?? 0) + Number(pending[0]?.bytes ?? 0),
	};
}

export async function countTaskAttachments(
	db: AppDatabase,
	userId: string,
	taskId: string,
	options: { now?: Date } = {},
): Promise<number> {
	const nowIsoStr = (options.now ?? new Date()).toISOString();
	const rows = await db
		.select({ count: sql<number>`count(*)` })
		.from(attachments)
		.where(
			and(
				eq(attachments.userId, userId),
				eq(attachments.taskId, taskId),
				isNull(attachments.deletedAt),
			),
		);
	const pending = await db
		.select({ count: sql<number>`count(*)` })
		.from(attachmentUploads)
		.where(
			and(
				eq(attachmentUploads.userId, userId),
				eq(attachmentUploads.taskId, taskId),
				eq(attachmentUploads.status, "pending"),
				gt(attachmentUploads.expiresAt, nowIsoStr),
			),
		);
	return Number(rows[0]?.count ?? 0) + Number(pending[0]?.count ?? 0);
}

async function assertQuota(
	db: AppDatabase,
	userId: string,
	taskId: string,
	incomingBytes: number,
	now: Date,
) {
	const perTask = await countTaskAttachments(db, userId, taskId, { now });
	if (perTask >= MAX_ATTACHMENTS_PER_TASK) {
		throw conflict(`单个任务最多 ${MAX_ATTACHMENTS_PER_TASK} 个附件`, "task_attachment_limit");
	}
	const usage = await attachmentUsage(db, userId, { now });
	if (usage.count >= MAX_USER_ATTACHMENT_COUNT) {
		throw conflict(
			`附件数量已达上限（${usage.count}/${MAX_USER_ATTACHMENT_COUNT} 个）`,
			"user_quota_exceeded",
		);
	}
	if (usage.bytes + incomingBytes > MAX_USER_ATTACHMENT_BYTES) {
		throw conflict("附件存储空间不足（上限 1GB）", "user_quota_exceeded");
	}
}

export type RequestUploadResult = {
	uploadId: string;
	/** 浏览器 PUT 字节的地址（同源，Worker 代理落 R2）。 */
	uploadUrl: string;
	/** PUT 时要带的头，由服务端下发。 */
	headers: Record<string, string>;
	kind: AttachmentKind;
	expiresAt: string;
};

/**
 * 第一步：校验大小 / 类型 / 额度，建 pending 占位，下发上传地址。
 * 在这里拦掉，避免用户白传 10MB 才被拒。
 */
export async function requestUpload(
	db: AppDatabase,
	userId: string,
	taskId: string,
	input: RequestAttachmentUploadInput,
	options: { now?: Date } = {},
): Promise<RequestUploadResult> {
	await assertTaskOwned(db, userId, taskId);

	if (!Number.isInteger(input.size) || input.size <= 0) {
		throw badRequest("文件大小不合法", "invalid_size");
	}
	if (input.size > MAX_ATTACHMENT_BYTES) throw tooLarge();
	const mime = resolveAttachmentMime(input.fileName, input.mime);
	const kind = mime ? deriveUploadKind(mime) : null;
	if (!mime || !kind) throw unsupportedType();

	const now = options.now ?? new Date();
	await assertQuota(db, userId, taskId, input.size, now);

	const uploadId = newId();
	const row = {
		id: uploadId,
		userId,
		taskId,
		r2Key: buildR2Key(userId, taskId, uploadId),
		kind,
		filename: sanitizeFilename(input.fileName),
		mime,
		size: input.size,
		status: "pending",
		attachmentId: null,
		expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
		confirmedAt: null,
		createdAt: now.toISOString(),
	};
	// 预检之后再用「带条件的单条 INSERT」占位：SQLite 单语句是原子的，
	// 并发请求同时通过预检时，只有额度内的那几条能真正插进去。
	await db.run(sql`
		insert into attachment_uploads
			(id, user_id, task_id, r2_key, kind, filename, mime, size, status, attachment_id, expires_at, confirmed_at, created_at)
		select ${row.id}, ${userId}, ${taskId}, ${row.r2Key}, ${kind}, ${row.filename}, ${mime}, ${row.size},
			'pending', null, ${row.expiresAt}, null, ${row.createdAt}
		where
			(select count(*) from attachments where user_id = ${userId} and task_id = ${taskId} and deleted_at is null)
			+ (select count(*) from attachment_uploads where user_id = ${userId} and task_id = ${taskId} and status = 'pending' and expires_at > ${row.createdAt})
				< ${MAX_ATTACHMENTS_PER_TASK}
			and (select count(*) from attachments where user_id = ${userId} and deleted_at is null)
			+ (select count(*) from attachment_uploads where user_id = ${userId} and status = 'pending' and expires_at > ${row.createdAt})
				< ${MAX_USER_ATTACHMENT_COUNT}
			and (select coalesce(sum(size), 0) from attachments where user_id = ${userId} and deleted_at is null)
			+ (select coalesce(sum(size), 0) from attachment_uploads where user_id = ${userId} and status = 'pending' and expires_at > ${row.createdAt})
			+ ${row.size} <= ${MAX_USER_ATTACHMENT_BYTES}
	`);
	const inserted = await db
		.select({ id: attachmentUploads.id })
		.from(attachmentUploads)
		.where(eq(attachmentUploads.id, uploadId))
		.limit(1);
	if (!inserted[0]) {
		// 输掉了并发：重跑一次预检拿到准确文案，兜底给通用提示。
		await assertQuota(db, userId, taskId, input.size, now);
		throw conflict("附件额度已满，请稍后再试", "user_quota_exceeded");
	}

	return {
		uploadId,
		uploadUrl: uploadContentPath(uploadId),
		headers: { "Content-Type": mime },
		kind,
		expiresAt: row.expiresAt,
	};
}

async function loadUpload(db: AppDatabase, userId: string, uploadId: string) {
	const rows = await db
		.select()
		.from(attachmentUploads)
		.where(and(eq(attachmentUploads.id, uploadId), eq(attachmentUploads.userId, userId)))
		.limit(1);
	if (!rows[0]) throw uploadNotFound();
	return rows[0];
}

/**
 * 把请求体读成定长字节：边读边计数，超限立刻 cancel，不先把大文件整个读进内存。
 * （workerd 的 R2 put 也不接受长度未知的流。）
 */
export async function readBoundedBody(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw tooLarge();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of chunks) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

async function markUpload(db: AppDatabase, uploadId: string, status: "expired" | "failed") {
	await db.update(attachmentUploads).set({ status }).where(eq(attachmentUploads.id, uploadId));
}

/**
 * 第二步：Worker 收下浏览器 PUT 的字节，按文件头确认真实类型后写 R2。
 * 写入的 content-type 用识别出的真实类型，不用客户端声明。
 */
export async function putUploadObject(
	db: AppDatabase,
	bucket: AttachmentBucket,
	userId: string,
	uploadId: string,
	body: ReadableStream<Uint8Array>,
	options: { now?: Date } = {},
): Promise<{ size: number; mime: string }> {
	const upload = await loadUpload(db, userId, uploadId);
	const now = options.now ?? new Date();
	if (upload.status !== "pending") {
		throw conflict("该上传已完成或已作废，请重新上传", "upload_conflict");
	}
	if (upload.expiresAt <= now.toISOString()) {
		await markUpload(db, upload.id, "expired");
		throw conflict("上传已过期（超过 15 分钟），请重新上传", "upload_expired");
	}
	await assertTaskOwned(db, userId, upload.taskId);

	const bytes = await readBoundedBody(body, MAX_ATTACHMENT_BYTES);
	if (bytes.byteLength !== upload.size) {
		await markUpload(db, upload.id, "failed");
		throw conflict(
			`实际大小 ${bytes.byteLength} 与声明的 ${upload.size} 不一致，请重新上传`,
			"upload_mismatch",
		);
	}
	const sniffed = sniffAttachmentMime(bytes.subarray(0, 32));
	const kind = sniffed ? deriveUploadKind(sniffed) : null;
	if (!sniffed || !kind) {
		await markUpload(db, upload.id, "failed");
		throw unsupportedType("文件内容不是图片或 PDF，已拒绝");
	}

	let stored: R2Object | null;
	try {
		stored = await bucket.put(upload.r2Key, bytes, {
			onlyIf: { etagDoesNotMatch: "*" },
			httpMetadata: { contentType: sniffed },
		});
	} catch (error) {
		await markUpload(db, upload.id, "failed");
		throw error;
	}
	// onlyIf 不满足（key 已存在）时 R2 返回 null 而不是抛错。
	if (stored === null) {
		throw conflict("该上传已有文件，未覆盖", "upload_conflict");
	}
	if (sniffed !== upload.mime || kind !== upload.kind) {
		await db
			.update(attachmentUploads)
			.set({ mime: sniffed, kind })
			.where(eq(attachmentUploads.id, upload.id));
	}
	return { size: bytes.byteLength, mime: sniffed };
}

/**
 * 第三步：HEAD 回验 R2 里真实的 size / content-type，落 attachments 行。
 * 幂等：重复 confirm 返回同一个附件。
 */
export async function confirmUpload(
	db: AppDatabase,
	bucket: AttachmentBucket,
	userId: string,
	taskId: string,
	uploadId: string,
	source: TaskSource,
	options: { now?: Date } = {},
): Promise<AttachmentRow> {
	const upload = await loadUpload(db, userId, uploadId);
	// 跨任务 confirm 写库前就拦（D1 没有事务，落库后再回滚不了）。
	if (upload.taskId !== taskId) throw uploadNotFound();
	await assertTaskOwned(db, userId, taskId);

	if (upload.attachmentId) {
		const existing = await db
			.select()
			.from(attachments)
			.where(and(eq(attachments.id, upload.attachmentId), eq(attachments.userId, userId)))
			.limit(1);
		if (existing[0]) return existing[0];
	}
	if (upload.status !== "pending") {
		throw conflict("该上传已失效，请重新上传", "upload_expired");
	}
	// 过期的上传占位不能再 confirm：作废、清掉可能已写入的对象。
	if (upload.expiresAt <= (options.now ?? new Date()).toISOString()) {
		await markUpload(db, upload.id, "expired");
		try {
			await bucket.delete(upload.r2Key);
		} catch (error) {
			// cron 第 1 段只扫 pending；这里删失败就记进待删清单。
			await recordPendingDeletions(db, userId, [upload.r2Key], "upload_expired");
			console.error("expired upload r2 delete failed", upload.id, error);
		}
		throw conflict("上传已过期（超过 15 分钟），请重新上传", "upload_expired");
	}

	const head = await bucket.head(upload.r2Key);
	if (head === null) {
		throw conflict("文件没有传上来，请重新上传", "upload_mismatch");
	}
	const realMime = normalizeMime(head.httpMetadata?.contentType);
	const kind = deriveUploadKind(realMime);
	// 服务端不变量：R2 里的对象必须与占位一致、且类型在白名单内，否则丢弃、不落库。
	if (head.size !== upload.size || head.size > MAX_ATTACHMENT_BYTES || !kind || !ALLOWED_ATTACHMENT_MIMES.includes(realMime)) {
		await bucket.delete(upload.r2Key);
		await markUpload(db, upload.id, "failed");
		throw conflict("文件校验失败（大小或类型不符），已丢弃，请重新上传", "upload_mismatch");
	}

	const now = nowIso();
	const row: AttachmentRow = {
		id: newId(),
		userId,
		taskId: upload.taskId,
		kind,
		status: "ready",
		r2Key: upload.r2Key,
		filename: upload.filename,
		mime: realMime,
		size: head.size,
		url: null,
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
	};
	try {
		// 落库时再按「已就绪附件」原子地复核一次额度（单条带条件的 INSERT），
		// 挡住 request 阶段的并发漏网：超额就不插入。
		await db.run(sql`
			insert into attachments
				(id, user_id, task_id, kind, status, r2_key, filename, mime, size, url, created_at, updated_at, deleted_at)
			select ${row.id}, ${userId}, ${row.taskId}, ${kind}, 'ready', ${row.r2Key}, ${row.filename}, ${realMime}, ${row.size},
				null, ${now}, ${now}, null
			where
				(select count(*) from attachments where user_id = ${userId} and task_id = ${row.taskId} and deleted_at is null)
					< ${MAX_ATTACHMENTS_PER_TASK}
				and (select count(*) from attachments where user_id = ${userId} and deleted_at is null)
					< ${MAX_USER_ATTACHMENT_COUNT}
				and (select coalesce(sum(size), 0) from attachments where user_id = ${userId} and deleted_at is null)
					+ ${row.size} <= ${MAX_USER_ATTACHMENT_BYTES}
		`);
	} catch (error) {
		// 并发 confirm：UNIQUE(r2_key) 抢输的一方读回赢家那行，保持幂等。
		const existing = await db
			.select()
			.from(attachments)
			.where(and(eq(attachments.userId, userId), eq(attachments.r2Key, upload.r2Key)))
			.limit(1);
		if (existing[0]) return existing[0];
		throw error;
	}
	const inserted = await db
		.select({ id: attachments.id })
		.from(attachments)
		.where(eq(attachments.id, row.id))
		.limit(1);
	if (!inserted[0]) {
		await markUpload(db, upload.id, "failed");
		try {
			await bucket.delete(upload.r2Key);
		} catch {
			await recordPendingDeletions(db, userId, [upload.r2Key], "quota_rejected");
		}
		const perTask = await countTaskAttachments(db, userId, upload.taskId);
		if (perTask >= MAX_ATTACHMENTS_PER_TASK) {
			throw conflict(`单个任务最多 ${MAX_ATTACHMENTS_PER_TASK} 个附件`, "task_attachment_limit");
		}
		throw conflict("附件额度已满，文件未保存", "user_quota_exceeded");
	}
	await db
		.update(attachmentUploads)
		.set({ status: "confirmed", attachmentId: row.id, confirmedAt: now })
		.where(eq(attachmentUploads.id, upload.id));
	// 记在任务时间线上（entity=task），任务被彻底清理时随任务活动一起清。
	await logActivity(db, {
		userId,
		source,
		action: "attachment.create",
		entityType: "task",
		entityId: upload.taskId,
		summary: `上传附件「${row.filename}」`,
	});
	return row;
}

/** 任务详情的附件列表。任务在回收站 → 404（附件随任务隐藏）。 */
export async function listTaskAttachments(
	db: AppDatabase,
	userId: string,
	taskId: string,
): Promise<AttachmentRow[]> {
	await assertTaskOwned(db, userId, taskId);
	return db
		.select()
		.from(attachments)
		.where(
			and(
				eq(attachments.userId, userId),
				eq(attachments.taskId, taskId),
				isNull(attachments.deletedAt),
			),
		)
		.orderBy(asc(attachments.createdAt), asc(attachments.id));
}

/**
 * 读单个附件（下载 / 删除用）：必须是自己的、未删除、且所属任务不在回收站。
 * 别人的附件、已删附件、回收站任务的附件一律 404（不区分，避免探测）。
 */
export async function getAttachment(
	db: AppDatabase,
	userId: string,
	attachmentId: string,
): Promise<AttachmentRow> {
	const rows = await db
		.select({ attachment: attachments })
		.from(attachments)
		.innerJoin(tasks, eq(tasks.id, attachments.taskId))
		.where(
			and(
				eq(attachments.id, attachmentId),
				eq(attachments.userId, userId),
				isNull(attachments.deletedAt),
				eq(tasks.userId, userId),
				isNull(tasks.deletedAt),
			),
		)
		.limit(1);
	if (!rows[0]) throw attachmentNotFound();
	return rows[0].attachment;
}

/**
 * 删除附件：先写 deleted_at（立即从列表消失），再删 R2 对象，成功后删行。
 * R2 删失败不报错给用户：行保留 deleted_at，由每日 cron（purgeAttachments）重试。
 */
export async function deleteAttachment(
	db: AppDatabase,
	bucket: AttachmentBucket,
	userId: string,
	taskId: string,
	attachmentId: string,
	source: TaskSource,
): Promise<{ ok: true; r2Deleted: boolean }> {
	const row = await getAttachment(db, userId, attachmentId);
	// 拿 A 任务的 URL 删 B 任务的附件 → 404，写库前拦。
	if (row.taskId !== taskId) throw attachmentNotFound();
	const now = nowIso();
	await db
		.update(attachments)
		.set({ deletedAt: now, updatedAt: now })
		.where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId)));
	let r2Deleted = false;
	try {
		if (row.r2Key) await bucket.delete(row.r2Key);
		await db
			.delete(attachments)
			.where(and(eq(attachments.id, attachmentId), eq(attachments.userId, userId)));
		r2Deleted = true;
	} catch (error) {
		console.error("attachment r2 delete failed; cron will retry", attachmentId, error);
	}
	await logActivity(db, {
		userId,
		source,
		action: "attachment.delete",
		entityType: "task",
		entityId: row.taskId,
		summary: `删除附件「${row.filename ?? ""}」`,
	});
	return { ok: true, r2Deleted };
}

export type PurgeAttachmentsResult = {
	/** 过期未完成的上传占位（作废 + 清可能已写入的对象）。 */
	staleUploads: number;
	/** 已删除、R2 待清的附件。 */
	deletedAttachments: number;
	/** 随回收站任务一起到期的附件。 */
	expiredTaskAttachments: number;
	/** 终态 upload 行（超过保留期删行）。 */
	uploadRecords: number;
	/** 待删清单（项目删除等）本轮删掉 / 仍失败的 R2 key 数。 */
	pendingDeleted: number;
	pendingFailed: number;
	/** R2 删失败的 key 数（下一轮重试）。 */
	failed: number;
	/**
	 * 第 3 段（回收站到期任务的附件）R2 删失败：调用方本轮必须跳过任务硬删，
	 * 否则 FK cascade 带走附件行，R2 对象就成了找不回 key 的孤儿。
	 */
	blockTaskPurge: boolean;
};

/**
 * 每日 cron（挂在现有 `scheduled` 上，不新增 trigger）：
 *  0) 重试 r2_pending_deletions 里的 key（项目删除等硬删路径留下的）；
 *  1) 过期的 pending 上传 → 删 R2 里可能已写入的对象，占位置为 expired；
 *  2) deleted_at 非空的附件（删除时 R2 删失败）→ 重试删 R2 + 删行；
 *  3) 所属任务在回收站超过保留期（与 purgeExpiredDeleted 同一 cutoff）→ 删 R2 + 删附件行 / 上传行；
 *  4) 超过 7 天的终态 upload 行 → 删行。
 *
 * 必须在 purgeExpiredDeleted（硬删任务）**之前**跑：任务行一删，FK cascade 会带走附件行，
 * R2 key 就找不到了。第 3 段有 R2 删失败时返回 `failed > 0`，调用方应跳过本轮任务清理。
 */
export async function purgeAttachments(
	db: AppDatabase,
	bucket: AttachmentBucket | undefined | null,
	options: { now?: Date } = {},
): Promise<PurgeAttachmentsResult> {
	if (!bucket || typeof bucket.delete !== "function") {
		// 配置问题（绑定缺失），不是对象级失败：整体抛错让 cron 告警。
		throw new AppError(500, "storage_unavailable", "附件存储未配置：env.UPLOADS 绑定缺失");
	}
	const now = options.now ?? new Date();
	const nowIsoStr = now.toISOString();
	const result: PurgeAttachmentsResult = {
		staleUploads: 0,
		deletedAttachments: 0,
		expiredTaskAttachments: 0,
		uploadRecords: 0,
		pendingDeleted: 0,
		pendingFailed: 0,
		failed: 0,
		blockTaskPurge: false,
	};

	// 0) 待删清单（项目删除 / 过期 confirm 等路径没删掉的 R2 对象）。
	const pending = await drainPendingDeletions(db, bucket, { now });
	result.pendingDeleted = pending.deleted;
	result.pendingFailed = pending.failed;

	async function deleteKeys(keys: string[]): Promise<boolean> {
		if (keys.length === 0) return true;
		try {
			for (const part of chunk(keys, 1000)) await bucket!.delete(part);
			return true;
		} catch (error) {
			console.error("attachments purge: r2 delete failed", error);
			result.failed += keys.length;
			return false;
		}
	}

	// 1) 过期 pending 上传。
	const justExpired = new Set<string>();
	const staleUploads = await db
		.select({ id: attachmentUploads.id, r2Key: attachmentUploads.r2Key })
		.from(attachmentUploads)
		.where(and(eq(attachmentUploads.status, "pending"), lt(attachmentUploads.expiresAt, nowIsoStr)));
	if (await deleteKeys(staleUploads.map((row) => row.r2Key))) {
		for (const ids of chunk(staleUploads.map((row) => row.id), ID_BATCH)) {
			await db
				.update(attachmentUploads)
				.set({ status: "expired" })
				.where(inArray(attachmentUploads.id, ids));
			for (const id of ids) justExpired.add(id);
		}
		result.staleUploads = staleUploads.length;
	}

	// 2) 已删除但 R2 还没清掉的附件（宽限 60 秒，避开正在进行的删除请求）。
	const graceCutoff = new Date(now.getTime() - ATTACHMENT_PURGE_GRACE_MS).toISOString();
	const deleted = await db
		.select({ id: attachments.id, r2Key: attachments.r2Key })
		.from(attachments)
		.where(and(isNotNull(attachments.deletedAt), lt(attachments.deletedAt, graceCutoff)));
	if (await deleteKeys(deleted.map((row) => row.r2Key).filter((key): key is string => !!key))) {
		for (const ids of chunk(deleted.map((row) => row.id), ID_BATCH)) {
			await db.delete(attachments).where(inArray(attachments.id, ids));
		}
		result.deletedAttachments = deleted.length;
	}

	// 3) 回收站里到期的任务：附件 + 未完成上传都随任务彻底清掉。
	const taskCutoff = softDeleteCutoffIso(now);
	const expiredTaskAttachments = await db
		.select({ id: attachments.id, r2Key: attachments.r2Key })
		.from(attachments)
		.innerJoin(tasks, eq(tasks.id, attachments.taskId))
		.where(
			and(
				eq(tasks.userId, attachments.userId),
				isNotNull(tasks.deletedAt),
				lt(tasks.deletedAt, taskCutoff),
			),
		);
	const expiredTaskUploads = await db
		.select({ id: attachmentUploads.id, r2Key: attachmentUploads.r2Key })
		.from(attachmentUploads)
		.innerJoin(tasks, eq(tasks.id, attachmentUploads.taskId))
		.where(
			and(
				eq(attachmentUploads.status, "pending"),
				isNotNull(tasks.deletedAt),
				lt(tasks.deletedAt, taskCutoff),
			),
		);
	const taskKeys = [
		...expiredTaskAttachments.map((row) => row.r2Key),
		...expiredTaskUploads.map((row) => row.r2Key),
	].filter((key): key is string => !!key);
	if (await deleteKeys(taskKeys)) {
		for (const ids of chunk(expiredTaskAttachments.map((row) => row.id), ID_BATCH)) {
			await db.delete(attachments).where(inArray(attachments.id, ids));
		}
		for (const ids of chunk(expiredTaskUploads.map((row) => row.id), ID_BATCH)) {
			await db.delete(attachmentUploads).where(inArray(attachmentUploads.id, ids));
		}
		result.expiredTaskAttachments = expiredTaskAttachments.length;
	} else {
		result.blockTaskPurge = true;
	}

	// 4) 终态 upload 行：超过 7 天删行（本轮刚作废的跳过，下一轮再删）。
	const uploadCutoff = new Date(now.getTime() - UPLOAD_RECORD_RETENTION_MS).toISOString();
	const terminal = await db
		.select({ id: attachmentUploads.id })
		.from(attachmentUploads)
		.where(
			and(
				inArray(attachmentUploads.status, [...TERMINAL_UPLOAD_STATUSES]),
				lt(attachmentUploads.createdAt, uploadCutoff),
			),
		);
	const terminalIds = terminal.map((row) => row.id).filter((id) => !justExpired.has(id));
	for (const ids of chunk(terminalIds, ID_BATCH)) {
		await db.delete(attachmentUploads).where(inArray(attachmentUploads.id, ids));
	}
	result.uploadRecords = terminalIds.length;

	return result;
}

/* ------------------------------------------------------------------------------------------
 * R2 待删清单（r2_pending_deletions）：给「附件行会被 cascade 带走」的硬删路径用。
 * 流程：先记清单（持久意图）→ 删 DB → 删 R2 → 成功的从清单移除；失败的留给 cron 重试。
 * ---------------------------------------------------------------------------------------- */

/** 新记进清单的 key 在这段时间内 cron 不碰，避免和正在进行的「记清单 → 删库」撞车。 */
export const PENDING_DELETION_GRACE_MS = 5 * 60 * 1000;
const PENDING_DELETION_BATCH = 500;

export async function recordPendingDeletions(
	db: AppDatabase,
	userId: string,
	keys: string[],
	reason: string,
) {
	const now = nowIso();
	// 每行 7 个参数，D1 单语句上限 100 个参数 → 每批 10 行。
	for (const part of chunk([...new Set(keys)], 10)) {
		await db
			.insert(r2PendingDeletions)
			.values(part.map((r2Key) => ({ r2Key, userId, reason, attempts: 0, lastError: null, createdAt: now, updatedAt: now })))
			.onConflictDoNothing();
	}
}

/** 仍被活着的附件 / 上传行引用的 key：不能删 R2（说明对应的硬删没真正发生）。 */
async function referencedKeys(db: AppDatabase, keys: string[]): Promise<Set<string>> {
	const referenced = new Set<string>();
	for (const part of chunk(keys, ID_BATCH)) {
		const a = await db
			.select({ key: attachments.r2Key })
			.from(attachments)
			.where(inArray(attachments.r2Key, part));
		const u = await db
			.select({ key: attachmentUploads.r2Key })
			.from(attachmentUploads)
			.where(inArray(attachmentUploads.r2Key, part));
		for (const row of [...a, ...u]) if (row.key) referenced.add(row.key);
	}
	return referenced;
}

/**
 * 处理清单里的一批 key：仍被引用的直接从清单移除（不删 R2）；其余删 R2，
 * 成功的移出清单，失败的 attempts+1 记下错误，等下次 cron。
 */
export async function flushPendingDeletions(
	db: AppDatabase,
	bucket: AttachmentBucket | undefined | null,
	keys: string[],
): Promise<{ deleted: number; failed: number; skipped: number }> {
	const unique = [...new Set(keys)];
	if (unique.length === 0) return { deleted: 0, failed: 0, skipped: 0 };
	const referenced = await referencedKeys(db, unique);
	const skipped = unique.filter((key) => referenced.has(key));
	for (const part of chunk(skipped, ID_BATCH)) {
		await db.delete(r2PendingDeletions).where(inArray(r2PendingDeletions.r2Key, part));
	}
	const toDelete = unique.filter((key) => !referenced.has(key));
	let deleted = 0;
	let failed = 0;
	for (const part of chunk(toDelete, ID_BATCH)) {
		try {
			if (!bucket || typeof bucket.delete !== "function") {
				throw new Error("r2_binding_missing");
			}
			await bucket.delete(part);
			await db.delete(r2PendingDeletions).where(inArray(r2PendingDeletions.r2Key, part));
			deleted += part.length;
		} catch (error) {
			failed += part.length;
			await db
				.update(r2PendingDeletions)
				.set({
					attempts: sql`${r2PendingDeletions.attempts} + 1`,
					lastError: String(error instanceof Error ? error.message : error).slice(0, 500),
					updatedAt: nowIso(),
				})
				.where(inArray(r2PendingDeletions.r2Key, part));
		}
	}
	return { deleted, failed, skipped: skipped.length };
}

/** cron：重试清单里超过宽限期的 key。 */
export async function drainPendingDeletions(
	db: AppDatabase,
	bucket: AttachmentBucket | undefined | null,
	options: { now?: Date } = {},
) {
	const now = options.now ?? new Date();
	const cutoff = new Date(now.getTime() - PENDING_DELETION_GRACE_MS).toISOString();
	const rows = await db
		.select({ key: r2PendingDeletions.r2Key })
		.from(r2PendingDeletions)
		.where(lt(r2PendingDeletions.createdAt, cutoff))
		.orderBy(asc(r2PendingDeletions.createdAt))
		.limit(PENDING_DELETION_BATCH);
	return flushPendingDeletions(
		db,
		bucket,
		rows.map((row) => row.key),
	);
}

/**
 * 删除项目前的第一步：找出该项目下（含回收站里）所有任务的附件 / 上传对象，
 * 记进待删清单，再显式删掉附件 / 上传行（不只依赖 FK cascade）。返回要删的 R2 key。
 * 调用方删完项目后再调 flushPendingDeletions。
 */
export async function detachProjectAttachments(
	db: AppDatabase,
	userId: string,
	projectId: string,
): Promise<string[]> {
	const taskRows = await db
		.select({ id: tasks.id })
		.from(tasks)
		.where(and(eq(tasks.userId, userId), eq(tasks.projectId, projectId)));
	const taskIds = taskRows.map((row) => row.id);
	const keys: string[] = [];
	for (const ids of chunk(taskIds, ID_BATCH)) {
		const a = await db
			.select({ key: attachments.r2Key })
			.from(attachments)
			.where(and(eq(attachments.userId, userId), inArray(attachments.taskId, ids)));
		const u = await db
			.select({ key: attachmentUploads.r2Key })
			.from(attachmentUploads)
			.where(and(eq(attachmentUploads.userId, userId), inArray(attachmentUploads.taskId, ids)));
		for (const row of [...a, ...u]) if (row.key) keys.push(row.key);
	}
	const unique = [...new Set(keys)];
	if (unique.length === 0) return [];
	// 先记清单（持久意图），再删行：中途失败也不会丢 key。
	await recordPendingDeletions(db, userId, unique, "project_delete");
	for (const ids of chunk(taskIds, ID_BATCH)) {
		await db
			.delete(attachmentUploads)
			.where(and(eq(attachmentUploads.userId, userId), inArray(attachmentUploads.taskId, ids)));
		await db
			.delete(attachments)
			.where(and(eq(attachments.userId, userId), inArray(attachments.taskId, ids)));
	}
	return unique;
}
