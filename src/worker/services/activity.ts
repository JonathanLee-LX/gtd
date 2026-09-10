import { activityLog } from "../../db/schema";
import type { AppDatabase } from "../../db/client";
import type { TaskSource } from "../../shared/schemas";
import { newId, nowIso } from "../lib/ids";

export async function logActivity(
	db: AppDatabase,
	input: {
		userId: string;
		source: TaskSource;
		action: string;
		entityType: string;
		entityId?: string | null;
		summary: string;
	},
) {
	await db.insert(activityLog).values({
		id: newId(),
		userId: input.userId,
		actorType: input.source,
		actorId: input.userId,
		action: input.action,
		entityType: input.entityType,
		entityId: input.entityId ?? null,
		summary: input.summary,
		createdAt: nowIso(),
	});
}
