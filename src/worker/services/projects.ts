import { and, asc, eq, isNull } from "drizzle-orm";
import { projects } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import type { CreateProjectInput, TaskSource, UpdateProjectInput } from "../../shared/schemas";
import { badRequest, notFound } from "../lib/errors";
import { newId, nowIso } from "../lib/ids";
import { logActivity } from "./activity";
import { hardDeleteProjectWithAttachments, type AttachmentBucket } from "./attachments";
import { ensureInbox } from "./ensure-inbox";

export type ProjectRow = typeof projects.$inferSelect;

export type ListProjectsOptions = {
	/** 默认不含已归档。网页设置页传 true 才能列出并取消归档。 */
	includeArchived?: boolean;
};

export async function listProjects(
	db: AppDatabase,
	userId: string,
	options: ListProjectsOptions = {},
) {
	await ensureInbox(db, userId);
	const filters = [eq(projects.userId, userId)];
	if (!options.includeArchived) {
		filters.push(isNull(projects.archivedAt));
	}
	return db
		.select()
		.from(projects)
		.where(and(...filters))
		.orderBy(asc(projects.sortOrder), asc(projects.createdAt));
}

export async function getProject(db: AppDatabase, userId: string, id: string) {
	const rows = await db
		.select()
		.from(projects)
		.where(and(eq(projects.id, id), eq(projects.userId, userId)))
		.limit(1);
	const project = rows[0];
	if (!project) throw notFound("项目");
	return project;
}

export async function createProject(
	db: AppDatabase,
	userId: string,
	input: CreateProjectInput,
	source: TaskSource,
) {
	const now = nowIso();
	const row = {
		id: newId(),
		userId,
		name: input.name,
		color: input.color ?? null,
		isInbox: false,
		archivedAt: null,
		sortOrder: 100,
		createdAt: now,
		updatedAt: now,
	};
	await db.insert(projects).values(row);
	await logActivity(db, {
		userId,
		source,
		action: "project.create",
		entityType: "project",
		entityId: row.id,
		summary: `创建项目「${row.name}」`,
	});
	return row;
}

function projectUpdateSummary(project: ProjectRow, input: UpdateProjectInput) {
	if (input.archived === true) return `归档项目「${project.name}」`;
	if (input.archived === false) return `取消归档项目「${input.name ?? project.name}」`;
	return `更新项目「${input.name ?? project.name}」`;
}

export async function updateProject(
	db: AppDatabase,
	userId: string,
	id: string,
	input: UpdateProjectInput,
	source: TaskSource,
) {
	const project = await getProject(db, userId, id);
	if (project.isInbox && input.name) {
		throw badRequest("收件箱不能改名");
	}
	if (project.isInbox && input.archived) {
		throw badRequest("收件箱不能归档");
	}
	const now = nowIso();
	const patch: Partial<ProjectRow> = { updatedAt: now };
	if (input.name !== undefined) patch.name = input.name;
	if (input.color !== undefined) patch.color = input.color;
	if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
	if (input.archived === true) patch.archivedAt = now;
	if (input.archived === false) patch.archivedAt = null;
	await db
		.update(projects)
		.set(patch)
		.where(and(eq(projects.id, id), eq(projects.userId, userId)));
	await logActivity(db, {
		userId,
		source,
		action: "project.update",
		entityType: "project",
		entityId: id,
		summary: projectUpdateSummary(project, input),
	});
	return getProject(db, userId, id);
}

export async function deleteProject(
	db: AppDatabase,
	userId: string,
	id: string,
	source: TaskSource,
	/** #68：附件存储。删项目会硬删其下所有任务，附件的 R2 对象要一起清掉。 */
	bucket?: AttachmentBucket | null,
) {
	const project = await getProject(db, userId, id);
	if (project.isInbox) throw badRequest("收件箱不能删除");
	// 记 R2 待删清单 + 删附件行 + 删项目（cascade 任务）在同一个 D1 batch（事务）里；
	// 提交后再删 R2，删不掉的留在清单里由每日 cron 重试。见 hardDeleteProjectWithAttachments。
	const result = await hardDeleteProjectWithAttachments(db, bucket, userId, id);
	if (result.failed > 0) {
		console.error("project delete: r2 cleanup deferred to cron", id, result);
	}
	await logActivity(db, {
		userId,
		source,
		action: "project.delete",
		entityType: "project",
		entityId: id,
		summary: `删除项目「${project.name}」`,
	});
	return { ok: true as const };
}
