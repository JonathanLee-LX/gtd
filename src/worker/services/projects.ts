import { and, asc, eq } from "drizzle-orm";
import { projects } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import type { CreateProjectInput, TaskSource, UpdateProjectInput } from "../../shared/schemas";
import { badRequest, notFound } from "../lib/errors";
import { newId, nowIso } from "../lib/ids";
import { logActivity } from "./activity";
import { ensureInbox } from "./ensure-inbox";

export type ProjectRow = typeof projects.$inferSelect;

export async function listProjects(db: AppDatabase, userId: string) {
	await ensureInbox(db, userId);
	return db
		.select()
		.from(projects)
		.where(eq(projects.userId, userId))
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
		summary: `更新项目「${input.name ?? project.name}」`,
	});
	return getProject(db, userId, id);
}

export async function deleteProject(
	db: AppDatabase,
	userId: string,
	id: string,
	source: TaskSource,
) {
	const project = await getProject(db, userId, id);
	if (project.isInbox) throw badRequest("收件箱不能删除");
	await db.delete(projects).where(and(eq(projects.id, id), eq(projects.userId, userId)));
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
