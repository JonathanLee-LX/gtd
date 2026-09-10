import { and, desc, eq, exists, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { projects, taskTags, tasks } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import { DEFAULT_PAGE_SIZE, DEFAULT_TIME_ZONE } from "../../shared/constants";
import { decodeCursor, encodeCursor } from "../../shared/cursor";
import type {
	CreateTaskInput,
	ListTasksQuery,
	TaskSource,
	UpdateTaskInput,
} from "../../shared/schemas";
import { sanitizeSearchQuery } from "../../shared/search";
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
		parentId: input.parentId ?? null,
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
	if (input.parentId !== undefined) patch.parentId = input.parentId;
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
