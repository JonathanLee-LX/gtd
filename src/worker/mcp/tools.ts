import { z } from "zod";
import {
	createTagInput,
	createTaskInput,
	deleteTagInput,
	updateProjectInput,
	updateTaskInput,
} from "../../shared/schemas";
import type { AppDatabase } from "../../db/client";
import { AppError } from "../lib/errors";
import {
	completeTask,
	createTask,
	deleteTask,
	listTasks,
	nudgeWaiting,
	restoreTask,
	searchTasks,
	todayFocus,
	updateTask,
} from "../services/tasks";
import { createProject, listProjects, updateProject } from "../services/projects";
import { createTag, deleteTag, listTags } from "../services/tags";
import {
	attachmentUsage,
	deleteAttachment,
	getTaskWithAttachments,
	listTaskAttachments,
	toAttachmentDto,
	uploadTaskAttachment,
	type AttachmentBucket,
} from "../services/attachments";

const listTasksToolInput = z.object({
	status: z
		.enum(["inbox", "next", "waiting", "scheduled", "someday", "completed", "cancelled"])
		.optional(),
	projectId: z.string().optional(),
	q: z.string().optional(),
	due: z.enum(["overdue", "today", "upcoming", "none"]).optional(),
	tz: z.string().optional(),
});

export const MCP_TOOLS = [
	{
		name: "list_projects",
		description:
			"列出当前用户的项目，含不可删除的收件箱。默认不含已归档；传 includeArchived=true 可查看并配合 update_project 取消归档。",
		inputSchema: {
			type: "object",
			properties: {
				includeArchived: {
					type: "boolean",
					description: "默认 false。true 时包含已归档项目。",
				},
			},
			additionalProperties: false,
		},
	},
	{
		name: "create_project",
		description: "创建一个新项目。不要用这个创建收件箱。",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				color: { type: "string" },
			},
			required: ["name"],
			additionalProperties: false,
		},
	},
	{
		name: "update_project",
		description:
			"部分更新项目。archived true 归档、false 取消归档。收件箱不能归档或改名。归档不删项目下的任务。",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				name: { type: "string" },
				color: { type: ["string", "null"] },
				archived: {
					type: "boolean",
					description: "true 归档，false 取消归档。",
				},
				sortOrder: { type: "integer" },
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "list_tags",
		description: "列出当前用户的所有标签（含各标签关联未删任务数 taskCount）。了解今天该做什么请优先用 today_focus。",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "create_tag",
		description: "创建标签。同名已存在则返回已有标签。",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
			additionalProperties: false,
		},
	},
	{
		name: "delete_tag",
		description: "删除标签，并自动从所有关联任务上移除该标签（不可恢复）。",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string", description: "标签 id" } },
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "list_tasks",
		description:
			"按状态、项目、截止日期或关键词列出任务。默认不含已完成/已取消/已软删。",
		inputSchema: {
			type: "object",
			properties: {
				status: {
					type: "string",
					enum: ["inbox", "next", "waiting", "scheduled", "someday", "completed", "cancelled"],
				},
				projectId: { type: "string" },
				q: { type: "string" },
				due: { type: "string", enum: ["overdue", "today", "upcoming", "none"] },
				tz: { type: "string" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "get_task",
		description: "按 id 获取一条完整任务，含项目名、标签与附件列表（备注为 Markdown 格式）。",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "create_task",
		description:
			"创建任务。不传 projectId 时进入收件箱。可选 parentId 挂到已有任务下（禁止成环）。建议传 idempotencyKey 避免重复创建。dueAt 用 YYYY-MM-DD。",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				notes: {
					type: "string",
					description:
						"任务备注，支持 Markdown（标题、列表、任务列表、代码块、表格、链接），网页端会渲染显示，最长 8000 字。",
				},
				projectId: { type: "string" },
				parentId: {
					type: ["string", "null"],
					description: "父任务 id；省略或 null 表示顶层。不能指向自身或形成循环。",
				},
				status: {
					type: "string",
					enum: ["inbox", "next", "waiting", "scheduled", "someday", "completed", "cancelled"],
				},
				priority: { type: "string", enum: ["none", "p1", "p2", "p3"] },
				dueAt: { type: "string" },
				waitingOn: { type: "string" },
				idempotencyKey: { type: "string" },
			},
			required: ["title"],
			additionalProperties: false,
		},
	},
	{
		name: "update_task",
		description: "部分更新任务字段。可改 parentId（null 取消父子）；禁止成环。完成任务请改用 complete_task。",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				title: { type: "string" },
				notes: {
					type: "string",
					description:
						"任务备注，支持 Markdown（标题、列表、任务列表、代码块、表格、链接），网页端会渲染显示，最长 8000 字。",
				},
				projectId: { type: "string" },
				parentId: {
					type: ["string", "null"],
					description: "父任务 id；null 表示顶层。不能指向自身或形成循环。",
				},
				status: {
					type: "string",
					enum: ["inbox", "next", "waiting", "scheduled", "someday", "completed", "cancelled"],
				},
				priority: { type: "string", enum: ["none", "p1", "p2", "p3"] },
				dueAt: { type: ["string", "null"] },
				waitingOn: { type: ["string", "null"] },
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "nudge_waiting",
		description:
			"周回顾「要催」：为等待中的任务生成一条下一步「催 {等谁}」。同一等待任务重复调用幂等，不会刷多条。",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string", description: "等待中的任务 id" } },
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "complete_task",
		description: "将任务标为已完成。若有未完成子任务，会提升为顶层（状态不变），不会自动完成子任务。",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "delete_task",
		description: "软删除任务。删除后列表/搜索/今日焦点不再出现。恢复请用 restore_task。",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "restore_task",
		description:
			"从回收站恢复软删除的任务。默认 list_tasks / search_tasks 不含已软删，必须显式调用本工具。",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "search_tasks",
		description: "按标题/备注搜索，包含已完成任务，不含已软删。",
		inputSchema: {
			type: "object",
			properties: { q: { type: "string" }, tz: { type: "string" } },
			required: ["q"],
			additionalProperties: false,
		},
	},
	{
		name: "today_focus",
		description: "今日焦点：逾期 + 今天到期 + 下一步 + P1，只出可执行叶子（有未完成子任务的父任务不出）。优先用这个了解今天该做什么。",
		inputSchema: {
			type: "object",
			properties: { tz: { type: "string" } },
			additionalProperties: false,
		},
	},
	{
		name: "list_attachments",
		description: "列出指定任务的所有附件及其元数据与下载地址，并返回用户附件配额用量。",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "所属任务 id" },
			},
			required: ["taskId"],
			additionalProperties: false,
		},
	},
	{
		name: "upload_attachment",
		description:
			"为任务上传附件（支持图片 JPG/PNG/GIF/WebP/HEIC 与 PDF，单文件不超过 10MB）。通过 base64 传入文件内容。",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "所属任务 id" },
				fileName: { type: "string", description: "文件名，含扩展名（如 photo.jpg、doc.pdf）" },
				content: {
					type: "string",
					description:
						"文件二进制内容的 base64 编码字符串（支持纯 base64 或 data URI 格式）",
				},
				mimeType: {
					type: "string",
					description: "可选 MIME 类型，若未传则根据文件名和内容头自动推断",
				},
			},
			required: ["taskId", "fileName", "content"],
			additionalProperties: false,
		},
	},
	{
		name: "delete_attachment",
		description: "删除任务的指定附件，并清理其 R2 存储对象。",
		inputSchema: {
			type: "object",
			properties: {
				taskId: { type: "string", description: "所属任务 id" },
				id: { type: "string", description: "附件 id" },
			},
			required: ["taskId", "id"],
			additionalProperties: false,
		},
	},
] as const;

/** 标准 base64（允许内部空白，解码前去掉；不接受 base64url 与缺失的填充）。 */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function decodeBase64(content: string): Uint8Array {
	const trimmed = content.trim();
	const commaIdx = trimmed.indexOf(",");
	const raw =
		commaIdx !== -1 && trimmed.slice(0, commaIdx).includes(";base64")
			? trimmed.slice(commaIdx + 1).trim()
			: trimmed;
	// 先严格校验再解码：Buffer.from 遇到非法字符是静默丢弃、不抛错，
	// 不校验的话 "!!!" 这类输入会解成空字节、最后以 invalid_size 报错，文案误导。
	const compact = raw.replace(/[\t\n\f\r ]/g, "");
	if (compact === "" || !BASE64_PATTERN.test(compact)) {
		throw new AppError(400, "invalid_base64", "无效的 base64 内容");
	}
	try {
		if (typeof Buffer !== "undefined") {
			const buf = Buffer.from(compact, "base64");
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		}
		const binary = atob(compact);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	} catch {
		throw new AppError(400, "invalid_base64", "无效的 base64 内容");
	}
}

export type McpToolOptions = {
	bucket?: AttachmentBucket;
};

export async function callMcpTool(
	db: AppDatabase,
	userId: string,
	name: string,
	args: Record<string, unknown>,
	options?: McpToolOptions,
) {
	switch (name) {
		case "list_projects": {
			const input = z.object({ includeArchived: z.boolean().optional() }).parse(args);
			return {
				items: await listProjects(db, userId, {
					includeArchived: input.includeArchived === true,
				}),
			};
		}
		case "create_project": {
			const input = z.object({ name: z.string(), color: z.string().optional() }).parse(args);
			return { project: await createProject(db, userId, input, "mcp") };
		}
		case "update_project": {
			const { id, ...rest } = z.object({ id: z.string() }).and(updateProjectInput).parse(args);
			return { project: await updateProject(db, userId, id, rest, "mcp") };
		}
		case "list_tags":
			return { items: await listTags(db, userId) };
		case "create_tag": {
			const input = createTagInput.parse(args);
			return { tag: await createTag(db, userId, input.name, "mcp") };
		}
		case "delete_tag": {
			const input = deleteTagInput.parse(args);
			return deleteTag(db, userId, input.id, "mcp");
		}
		case "list_tasks":
			return listTasks(db, userId, listTasksToolInput.parse(args));
		case "get_task": {
			const input = z.object({ id: z.string() }).parse(args);
			const { task, attachments } = await getTaskWithAttachments(db, userId, input.id);
			return {
				task: {
					...task,
					attachments: attachments.map(toAttachmentDto),
				},
			};
		}
		case "create_task":
			return { task: await createTask(db, userId, createTaskInput.parse(args), "mcp") };
		case "update_task": {
			const { id, ...rest } = z
				.object({ id: z.string() })
				.and(updateTaskInput)
				.parse(args);
			return { task: await updateTask(db, userId, id, rest, "mcp") };
		}
		case "nudge_waiting": {
			const input = z.object({ id: z.string() }).parse(args);
			return { task: await nudgeWaiting(db, userId, input.id, "mcp") };
		}
		case "complete_task": {
			const input = z.object({ id: z.string() }).parse(args);
			return { task: await completeTask(db, userId, input.id, "mcp") };
		}
		case "delete_task": {
			const input = z.object({ id: z.string() }).parse(args);
			return deleteTask(db, userId, input.id, "mcp");
		}
		case "restore_task": {
			const input = z.object({ id: z.string() }).parse(args);
			return { task: await restoreTask(db, userId, input.id, "mcp") };
		}
		case "search_tasks": {
			const input = z.object({ q: z.string(), tz: z.string().optional() }).parse(args);
			return searchTasks(db, userId, input.q, input.tz);
		}
		case "today_focus": {
			const input = z.object({ tz: z.string().optional() }).parse(args);
			return todayFocus(db, userId, input.tz);
		}
		case "list_attachments": {
			const input = z.object({ taskId: z.string() }).parse(args);
			const items = await listTaskAttachments(db, userId, input.taskId);
			const usage = await attachmentUsage(db, userId);
			return { items: items.map(toAttachmentDto), usage };
		}
		case "upload_attachment": {
			if (!options?.bucket) {
				throw new AppError(500, "storage_not_configured", "未配置附件存储桶 (UPLOADS)");
			}
			const input = z
				.object({
					taskId: z.string(),
					fileName: z.string(),
					content: z.string(),
					mimeType: z.string().optional(),
				})
				.parse(args);
			const bytes = decodeBase64(input.content);
			const row = await uploadTaskAttachment(
				db,
				options.bucket,
				userId,
				input.taskId,
				{
					fileName: input.fileName,
					bytes,
					mime: input.mimeType,
				},
				"mcp",
			);
			return { attachment: toAttachmentDto(row) };
		}
		case "delete_attachment": {
			if (!options?.bucket) {
				throw new AppError(500, "storage_not_configured", "未配置附件存储桶 (UPLOADS)");
			}
			const input = z.object({ taskId: z.string(), id: z.string() }).parse(args);
			return deleteAttachment(
				db,
				options.bucket,
				userId,
				input.taskId,
				input.id,
				"mcp",
			);
		}
		default:
			throw new Error(`未知工具: ${name}`);
	}
}
