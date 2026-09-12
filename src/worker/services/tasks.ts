import { and, desc, eq, exists, inArray, isNotNull, isNull, like, lt, or, sql } from "drizzle-orm";
import { activityLog, projects, taskTags, tasks, user } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import {
	DEFAULT_PAGE_SIZE,
	DEFAULT_TIME_ZONE,
	SOFT_DELETE_RETENTION_DAYS,
} from "../../shared/constants";
import { decodeCursor, encodeCursor } from "../../shared/cursor";
import type {
	CreateTaskInput,
	ListTasksQuery,
	ProcessInboxInput,
	TaskSource,
	UpdateTaskInput,
} from "../../shared/schemas";
import { sanitizeSearchQuery } from "../../shared/search";
import { createsParentCycle } from "../../shared/task-tree";
import { ymdInZone } from "../../shared/today";
import { badRequest, notFound } from "../lib/errors";
import { newId, nowIso } from "../lib/ids";
import { logActivity } from "./activity";
import { getInbox } from "./ensure-inbox";
import { getProject } from "./projects";
import { replaceTaskTags, tagsForTasks } from "./tags";

export type TaskRow = typeof tasks.$inferSelect;

export type TaskView = TaskRow & {
	projectName: string;
	tags: { id: string; name: string }[];
};

async function hydrate(
	db: AppDatabase,
	userId: string,
	rows: TaskRow[],
): Promise<TaskView[]> {
	if (rows.length === 0) return [];
	const projectIds = [...new Set(rows.map((row) => row.projectId))];
	const projectRows = await db
		.select()
		.from(projects)
		.where(and(eq(projects.userId, userId), inArray(projects.id, projectIds)));
	const projectMap = new Map(projectRows.map((row) => [row.id, row.name]));
	const tagMap = await tagsForTasks(
		db,
		rows.map((row) => row.id),
	);
	return rows.map((row) => ({
		...row,
		projectName: projectMap.get(row.projectId) ?? "",
		tags: tagMap.get(row.id) ?? [],
	}));
}

export async function getTask(db: AppDatabase, userId: string, id: string) {
	const rows = await db
		.select()
		.from(tasks)
		.where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
		.limit(1);
	const task = rows[0];
	if (!task) throw notFound("任务");
	const [view] = await hydrate(db, userId, [task]);
	return view;
}


async function resolveParentId(
	db: AppDatabase,
	userId: string,
	taskId: string | null,
	parentId: string | null,
) {
	if (parentId === null) return null;
	if (taskId && parentId === taskId) {
		throw badRequest("任务不能把自身设为父任务", "parent_cycle");
	}
	const parent = await getTask(db, userId, parentId);
	if (taskId) {
		const rows = await db
			.select({ id: tasks.id, parentId: tasks.parentId })
			.from(tasks)
			.where(and(eq(tasks.userId, userId), isNull(tasks.deletedAt)));
		const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
		if (
			createsParentCycle(taskId, parentId, (id) => parentOf.get(id) ?? null)
		) {
			throw badRequest("不能形成父子循环", "parent_cycle");
		}
	}
	return parent.id;
}

export async function createTask(
	db: AppDatabase,
	userId: string,
	input: CreateTaskInput,
	source: TaskSource,
) {
	if (input.idempotencyKey) {
		const existing = await db
			.select()
			.from(tasks)
			.where(
				and(eq(tasks.userId, userId), eq(tasks.idempotencyKey, input.idempotencyKey)),
			)
			.limit(1);
		if (existing[0]) {
			const [view] = await hydrate(db, userId, existing);
			return view;
		}
	}

	const project = input.projectId
		? await getProject(db, userId, input.projectId)
		: await getInbox(db, userId);

	const now = nowIso();
	const status = input.status ?? "inbox";
	const row = {
		id: newId(),
		userId,
		projectId: project.id,
		title: input.title,
		notes: input.notes ?? null,
		status,
		priority: input.priority ?? "none",
		dueAt: input.dueAt ?? null,
		startAt: input.startAt ?? null,
		completedAt: status === "completed" ? now : null,
		parentId: await resolveParentId(db, userId, null, input.parentId ?? null),
		waitingOn: input.waitingOn ?? null,
		source,
		idempotencyKey: input.idempotencyKey ?? null,
		createdAt: now,
		updatedAt: now,
		deletedAt: null,
	};
	await db.insert(tasks).values(row);
	if (input.tagIds) {
		await replaceTaskTags(db, userId, row.id, input.tagIds);
	}
	await logActivity(db, {
		userId,
		source,
		action: "task.create",
		entityType: "task",
		entityId: row.id,
		summary: `创建任务「${row.title}」`,
	});
	return getTask(db, userId, row.id);
}

export async function updateTask(
	db: AppDatabase,
	userId: string,
	id: string,
	input: UpdateTaskInput,
	source: TaskSource,
) {
	const current = await getTask(db, userId, id);
	if (input.projectId) {
		await getProject(db, userId, input.projectId);
	}
	const now = nowIso();
	const nextStatus = input.status ?? current.status;
	const patch: Partial<TaskRow> = { updatedAt: now };
	if (input.title !== undefined) patch.title = input.title;
	if (input.notes !== undefined) patch.notes = input.notes;
	if (input.projectId !== undefined) patch.projectId = input.projectId;
	if (input.status !== undefined) patch.status = input.status;
	if (input.priority !== undefined) patch.priority = input.priority;
	if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
	if (input.startAt !== undefined) patch.startAt = input.startAt;
	if (input.waitingOn !== undefined) patch.waitingOn = input.waitingOn;
	if (input.parentId !== undefined) {
		patch.parentId = await resolveParentId(db, userId, id, input.parentId);
	}
	if (nextStatus === "completed" && current.status !== "completed") {
		patch.completedAt = now;
	}
	if (nextStatus !== "completed") {
		patch.completedAt = null;
	}
	await db
		.update(tasks)
		.set(patch)
		.where(and(eq(tasks.id, id), eq(tasks.userId, userId)));
	if (input.tagIds) {
		await replaceTaskTags(db, userId, id, input.tagIds);
	}
	await logActivity(db, {
		userId,
		source,
		action: "task.update",
		entityType: "task",
		entityId: id,
		summary: `更新任务「${input.title ?? current.title}」`,
	});
	return getTask(db, userId, id);
}

export async function completeTask(
	db: AppDatabase,
	userId: string,
	id: string,
	source: TaskSource,
) {
	const current = await getTask(db, userId, id);
	// Completing a parent must never auto-complete children. Unfinished
	// children are promoted to top-level (parent_id cleared); completed
	// children stay under the parent. Web + MCP both call this path.
	if (current.status !== "completed") {
		const now = nowIso();
		await db
			.update(tasks)
			.set({ parentId: null, updatedAt: now })
			.where(
				and(
					eq(tasks.userId, userId),
					eq(tasks.parentId, id),
					isNull(tasks.deletedAt),
					sql`${tasks.status} != 'completed'`,
				),
			);
	}
	return updateTask(db, userId, id, { status: "completed" }, source);
}

export async function deleteTask(
	db: AppDatabase,
	userId: string,
	id: string,
	source: TaskSource,
) {
	const current = await getTask(db, userId, id);
	const now = nowIso();
	await db
		.update(tasks)
		.set({ deletedAt: now, updatedAt: now })
		.where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)));
	await logActivity(db, {
		userId,
		source,
		action: "task.delete",
		entityType: "task",
		entityId: id,
		summary: `删除任务「${current.title}」`,
	});
	return { ok: true as const };
}

export async function listTasks(
	db: AppDatabase,
	userId: string,
	query: ListTasksQuery,
) {
	const limit = query.limit ?? DEFAULT_PAGE_SIZE;
	const tz = query.tz || DEFAULT_TIME_ZONE;
	const today = ymdInZone(new Date(), tz);
	const filters = [eq(tasks.userId, userId), isNull(tasks.deletedAt)];

	if (query.projectId) filters.push(eq(tasks.projectId, query.projectId));
	if (query.status) filters.push(eq(tasks.status, query.status));
	if (query.priority) filters.push(eq(tasks.priority, query.priority));
	if (query.includeCompleted !== "true" && !query.status) {
		filters.push(sql`${tasks.status} not in ('completed', 'cancelled')`);
	}
	if (query.q) {
		const term = sanitizeSearchQuery(query.q);
		if (term) {
			const needle = `%${term}%`;
			// D1 LIKE/GLOB patterns are capped at 50 UTF-8 bytes (`%` + term + `%`).
			filters.push(or(like(tasks.title, needle), like(tasks.notes, needle))!);
		}
	}
	if (query.due === "overdue") {
		filters.push(sql`${tasks.dueAt} is not null and ${tasks.dueAt} < ${today}`);
	} else if (query.due === "today") {
		filters.push(eq(tasks.dueAt, today));
	} else if (query.due === "upcoming") {
		filters.push(sql`${tasks.dueAt} is not null and ${tasks.dueAt} > ${today}`);
	} else if (query.due === "none") {
		filters.push(isNull(tasks.dueAt));
	}

	if (query.tagId) {
		filters.push(
			exists(
				db
					.select({ _: sql`1` })
					.from(taskTags)
					.where(
						and(
							eq(taskTags.taskId, tasks.id),
							eq(taskTags.tagId, query.tagId),
						),
					),
			),
		);
	}

	if (query.cursor) {
		const cursor = decodeCursor(query.cursor);
		if (!cursor) throw badRequest("无效的分页游标", "invalid_cursor");
		filters.push(
			or(
				lt(tasks.createdAt, cursor.createdAt),
				and(eq(tasks.createdAt, cursor.createdAt), lt(tasks.id, cursor.id)),
			)!,
		);
	}

	const rows = await db
		.select()
		.from(tasks)
		.where(and(...filters))
		.orderBy(desc(tasks.createdAt), desc(tasks.id))
		.limit(limit + 1);

	const page = rows.slice(0, limit);
	const next =
		rows.length > limit
			? encodeCursor({
					createdAt: page[page.length - 1]!.createdAt,
					id: page[page.length - 1]!.id,
				})
			: null;
	return {
		items: await hydrate(db, userId, page),
		nextCursor: next,
	};
}


/** Clarify an inbox task into next / waiting / someday / discard (cancelled). */
export async function processInboxTask(
	db: AppDatabase,
	userId: string,
	id: string,
	input: ProcessInboxInput,
	source: TaskSource,
) {
	const current = await getTask(db, userId, id);
	if (current.status !== "inbox") {
		throw badRequest("只能处理收件箱中的任务", "not_inbox");
	}

	const patch: UpdateTaskInput = {};
	if (input.projectId !== undefined) {
		patch.projectId = input.projectId;
	}

	switch (input.action) {
		case "next":
			patch.status = "next";
			patch.waitingOn = null;
			break;
		case "waiting": {
			const who = input.waitingOn?.trim();
			if (!who) {
				throw badRequest("等待中的任务需要填写在等谁", "waiting_on_required");
			}
			patch.status = "waiting";
			patch.waitingOn = who;
			break;
		}
		case "someday":
			patch.status = "someday";
			patch.waitingOn = null;
			break;
		case "discard":
			patch.status = "cancelled";
			break;
		default: {
			const _exhaustive: never = input.action;
			throw badRequest(`未知动作: ${_exhaustive}`, "invalid_action");
		}
	}

	const task = await updateTask(db, userId, id, patch, source);
	await logActivity(db, {
		userId,
		source,
		action: "task.process_inbox",
		entityType: "task",
		entityId: id,
		summary: `处理收件箱「${current.title}」→ ${input.action}`,
	});
	return task;
}

/** Idempotent weekly-review 「要催」: create a next-action follow-up for a waiting task. */
export async function nudgeWaiting(
	db: AppDatabase,
	userId: string,
	waitingTaskId: string,
	source: TaskSource,
) {
	const waiting = await getTask(db, userId, waitingTaskId);
	if (waiting.status !== "waiting") {
		throw badRequest("只能对等待中的任务催促", "not_waiting");
	}

	const idempotencyKey = `nudge-waiting:${waiting.id}`;
	const existingRows = await db
		.select()
		.from(tasks)
		.where(and(eq(tasks.userId, userId), eq(tasks.idempotencyKey, idempotencyKey)))
		.limit(1);
	const existing = existingRows[0];
	if (existing) {
		const open =
			!existing.deletedAt &&
			existing.status !== "completed" &&
			existing.status !== "cancelled";
		if (open) {
			const [view] = await hydrate(db, userId, [existing]);
			return view;
		}
		// Free the key so a new nudge can be created after the previous one finished.
		await db
			.update(tasks)
			.set({ idempotencyKey: null })
			.where(and(eq(tasks.id, existing.id), eq(tasks.userId, userId)));
	}

	const who = waiting.waitingOn?.trim() || "未填写";
	const title = `催 ${who}`;
	const task = await createTask(
		db,
		userId,
		{
			title,
			status: "next",
			projectId: waiting.projectId,
			parentId: waiting.id,
			notes: `催促自等待任务 ${waiting.id}`,
			idempotencyKey,
		},
		source,
	);
	await logActivity(db, {
		userId,
		source,
		action: "task.nudge",
		entityType: "task",
		entityId: waiting.id,
		summary: `要催「${waiting.title}」→ 下一步「${title}」（${task.id}）`,
	});
	return task;
}

export async function todayFocus(
	db: AppDatabase,
	userId: string,
	timeZone = DEFAULT_TIME_ZONE,
) {
	const today = ymdInZone(new Date(), timeZone);
	// Match isFocusTask: overdue / due today / status=next / priority=p1
	const focusPredicate = or(
		sql`${tasks.dueAt} is not null and substr(${tasks.dueAt}, 1, 10) < ${today}`,
		sql`${tasks.dueAt} is not null and substr(${tasks.dueAt}, 1, 10) = ${today}`,
		eq(tasks.status, "next"),
		eq(tasks.priority, "p1"),
	)!;
	// P1 > P2 > P3 > none (text DESC would put p3 first)
	const priorityRank = sql`case ${tasks.priority}
		when 'p1' then 1
		when 'p2' then 2
		when 'p3' then 3
		else 4
	end`;
	const focusRank = sql`case
		when ${tasks.dueAt} is not null and substr(${tasks.dueAt}, 1, 10) < ${today} then 0
		when ${tasks.dueAt} is not null and substr(${tasks.dueAt}, 1, 10) = ${today} then 1
		when ${tasks.status} = 'next' then 2
		else 3
	end`;
	const rows = await db
		.select()
		.from(tasks)
		.where(
			and(
				eq(tasks.userId, userId),
				isNull(tasks.deletedAt),
				sql`${tasks.status} not in ('completed', 'cancelled')`,
				focusPredicate,
			),
		)
		.orderBy(priorityRank, focusRank, desc(tasks.dueAt), desc(tasks.createdAt))
		.limit(100);
	return {
		today,
		timeZone,
		items: await hydrate(db, userId, rows),
	};
}

export async function searchTasks(
	db: AppDatabase,
	userId: string,
	q: string,
	timeZone?: string,
) {
	return listTasks(db, userId, {
		q,
		includeCompleted: "true",
		limit: 30,
		tz: timeZone,
	});
}

const DELETED_PAGE_SIZE = 100;
const PURGE_TASK_BATCH = 100;

export function softDeleteCutoffIso(now = new Date()) {
	return new Date(
		now.getTime() - SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
	).toISOString();
}

async function getTaskRow(
	db: AppDatabase,
	userId: string,
	id: string,
	opts: { includeDeleted?: boolean } = {},
) {
	const filters = [eq(tasks.id, id), eq(tasks.userId, userId)];
	if (!opts.includeDeleted) filters.push(isNull(tasks.deletedAt));
	const rows = await db
		.select()
		.from(tasks)
		.where(and(...filters))
		.limit(1);
	return rows[0] ?? null;
}

/** Settings recycle bin: current user's soft-deleted tasks only (no full-table scan). */
export async function listDeletedTasks(db: AppDatabase, userId: string) {
	const rows = await db
		.select()
		.from(tasks)
		.where(and(eq(tasks.userId, userId), isNotNull(tasks.deletedAt)))
		.orderBy(desc(tasks.deletedAt), desc(tasks.id))
		.limit(DELETED_PAGE_SIZE);
	return {
		items: await hydrate(db, userId, rows),
	};
}

export async function restoreTask(
	db: AppDatabase,
	userId: string,
	id: string,
	source: TaskSource,
) {
	const current = await getTaskRow(db, userId, id, { includeDeleted: true });
	if (!current) throw notFound("任务");
	if (!current.deletedAt) {
		const [view] = await hydrate(db, userId, [current]);
		return view;
	}
	const now = nowIso();
	await db
		.update(tasks)
		.set({ deletedAt: null, updatedAt: now })
		.where(and(eq(tasks.id, id), eq(tasks.userId, userId)));
	await logActivity(db, {
		userId,
		source,
		action: "task.restore",
		entityType: "task",
		entityId: id,
		summary: `恢复任务「${current.title}」`,
	});
	return getTask(db, userId, id);
}

export type PurgeExpiredDeletedResult = {
	users: number;
	tasks: number;
	activities: number;
	relations: number;
};

/** Cron only: hard-delete soft-deleted tasks older than 30 days, one user_id at a time. */
export async function purgeExpiredDeleted(
	db: AppDatabase,
	now = new Date(),
): Promise<PurgeExpiredDeletedResult> {
	const cutoff = softDeleteCutoffIso(now);
	const users = await db.select({ id: user.id }).from(user);
	const summary: PurgeExpiredDeletedResult = {
		users: 0,
		tasks: 0,
		activities: 0,
		relations: 0,
	};
	for (const row of users) {
		const result = await purgeExpiredDeletedForUser(db, row.id, cutoff);
		if (result.tasks === 0) continue;
		summary.users += 1;
		summary.tasks += result.tasks;
		summary.activities += result.activities;
		summary.relations += result.relations;
	}
	return summary;
}

export async function purgeExpiredDeletedForUser(
	db: AppDatabase,
	userId: string,
	cutoff: string,
) {
	let tasksDeleted = 0;
	let activitiesDeleted = 0;
	let relationsDeleted = 0;
	for (;;) {
		const rows = await db
			.select({ id: tasks.id })
			.from(tasks)
			.where(
				and(
					eq(tasks.userId, userId),
					isNotNull(tasks.deletedAt),
					lt(tasks.deletedAt, cutoff),
				),
			)
			.limit(PURGE_TASK_BATCH);
		if (rows.length === 0) break;
		const ids = rows.map((row) => row.id);

		// Tasks first, then leftover relations / activities (never a request-path scan).
		await db
			.delete(tasks)
			.where(and(eq(tasks.userId, userId), inArray(tasks.id, ids)));
		tasksDeleted += ids.length;

		const tagRows = await db
			.select({ taskId: taskTags.taskId })
			.from(taskTags)
			.where(inArray(taskTags.taskId, ids));
		if (tagRows.length > 0) {
			await db.delete(taskTags).where(inArray(taskTags.taskId, ids));
			relationsDeleted += tagRows.length;
		}

		const childRows = await db
			.select({ id: tasks.id })
			.from(tasks)
			.where(and(eq(tasks.userId, userId), inArray(tasks.parentId, ids)));
		if (childRows.length > 0) {
			await db
				.update(tasks)
				.set({ parentId: null })
				.where(and(eq(tasks.userId, userId), inArray(tasks.parentId, ids)));
			relationsDeleted += childRows.length;
		}

		const activityRows = await db
			.select({ id: activityLog.id })
			.from(activityLog)
			.where(
				and(
					eq(activityLog.userId, userId),
					eq(activityLog.entityType, "task"),
					inArray(activityLog.entityId, ids),
				),
			);
		if (activityRows.length > 0) {
			await db.delete(activityLog).where(
				and(
					eq(activityLog.userId, userId),
					eq(activityLog.entityType, "task"),
					inArray(activityLog.entityId, ids),
				),
			);
			activitiesDeleted += activityRows.length;
		}
	}
	return {
		tasks: tasksDeleted,
		activities: activitiesDeleted,
		relations: relationsDeleted,
	};
}
