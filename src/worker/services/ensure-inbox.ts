import { and, eq } from "drizzle-orm";
import { projects } from "../../db/schema";
import { INBOX_NAME } from "../../shared/constants";
import type { AppDatabase } from "../../db/client";
import { newId, nowIso } from "../lib/ids";

export async function ensureInbox(db: AppDatabase, userId: string) {
	const existing = await db
		.select()
		.from(projects)
		.where(and(eq(projects.userId, userId), eq(projects.isInbox, true)))
		.limit(1);
	if (existing[0]) return existing[0];

	const now = nowIso();
	const row = {
		id: newId(),
		userId,
		name: INBOX_NAME,
		color: "#2f6f4e",
		isInbox: true,
		archivedAt: null,
		sortOrder: 0,
		createdAt: now,
		updatedAt: now,
	};
	await db.insert(projects).values(row);
	return row;
}

export async function getInbox(db: AppDatabase, userId: string) {
	return ensureInbox(db, userId);
}
