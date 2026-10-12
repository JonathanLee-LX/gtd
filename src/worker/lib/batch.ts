import { sql } from "drizzle-orm";
import type { AppDatabase } from "../../db/client";

/**
 * #119：把几条 drizzle 查询放进一次 D1 往返。D1 的 `db.batch` 是一个隐式事务（任一条失败整批回滚），
 * 结果按顺序返回。测试用的 better-sqlite3 没有 batch，退化成 BEGIN / COMMIT 里逐条执行（语义相同）。
 * 只能放 drizzle 查询构造器（惰性执行），不要放 `db.run(sql)`。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = PromiseLike<any>;
type Results<T extends readonly Query[]> = { -readonly [K in keyof T]: Awaited<T[K]> };

export async function runBatch<T extends readonly [Query, ...Query[]]>(
	db: AppDatabase,
	queries: T,
): Promise<Results<T>> {
	const batchable = db as unknown as { batch?: (items: readonly Query[]) => Promise<unknown[]> };
	if (typeof batchable.batch === "function") {
		return (await batchable.batch(queries)) as Results<T>;
	}
	await db.run(sql`begin`);
	try {
		const out: unknown[] = [];
		for (const query of queries) out.push(await query);
		await db.run(sql`commit`);
		return out as Results<T>;
	} catch (error) {
		await db.run(sql`rollback`);
		throw error;
	}
}
