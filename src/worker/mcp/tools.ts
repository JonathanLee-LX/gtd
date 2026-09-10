import { z } from "zod";
import { createTaskInput, updateTaskInput } from "../../shared/schemas";
import type { AppDatabase } from "../../db/client";
import {
	completeTask,
	createTask,
	deleteTask,
	getTask,
	listTasks,
	searchTasks,
	todayFocus,
	updateTask,
} from "../services/tasks";
import { createProject, listProjects } from "../services/projects";

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
		name: "list_tasks",
		description:
			"按状态、项目、截止日期或关键词列出任务。默认不含已完成/已取消。",
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
			"创建任务。不传 projectId 时进入收件箱。建议传 idempotencyKey 避免重复创建。dueAt 用 YYYY-MM-DD。",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string" },
				notes: { type: "string" },
				projectId: { type: "string" },
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
		description: "部分更新任务字段。完成任务请改用 complete_task。",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string" },
				title: { type: "string" },
				notes: { type: "string" },
				projectId: { type: "string" },
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
		name: "complete_task",
		description: "将任务标为已完成。",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "delete_task",
		description: "软删除任务。删除后列表/今日焦点不再出现，GET 返回不存在。",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "search_tasks",
		description: "按标题/备注搜索，包含已完成任务。",
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
		case "complete_task": {
			const input = z.object({ id: z.string() }).parse(args);
			return { task: await completeTask(db, userId, input.id, "mcp") };
		}
		case "delete_task": {
			const input = z.object({ id: z.string() }).parse(args);
			return deleteTask(db, userId, input.id, "mcp");
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
