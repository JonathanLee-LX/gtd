import { z } from "zod";
import { createTagInput, createTaskInput, updateTaskInput } from "../../shared/schemas";
import type { AppDatabase } from "../../db/client";
import {
	completeTask,
	createTask,
	deleteTask,
	getTask,
	listTasks,
	nudgeWaiting,
	restoreTask,
	searchTasks,
	todayFocus,
	updateTask,
} from "../services/tasks";
import { createProject, listProjects } from "../services/projects";
import { createTag, listTags } from "../services/tags";

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
		description: "列出当前用户的所有项目，含不可删除的收件箱。",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
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
		name: "list_tags",
		description: "列出当前用户的所有标签。了解今天该做什么请优先用 today_focus。",
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
		description: "按 id 获取一条完整任务，含项目名和标签。",
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
				notes: { type: "string" },
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
				notes: { type: "string" },
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
		description: "今日焦点：逾期 + 今天到期 + 下一步 + P1。优先用这个了解今天该做什么。",
		inputSchema: {
			type: "object",
			properties: { tz: { type: "string" } },
			additionalProperties: false,
		},
	},
] as const;

export async function callMcpTool(
	db: AppDatabase,
	userId: string,
	name: string,
	args: Record<string, unknown>,
) {
	switch (name) {
		case "list_projects":
			return { items: await listProjects(db, userId) };
		case "create_project": {
			const input = z.object({ name: z.string(), color: z.string().optional() }).parse(args);
			return { project: await createProject(db, userId, input, "mcp") };
		}
		case "list_tags":
			return { items: await listTags(db, userId) };
		case "create_tag": {
			const input = createTagInput.parse(args);
			return { tag: await createTag(db, userId, input.name, "mcp") };
		}
		case "list_tasks":
			return listTasks(db, userId, listTasksToolInput.parse(args));
		case "get_task": {
			const input = z.object({ id: z.string() }).parse(args);
			return { task: await getTask(db, userId, input.id) };
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
		default:
			throw new Error(`未知工具: ${name}`);
	}
}
