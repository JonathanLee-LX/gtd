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

/** 条数不固定时用（定时任务按用户拼写入）。空列表直接返回。一次 batch 仍是 1 次往返。 */
export async function runQueries(db: AppDatabase, queries: Query[]): Promise<unknown[]> {
	if (queries.length === 0) return [];
	return runBatch(db, queries as unknown as [Query, ...Query[]]);
}

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

/** D1 每条语句最多 100 个绑定参数。 */
export const D1_MAX_BOUND_PARAMS = 100;

/** 把 IN (...) 的值切成每块不超过 `size` 个（size = 100 − 这条语句里其它参数的个数）。 */
export function chunks<T>(items: readonly T[], size: number): T[][] {
	if (size < 1) throw new Error("chunk size must be >= 1");
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
