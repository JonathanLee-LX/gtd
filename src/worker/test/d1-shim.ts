import { drizzle } from "drizzle-orm/d1";
import type BetterSqlite3 from "better-sqlite3";
import { schema } from "../../db/schema";
import type { AppDatabase } from "../../db/client";

/**
 * #119：把 better-sqlite3 包成最小 D1Database，让测试走 drizzle-orm/d1 的真实路径（含 db.batch()），
 * 并数「往返次数」：每次单条执行（all / raw / run / first）算 1 次，一次 batch() 也只算 1 次。
 */
export function createCountingD1(sqlite: BetterSqlite3.Database) {
	const counter = { roundTrips: 0, statements: 0 };
	type Bound = { sql: string; params: unknown[] };
	const exec = (b: Bound) => {
		counter.statements++;
		const stmt = sqlite.prepare(b.sql);
		const params = b.params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
		if (stmt.reader) return { results: stmt.all(...params) as Record<string, unknown>[], success: true, meta: {} };
		const info = stmt.run(...params);
		return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
	};
	const rawOf = (b: Bound) => {
		counter.statements++;
		const stmt = sqlite.prepare(b.sql);
		const params = b.params.map((p) => (typeof p === "boolean" ? (p ? 1 : 0) : p));
		if (!stmt.reader) {
			stmt.run(...params);
			return [];
		}
		return stmt.raw(true).all(...params) as unknown[][];
	};
	const statement = (sql: string, params: unknown[] = []) => ({
		__bound: { sql, params } as Bound,
		bind: (...p: unknown[]) => statement(sql, p),
		async all() {
			counter.roundTrips++;
			return exec({ sql, params });
		},
		async run() {
			counter.roundTrips++;
			return exec({ sql, params });
		},
		async raw() {
			counter.roundTrips++;
			return rawOf({ sql, params });
		},
		async first() {
			counter.roundTrips++;
			return exec({ sql, params }).results[0] ?? null;
		},
	});
	const d1 = {
		prepare: (sql: string) => statement(sql),
		async batch(stmts: { __bound: Bound }[]) {
			counter.roundTrips++;
			// D1 的 batch 是一个隐式事务：全部成功或全部回滚。
			return sqlite.transaction(() => stmts.map((s) => exec(s.__bound)))();
		},
	};
	const db = drizzle(d1 as unknown as D1Database, { schema }) as AppDatabase;
	return {
		db,
		counter,
		reset() {
			counter.roundTrips = 0;
			counter.statements = 0;
		},
	};
}
