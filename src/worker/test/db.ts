import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema, user } from "../../db/schema";
import { newId, nowIso } from "../lib/ids";
import { ensureInbox } from "../services/ensure-inbox";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const sql = readFileSync(join(root, "drizzle/0001_init.sql"), "utf8");

export function createTestDb() {
	const sqlite = new Database(":memory:");
	sqlite.exec(sql);
	const db = drizzle(sqlite, { schema });
	return { sqlite, db };
}

export async function seedUser(
	db: ReturnType<typeof createTestDb>["db"],
	email = "me@example.com",
) {
	const id = newId();
	const now = Date.now();
	await db.insert(user).values({
		id,
		name: "Test",
		email,
		emailVerified: true,
		image: null,
		createdAt: new Date(now),
		updatedAt: new Date(now),
	});
	await ensureInbox(db as never, id);
	return { id, email, now: nowIso() };
}
