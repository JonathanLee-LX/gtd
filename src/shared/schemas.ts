import { z } from "zod";
import { SEARCH_Q_MAX_CHARS } from "./search";

export const taskStatusSchema = z.enum([
	"inbox",
	"next",
	"waiting",
	"scheduled",
	"someday",
	"completed",
	"cancelled",
]);

export const taskPrioritySchema = z.enum(["none", "p1", "p2", "p3"]);

export const taskSourceSchema = z.enum(["human", "mcp", "ai"]);

export const dateOnlySchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必须是 YYYY-MM-DD");

export const createProjectInput = z.object({
	name: z.string().trim().min(1).max(80),
	color: z.string().max(20).optional(),
});

export const updateProjectInput = z.object({
	name: z.string().trim().min(1).max(80).optional(),
	color: z.string().max(20).nullable().optional(),
	archived: z.boolean().optional(),
	sortOrder: z.number().int().optional(),
});

export const createTaskInput = z.object({
	title: z.string().trim().min(1).max(500),
	notes: z.string().max(8000).optional(),
	projectId: z.string().min(1).optional(),
	status: taskStatusSchema.optional(),
	priority: taskPrioritySchema.optional(),
	dueAt: dateOnlySchema.nullable().optional(),
	startAt: dateOnlySchema.nullable().optional(),
	waitingOn: z.string().max(200).nullable().optional(),
	parentId: z.string().min(1).nullable().optional(),
	tagIds: z.array(z.string().min(1)).max(20).optional(),
	idempotencyKey: z.string().min(8).max(80).optional(),
});

export const updateTaskInput = z.object({
	title: z.string().trim().min(1).max(500).optional(),
	notes: z.string().max(8000).nullable().optional(),
	projectId: z.string().min(1).optional(),
	status: taskStatusSchema.optional(),
	priority: taskPrioritySchema.optional(),
	dueAt: dateOnlySchema.nullable().optional(),
	startAt: dateOnlySchema.nullable().optional(),
	waitingOn: z.string().max(200).nullable().optional(),
	parentId: z.string().min(1).nullable().optional(),
	tagIds: z.array(z.string().min(1)).max(20).optional(),
});

export const listTasksQuery = z.object({
	status: taskStatusSchema.optional(),
	projectId: z.string().min(1).optional(),
	tagId: z.string().min(1).optional(),
	priority: taskPrioritySchema.optional(),
	due: z.enum(["overdue", "today", "upcoming", "none"]).optional(),
	q: z.string().max(SEARCH_Q_MAX_CHARS).optional(),
	includeCompleted: z.enum(["true", "false"]).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	cursor: z.string().optional(),
	tz: z.string().max(64).optional(),
});

export const createTagInput = z.object({
	name: z.string().trim().min(1).max(40),
});

export const createTokenInput = z.object({
	name: z.string().trim().min(1).max(40),
});

export const todayFocusQuery = z.object({
	tz: z.string().max(64).optional(),
});

export const parseAiInput = z.object({
	text: z.string().trim().min(1).max(2000),
	tz: z.string().max(64).optional(),
});

export const taskDraftSchema = z.object({
	title: z.string().trim().min(1).max(500),
	notes: z.string().max(8000).nullable(),
	status: taskStatusSchema,
	priority: taskPrioritySchema,
	dueAt: dateOnlySchema.nullable(),
	waitingOn: z.string().max(200).nullable(),
	tagNames: z.array(z.string().trim().min(1).max(40)).max(8),
});

export const parseAiOutput = z.object({
	tasks: z.array(taskDraftSchema).min(1).max(8),
});

export const commitAiInput = taskDraftSchema.extend({
	projectId: z.string().min(1).optional(),
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskPriority = z.infer<typeof taskPrioritySchema>;
export type TaskSource = z.infer<typeof taskSourceSchema>;
export type CreateProjectInput = z.infer<typeof createProjectInput>;
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;
export type CreateTaskInput = z.infer<typeof createTaskInput>;
export type UpdateTaskInput = z.infer<typeof updateTaskInput>;
export type ListTasksQuery = z.infer<typeof listTasksQuery>;
export type TaskDraft = z.infer<typeof taskDraftSchema>;
export type ParseAiOutput = z.infer<typeof parseAiOutput>;
export type CommitAiInput = z.infer<typeof commitAiInput>;
