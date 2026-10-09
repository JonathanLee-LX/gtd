/**
 * #68 附件 HTTP 层（迁移自 gtd-attach-exp 的 routes/attachments.ts）：只管鉴权、参数校验、
 * HTTP 语义（Range / Content-Disposition / 状态码），业务与 SQL 全在 services/attachments.ts。
 * 挂在 /api 下，且必须在 taskRoutes 之前注册。
 *
 *   GET    /api/tasks/:taskId/attachments                           列表 + 用量
 *   POST   /api/tasks/:taskId/attachments/uploads                   第一步：校验 + 占位，下发上传地址
 *   PUT    /api/attachments/uploads/:uploadId/content               第二步：字节经 Worker 落 R2
 *   POST   /api/tasks/:taskId/attachments/uploads/:uploadId/confirm 第三步：HEAD 回验 + 落库（幂等）
 *   GET    /api/attachments/:id/content[?download=1]                同源代理下载（支持 Range）
 *   DELETE /api/tasks/:taskId/attachments/:id                       删除（连 R2 对象）
 *
 * v1 不开放「链接附件」和单个附件恢复。
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createDb } from "../../db/client";
import { PDF_MIME, isInlineImageMime, normalizeMime } from "../../shared/limits";
import { requestAttachmentUploadInput } from "../../shared/schemas";
import { AppError, badRequest } from "../lib/errors";
import { handleRoute } from "../lib/route-utils";
import type { AppEnv } from "../lib/storage";
import { requireUser, type AppVariables } from "../middleware/require-user";
import {
	attachmentContentPath,
	attachmentUsage,
	confirmUpload,
	deleteAttachment,
	getAttachment,
	listTaskAttachments,
	putUploadObject,
	requestUpload,
	type AttachmentRow,
} from "../services/attachments";

/** 解析单段 `bytes=start-end`。返回 null 表示不可满足 → 416。 */
export function parseByteRange(
	header: string,
	size: number,
): { offset: number; length: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const start = match[1] ?? "";
	const end = match[2] ?? "";
	if (start === "" && end === "") return null;
	if (start === "") {
		const suffix = Number(end);
		if (!Number.isFinite(suffix) || suffix <= 0) return null;
		const length = Math.min(suffix, size);
		return { offset: size - length, length };
	}
	const offset = Number(start);
	if (!Number.isFinite(offset) || offset >= size) return null;
	const last = end === "" ? size - 1 : Math.min(Number(end), size - 1);
	if (!Number.isFinite(last) || last < offset) return null;
	return { offset, length: last - offset + 1 };
}

/** 中文文件名同时给 ASCII 兜底和 RFC 5987 编码。 */
export function contentDisposition(filename: string | null, inline: boolean): string {
	const name = filename && filename.trim().length > 0 ? filename : "download";
	const ascii = name.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "_");
	return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 出网 DTO：r2Key / userId / status 是内部字段，不透给客户端。 */
export function toAttachmentDto(row: AttachmentRow) {
	return {
		id: row.id,
		taskId: row.taskId,
		kind: row.kind,
		fileName: row.filename,
		mime: row.mime,
		size: row.size,
		contentUrl: attachmentContentPath(row.id),
		createdAt: row.createdAt,
	};
}

export type AttachmentDto = ReturnType<typeof toAttachmentDto>;

function jsonError(error: unknown) {
	if (error instanceof AppError) {
		return Response.json(
			{ error: error.code, message: error.message },
			{ status: error.status as ContentfulStatusCode },
		);
	}
	console.error(error);
	return Response.json({ error: "internal", message: "服务器出错了" }, { status: 500 });
}

export const attachmentRoutes = new Hono<{
	Bindings: AppEnv;
	Variables: AppVariables;
}>()
	// 只罩附件自己的路径，别让 /api/tasks/* 其他路由多跑一遍鉴权。
	.use("/tasks/:taskId/attachments", requireUser)
	.use("/tasks/:taskId/attachments/*", requireUser)
	.use("/attachments/*", requireUser)
	.get("/tasks/:taskId/attachments", (c) =>
		handleRoute(c, async () => {
			const db = createDb(c.env.DB);
			const userId = c.get("user").id;
			const items = await listTaskAttachments(db, userId, c.req.param("taskId"));
			const usage = await attachmentUsage(db, userId);
			return { items: items.map(toAttachmentDto), usage };
		}),
	)
	.post(
		"/tasks/:taskId/attachments/uploads",
		zValidator("json", requestAttachmentUploadInput),
		(c) =>
			handleRoute(
				c,
				async () =>
					requestUpload(
						createDb(c.env.DB),
						c.get("user").id,
						c.req.param("taskId"),
						c.req.valid("json"),
					),
				201,
			),
	)
	.put("/attachments/uploads/:uploadId/content", (c) =>
		handleRoute(c, async () => {
			const body = c.req.raw.body;
			if (!body) throw badRequest("请求体为空", "empty_body");
			return putUploadObject(
				createDb(c.env.DB),
				c.env.UPLOADS,
				c.get("user").id,
				c.req.param("uploadId"),
				body,
			);
		}),
	)
	.post("/tasks/:taskId/attachments/uploads/:uploadId/confirm", (c) =>
		handleRoute(c, async () => {
			const attachment = await confirmUpload(
				createDb(c.env.DB),
				c.env.UPLOADS,
				c.get("user").id,
				c.req.param("taskId"),
				c.req.param("uploadId"),
				c.get("source"),
			);
			return { attachment: toAttachmentDto(attachment) };
		}),
	)
	// 同源代理下载：不发预签名 URL，R2 不对外暴露。
	.get("/attachments/:id/content", async (c) => {
		try {
			const db = createDb(c.env.DB);
			const row = await getAttachment(db, c.get("user").id, c.req.param("id"));
			if (!row.r2Key) throw new AppError(404, "not_found", "附件内容不存在");

			const rangeHeader = c.req.header("range");
			const total = row.size ?? null;
			let range: { offset: number; length: number } | null = null;
			if (rangeHeader && total !== null) {
				range = parseByteRange(rangeHeader, total);
				if (!range) {
					return c.json(
						{ error: "range_not_satisfiable", message: "请求的字节范围不可满足" },
						416,
						{ "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
					);
				}
			}

			const object = await c.env.UPLOADS.get(row.r2Key, range ? { range } : undefined);
			if (!object) throw new AppError(404, "not_found", "附件内容不存在");

			const mime = normalizeMime(row.mime);
			const inline =
				c.req.query("download") !== "1" && (isInlineImageMime(mime) || mime === PDF_MIME);
			const headers = new Headers();
			headers.set("Content-Type", mime || "application/octet-stream");
			headers.set("ETag", object.httpEtag);
			headers.set("Accept-Ranges", "bytes");
			// 私有内容：不进共享缓存。
			headers.set("Cache-Control", "private, max-age=0, must-revalidate");
			headers.set("X-Content-Type-Options", "nosniff");
			headers.set("Content-Disposition", contentDisposition(row.filename, inline));
			if (isInlineImageMime(mime)) {
				headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
			}
			const status = range ? 206 : 200;
			if (range && total !== null) {
				headers.set(
					"Content-Range",
					`bytes ${range.offset}-${range.offset + range.length - 1}/${total}`,
				);
				headers.set("Content-Length", String(range.length));
			} else if (total !== null) {
				headers.set("Content-Length", String(total));
			}
			return new Response(object.body, { status, headers });
		} catch (error) {
			return jsonError(error);
		}
	})
	.delete("/tasks/:taskId/attachments/:id", (c) =>
		handleRoute(c, async () =>
			deleteAttachment(
				createDb(c.env.DB),
				c.env.UPLOADS,
				c.get("user").id,
				c.req.param("taskId"),
				c.req.param("id"),
				c.get("source"),
			),
		),
	);
