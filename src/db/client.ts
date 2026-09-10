import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { schema } from "./schema";

export type AppDatabase = DrizzleD1Database<typeof schema>;

export function createDb(d1: D1Database): AppDatabase {
	const sessionCapable = d1 as D1Database & {
		withSession?: (constraint: string) => D1Database;
	};
	const bound =
		typeof sessionCapable.withSession === "function"
			? sessionCapable.withSession("first-primary")
			: d1;
	return drizzle(bound as D1Database, { schema });
}
