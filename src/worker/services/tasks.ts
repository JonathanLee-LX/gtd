import { and, desc, eq, exists, inArray, isNotNull, isNull, like, lt, or, sql } from "drizzle-orm";
import { activityLog, projects, tags, taskTags, tasks, user } from "../../db/schema";
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
import { latestTaskActivityQuery, logActivity, taskUpdateActivityWrite } from "./activity";
import { getInbox } from "./ensure-inbox";
import { getProject } from "./projects";
import { replaceTaskTags, tagsForTasks } from "./tags";
import { chunks, D1_MAX_BOUND_PARAMS, runBatch } from "../lib/batch";

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
	// D1 每条语句最多 100 个绑定参数：userId 占 1 个，IN (...) 每块最多 99 个，同一个 batch。
	const projectQueries = chunks(projectIds, D1_MAX_BOUND_PARAMS - 1).map((part) =>
		db
			.select({ id: projects.id, name: projects.name })
			.from(projects)
			.where(and(eq(projects.userId, userId), inArray(projects.id, part))),
	);
	const projectRows = (
		await runBatch(db, projectQueries as [(typeof projectQueries)[number], ...typeof projectQueries])
	).flat();
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

/** #119：任务行 + 项目名（子查询，一条语句）。 */
function taskWithProjectQuery(db: AppDatabase, userId: string, id: string) {
	return db
		.select({
			task: tasks,
			projectName: sql<string | null>`(select ${projects.name} from ${projects} where ${projects.id} = ${tasks.projectId} and ${projects.userId} = ${userId})`,
		})
		.from(tasks)
		.where(and(eq(tasks.id, id), eq(tasks.userId, userId), isNull(tasks.deletedAt)))
		.limit(1);
}

/** #119：一条任务的标签（只读这条任务的 task_tags，不扫全表）。 */
function taskTagsQuery(db: AppDatabase, userId: string, id: string) {
	return db
		.select({ id: tags.id, name: tags.name })
		.from(taskTags)
		.innerJoin(tags, eq(taskTags.tagId, tags.id))
		.where(and(eq(taskTags.taskId, id), eq(tags.userId, userId)));
}

/** GET /api/tasks/:id：任务 + 项目名 + 标签，一次 D1 往返（之前 3 次）。 */
export async function getTask(db: AppDatabase, userId: string, id: string): Promise<TaskView> {
	const [rows, tagRows] = await runBatch(db, [
		taskWithProjectQuery(db, userId, id),
		taskTagsQuery(db, userId, id),
	] as const);
	const row = rows[0];
	if (!row) throw notFound("任务");
	return { ...row.task, projectName: row.projectName ?? "", tags: tagRows };
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

/**
 * PATCH /api/tasks/:id（网页和 MCP 同一路径）。#119：D1 往返压到 2 次（改父任务时另加校验读）。
 *  1) 一个只读 batch：当前任务 + 项目名、标签、这条任务最新一条活动（合并判断必须在写之前读），
 *     按需加上目标项目、本人的标签。
 *  2) 一个写 batch（原子）：UPDATE … RETURNING、（换标签时）删 / 插 task_tags、活动合并或新插。
 *     返回值直接用 RETURNING 的行拼出来，不再回读。
 */
export async function updateTask(
	db: AppDatabase,
	userId: string,
	id: string,
	input: UpdateTaskInput,
	source: TaskSource,
): Promise<TaskView> {
	const wantTags = input.tagIds !== undefined && input.tagIds.length > 0;
	const [currentRows, currentTags, latestActivity, projectRows, ownedTags] = await runBatch(db, [
		taskWithProjectQuery(db, userId, id),
		taskTagsQuery(db, userId, id),
		latestTaskActivityQuery(db, userId, id),
		input.projectId
			? db
					.select({ id: projects.id, name: projects.name })
					.from(projects)
					.where(and(eq(projects.id, input.projectId), eq(projects.userId, userId)))
					.limit(1)
			: db.select({ id: projects.id, name: projects.name }).from(projects).where(sql`0`),
		wantTags
			? db.select({ id: tags.id, name: tags.name }).from(tags).where(eq(tags.userId, userId))
			: db.select({ id: tags.id, name: tags.name }).from(tags).where(sql`0`),
	] as const);
	const currentRow = currentRows[0];
	if (!currentRow) throw notFound("任务");
	const current = currentRow.task;
	if (input.projectId && !projectRows[0]) throw notFound("项目");

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

	// 标签：只保留本人的（同 replaceTaskTags），顺序按传入顺序。
	let nextTags = currentTags;
	const tagWrites = [];
	if (input.tagIds !== undefined) {
		const owned = new Map<string, string>(ownedTags.map((tag: { id: string; name: string }) => [tag.id, tag.name]));
		const filtered = input.tagIds.filter((tagId) => owned.has(tagId));
		nextTags = filtered.map((tagId) => ({ id: tagId, name: owned.get(tagId)! }));
		tagWrites.push(db.delete(taskTags).where(eq(taskTags.taskId, id)));
		// D1 每条语句最多 100 个绑定参数，每行 2 个：每条 INSERT 最多 49 行，都在同一个写 batch 里。
		for (const part of chunks(filtered, 49)) {
			tagWrites.push(db.insert(taskTags).values(part.map((tagId) => ({ taskId: id, tagId }))));
		}
	}

	// #115：只改内容字段的连续编辑合并成一条活动；状态 / 项目 / 父任务真的变了就另起一条。
	const structural =
		(patch.status !== undefined && patch.status !== current.status) ||
		(patch.projectId !== undefined && patch.projectId !== current.projectId) ||
		(patch.parentId !== undefined && patch.parentId !== current.parentId);
	const activity = taskUpdateActivityWrite(
		db,
		{
			userId,
			source,
			taskId: id,
			summary: `更新任务「${input.title ?? current.title}」`,
			coalescible: !structural,
		},
		latestActivity[0],
		now,
	);
	const [updatedRows] = await runBatch(db, [
		db
			.update(tasks)
			.set(patch)
			.where(and(eq(tasks.id, id), eq(tasks.userId, userId)))
			.returning(),
		...tagWrites,
		activity.query,
	] as const);
	const updated = updatedRows[0];
	if (!updated) throw notFound("任务");
	return {
		...updated,
		projectName: input.projectId ? projectRows[0]!.name : (currentRow.projectName ?? ""),
		tags: nextTags,
	};
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

function priorityRankSql() {
	// P1 > P2 > P3 > none (text DESC would put p3 first)
	return sql`case ${tasks.priority}
		when 'p1' then 1
		when 'p2' then 2
		when 'p3' then 3
		else 4
	end`;
}

function focusRankSql(today: string) {
	return sql`case
		when ${tasks.dueAt} is not null and substr(${tasks.dueAt}, 1, 10) < ${today} then 0
		when ${tasks.dueAt} is not null and substr(${tasks.dueAt}, 1, 10) = ${today} then 1
		when ${tasks.status} = 'next' then 2
		else 3
	end`;
}

/** 未删除、未完成/未取消、且没有未完成子任务。今日焦点和到期提醒共用（#66）。 */
function actionableTaskFilters(userId: string) {
	return [
		eq(tasks.userId, userId),
		isNull(tasks.deletedAt),
		sql`${tasks.status} not in ('completed', 'cancelled')`,
		// 只出叶子：有未完成子任务的父任务不进今日（#66）。
		sql`not exists (
			select 1 from tasks as child
			where child.parent_id = ${tasks.id}
				and child.user_id = ${userId}
				and child.deleted_at is null
				and child.status not in ('completed', 'cancelled')
		)`,
	];
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
	const rows = await db
		.select()
		.from(tasks)
		.where(and(...actionableTaskFilters(userId), focusPredicate))
		.orderBy(priorityRankSql(), focusRankSql(today), desc(tasks.dueAt), desc(tasks.createdAt))
		.limit(100);
	return {
		today,
		timeZone,
		items: await hydrate(db, userId, rows),
	};
}

/**
 * #123 到期提醒和「今日」同一套叶子 / 状态 / 日期比较。
 * includeOverdue 时 due_at 的日期 <= day，否则只等于 day。不套今日页的 100 行上限，正文才能算「还有 K 条」。
 * 排序与 todayFocus 相同，所以前几条标题和今日列表里到期任务的顺序一致。
 */
export function digestTasksQuery(
	db: AppDatabase,
	userId: string,
	day: string,
	includeOverdue: boolean,
) {
	const duePredicate = includeOverdue
		? sql`${tasks.dueAt} is not null and substr(${tasks.dueAt}, 1, 10) <= ${day}`
		: sql`${tasks.dueAt} is not null and substr(${tasks.dueAt}, 1, 10) = ${day}`;
	return db
		.select({ title: tasks.title, dueAt: tasks.dueAt })
		.from(tasks)
		.where(and(...actionableTaskFilters(userId), duePredicate))
		.orderBy(priorityRankSql(), focusRankSql(day), desc(tasks.dueAt), desc(tasks.createdAt));
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
