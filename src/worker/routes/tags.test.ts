import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityLog } from "../../db/schema";
import { AppError } from "../lib/errors";
import { createCountingD1 } from "../test/d1-shim";
import { createTestDb, seedUser } from "../test/db";
import { tagRoutes } from "./tags";
import { createTag } from "../services/tags";
import { createTask, getTask } from "../services/tasks";
import { createToken } from "../services/tokens";

function createTagsTestApp(sqlite: ReturnType<typeof createTestDb>["sqlite"]) {
	const d1 = createCountingD1(sqlite);
	// createCountingD1 wraps a D1Database inside drizzle; extract a compatible D1 binding for Hono routes.
	const env = {
		DB: (d1.db as unknown as { $client: D1Database }).$client,
		BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
		BETTER_AUTH_URL: "https://gtd.livs.top",
	};
	const app = new Hono();
	app.onError((error, c) => {
		if (error instanceof AppError) {
			return c.json(
				{ error: error.code, message: error.message },
				error.status as ContentfulStatusCode,
			);
		}
		return c.json({ error: "internal", message: "服务器出错了" }, 500);
	});
	app.route("/api/tags", tagRoutes);
	return { app, env, db: d1.db };
}

describe("tag routes (#122)", () => {
	it("supports GET /api/tags (with taskCount) and DELETE /api/tags/:id with tenant isolation", async () => {
		const { db: plain, sqlite } = createTestDb();
		const userA = await seedUser(plain, "route-a@example.com");
		const userB = await seedUser(plain, "route-b@example.com");
		const { app, env, db } = createTagsTestApp(sqlite);

		const tokenA = await createToken(db, userA.id, "CLI-A");
		const tokenB = await createToken(db, userB.id, "CLI-B");

		const tagA = await createTag(db, userA.id, "qa119a", "human");
		const taskA = await createTask(db, userA.id, { title: "测试任务", tagIds: [tagA.id] }, "human");

		// Unauthenticated request rejected with 401
		const unauthRes = await app.request(`/api/tags/${tagA.id}`, { method: "DELETE" }, env);
		expect(unauthRes.status).toBe(401);

		// User A lists tags and sees taskCount = 1
		const listRes = await app.request(
			"/api/tags",
			{ headers: { Authorization: `Bearer ${tokenA.token}` } },
			env,
		);
		expect(listRes.status).toBe(200);
		const listed = (await listRes.json()) as { items: Array<{ id: string; name: string; taskCount: number }> };
		expect(listed.items).toEqual([
			expect.objectContaining({ id: tagA.id, name: "qa119a", taskCount: 1 }),
		]);

		// User B cannot delete User A's tag (404)
		const forbiddenRes = await app.request(
			`/api/tags/${tagA.id}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${tokenB.token}` },
			},
			env,
		);
		expect(forbiddenRes.status).toBe(404);

		// User A deletes their own tag via Bearer token (source = "mcp")
		const delRes = await app.request(
			`/api/tags/${tagA.id}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${tokenA.token}` },
			},
			env,
		);
		expect(delRes.status).toBe(200);
		expect(await delRes.json()).toEqual({ ok: true });

		// Tag gone from list & task
		const listAfter = await app.request(
			"/api/tags",
			{ headers: { Authorization: `Bearer ${tokenA.token}` } },
			env,
		);
		expect((await listAfter.json()) as { items: unknown[] }).toEqual({ items: [] });
		expect((await getTask(db, userA.id, taskA.id)).tags).toEqual([]);

		// Deleting again returns 404
		const delAgain = await app.request(
			`/api/tags/${tagA.id}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${tokenA.token}` },
			},
			env,
		);
		expect(delAgain.status).toBe(404);

		// Activity log recorded with source = "mcp"
		const logs = await db.select().from(activityLog).where(eq(activityLog.userId, userA.id));
		expect(logs.find((row) => row.action === "tag.delete")).toMatchObject({
			actorType: "mcp",
			entityType: "tag",
			entityId: tagA.id,
			summary: "删除标签「qa119a」",
		});
	});
});
