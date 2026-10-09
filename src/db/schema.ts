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

export const passkey = sqliteTable(
	"passkey",
	{
		id: text("id").primaryKey(),
		name: text("name"),
		publicKey: text("public_key").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		credentialID: text("credential_id").notNull(),
		counter: integer("counter").notNull(),
		deviceType: text("device_type").notNull(),
		backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
		transports: text("transports"),
		createdAt: integer("created_at", { mode: "timestamp_ms" }),
		aaguid: text("aaguid"),
	},
	(table) => [
		index("passkey_user_id_idx").on(table.userId),
		index("passkey_credential_id_idx").on(table.credentialID),
	],
);

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
		index("tasks_user_deleted_idx").on(table.userId, table.deletedAt),
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

/**
 * #68 任务附件（从 gtd-attach-exp 迁移）：D1 只存元数据，二进制在 R2（绑定 UPLOADS）。
 * v1 只有 image / file(PDF) 两种 kind；`url` 列为将来的「链接附件」预留，v1 不写。
 * deleted_at 非空 = 已删除、等 R2 对象清理（删除时立即尝试删 R2，失败由 cron 兜底）。
 * 任务进回收站时附件行不动，靠「任务未删除」过滤隐藏；恢复任务即回来。
 */
export const attachments = sqliteTable(
	"attachments",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		kind: text("kind").default("file").notNull(),
		status: text("status").default("ready").notNull(),
		r2Key: text("r2_key"),
		filename: text("filename"),
		mime: text("mime"),
		size: integer("size"),
		url: text("url"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		deletedAt: text("deleted_at"),
	},
	(table) => [
		index("attachments_user_task_idx").on(table.userId, table.taskId),
		index("attachments_user_deleted_idx").on(table.userId, table.deletedAt),
		uniqueIndex("attachments_r2_key_unique").on(table.r2Key),
	],
);

/**
 * 两段式上传的中间态：request 建行（pending），confirm 校验 R2 后转成 attachments 行。
 * 一个 r2_key 只允许一条 upload 记录，confirm 幂等靠 attachment_id 回填。
 */
export const attachmentUploads = sqliteTable(
	"attachment_uploads",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		taskId: text("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		r2Key: text("r2_key").notNull(),
		kind: text("kind").default("file").notNull(),
		filename: text("filename").notNull(),
		mime: text("mime").notNull(),
		size: integer("size").notNull(),
		status: text("status").default("pending").notNull(),
		attachmentId: text("attachment_id").references(() => attachments.id, {
			onDelete: "set null",
		}),
		expiresAt: text("expires_at").notNull(),
		confirmedAt: text("confirmed_at"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("attachment_uploads_r2_key_unique").on(table.r2Key),
		index("attachment_uploads_user_status_idx").on(
			table.userId,
			table.status,
			table.expiresAt,
		),
		index("attachment_uploads_task_idx").on(table.taskId),
	],
);

/**
 * R2 待删清单（outbox）：附件行会随任务 / 项目被 FK cascade 删掉，删掉之后就再也找不到 r2_key。
 * 所以硬删前先把 key 记在这里，删成功再移除；没删掉的由每日 cron 重试。
 * 故意不加外键：用户 / 任务 / 项目没了，这条记录也得留着把 R2 对象清掉。
 * cron 删之前会确认没有活着的 attachments / attachment_uploads 行还引用这个 key。
 */
export const r2PendingDeletions = sqliteTable(
	"r2_pending_deletions",
	{
		r2Key: text("r2_key").primaryKey(),
		userId: text("user_id").notNull(),
		reason: text("reason").notNull(),
		attempts: integer("attempts").default(0).notNull(),
		lastError: text("last_error"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [index("r2_pending_deletions_created_idx").on(table.createdAt)],
);

export const userRelations = relations(user, ({ many }) => ({
	sessions: many(session),
	projects: many(projects),
	tasks: many(tasks),
	attachments: many(attachments),
}));

export const projectRelations = relations(projects, ({ one, many }) => ({
	user: one(user, { fields: [projects.userId], references: [user.id] }),
	tasks: many(tasks),
}));

export const taskRelations = relations(tasks, ({ one, many }) => ({
	user: one(user, { fields: [tasks.userId], references: [user.id] }),
	project: one(projects, { fields: [tasks.projectId], references: [projects.id] }),
	tagLinks: many(taskTags),
	attachments: many(attachments),
}));

export const attachmentRelations = relations(attachments, ({ one }) => ({
	user: one(user, { fields: [attachments.userId], references: [user.id] }),
	task: one(tasks, { fields: [attachments.taskId], references: [tasks.id] }),
}));

export const schema = {
	user,
	session,
	account,
	verification,
	passkey,
	projects,
	tasks,
	tags,
	taskTags,
	apiTokens,
	activityLog,
	attachments,
	attachmentUploads,
	r2PendingDeletions,
};
