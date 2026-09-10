import { relations, sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
	type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" })
		.default(false)
		.notNull(),
	image: text("image"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
});

export const session = sqliteTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		token: text("token").notNull().unique(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = sqliteTable(
	"account",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: integer("access_token_expires_at", {
			mode: "timestamp_ms",
		}),
		refreshTokenExpiresAt: integer("refresh_token_expires_at", {
			mode: "timestamp_ms",
		}),
		scope: text("scope"),
		password: text("password"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable("verification", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).default(
		sql`(cast(unixepoch('subsecond') * 1000 as integer))`,
	),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.$onUpdate(() => /* @__PURE__ */ new Date()),
});

export const projects = sqliteTable(
	"projects",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		color: text("color"),
		isInbox: integer("is_inbox", { mode: "boolean" }).default(false).notNull(),
		archivedAt: text("archived_at"),
		sortOrder: integer("sort_order").default(0).notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("projects_user_id_idx").on(table.userId),
		uniqueIndex("projects_one_inbox")
			.on(table.userId)
			.where(sql`${table.isInbox} = 1`),
	],
);

export const tasks = sqliteTable(
	"tasks",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		notes: text("notes"),
		status: text("status").default("inbox").notNull(),
		priority: text("priority").default("none").notNull(),
		dueAt: text("due_at"),
		startAt: text("start_at"),
		completedAt: text("completed_at"),
		parentId: text("parent_id").references((): AnySQLiteColumn => tasks.id, {
			onDelete: "set null",
		}),
		waitingOn: text("waiting_on"),
		source: text("source").default("human").notNull(),
		idempotencyKey: text("idempotency_key"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		deletedAt: text("deleted_at"),
	},
	(table) => [
		index("tasks_user_status_idx").on(table.userId, table.status),
		index("tasks_user_due_idx").on(table.userId, table.dueAt),
		index("tasks_user_project_idx").on(table.userId, table.projectId),
		uniqueIndex("tasks_user_idempotency_idx")
			.on(table.userId, table.idempotencyKey)
			.where(sql`${table.idempotencyKey} IS NOT NULL`),
	],
);

export const tags = sqliteTable(
	"tags",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [uniqueIndex("tags_user_name_idx").on(table.userId, table.name)],
);

export const taskTags = sqliteTable(
	"task_tags",
	{
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		tagId: text("tag_id")
			.notNull()
			.references(() => tags.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.taskId, table.tagId] })],
);

export const apiTokens = sqliteTable(
	"api_tokens",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		prefix: text("prefix").notNull(),
		lastUsedAt: text("last_used_at"),
		createdAt: text("created_at").notNull(),
		revokedAt: text("revoked_at"),
	},
	(table) => [index("api_tokens_user_id_idx").on(table.userId)],
);

export const activityLog = sqliteTable(
	"activity_log",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		actorType: text("actor_type").notNull(),
		actorId: text("actor_id"),
		action: text("action").notNull(),
		entityType: text("entity_type").notNull(),
		entityId: text("entity_id"),
		summary: text("summary").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [index("activity_user_created_idx").on(table.userId, table.createdAt)],
);

export const userRelations = relations(user, ({ many }) => ({
	sessions: many(session),
	projects: many(projects),
	tasks: many(tasks),
}));

export const projectRelations = relations(projects, ({ one, many }) => ({
	user: one(user, { fields: [projects.userId], references: [user.id] }),
	tasks: many(tasks),
}));

export const taskRelations = relations(tasks, ({ one, many }) => ({
	user: one(user, { fields: [tasks.userId], references: [user.id] }),
	project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
	tagLinks: many(taskTags),
}));

export const schema = {
	user,
	session,
	account,
	verification,
	projects,
	tasks,
	tags,
	taskTags,
	apiTokens,
	activityLog,
};
