import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import {
	createTaskInput,
	listTasksQuery,
	todayFocusQuery,
	updateTaskInput,
} from "../../shared/schemas";
import type { WorkerEnv } from "../lib/auth";
import { handleRoute } from "../lib/route-utils";
import { requireUser, type AppVariables } from "../middleware/require-user";
import {
	completeTask,
	createTask,
	deleteTask,
	getTask,
	listTasks,
	nudgeWaiting,
	todayFocus,
	updateTask,
} from "../services/tasks";

export const taskRoutes = new Hono<{
	Bindings: WorkerEnv;
	Variables: AppVariables;
}>()
	.use("*", requireUser)
	.get("/", zValidator("query", listTasksQuery), (c) =>
		handleRoute(c, async () =>
			listTasks(createDb(c.env.DB), c.get("user").id, c.req.valid("query")),
		),
	)
	.get("/focus", zValidator("query", todayFocusQuery), (c) =>
		handleRoute(c, async () =>
			todayFocus(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.valid("query").tz,
			),
		),
	)
	.post("/", zValidator("json", createTaskInput), (c) =>
		handleRoute(
			c,
			async () => {
				const task = await createTask(
					createDb(c.env.DB),
					c.get("user").id,
					c.req.valid("json"),
					c.get("source"),
				);
				return { task };
			},
			201,
		),
	)
	.get("/:id", (c) =>
		handleRoute(c, async () => {
			const task = await getTask(createDb(c.env.DB), c.get("user").id, c.req.param("id"));
			return { task };
		}),
	)
	.patch("/:id", zValidator("json", updateTaskInput), (c) =>
		handleRoute(c, async () => {
			const task = await updateTask(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.param("id"),
				c.req.valid("json"),
				c.get("source"),
			);
			return { task };
		}),
	)
	.post("/:id/nudge", (c) =>
		handleRoute(c, async () => {
			const task = await nudgeWaiting(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.param("id"),
				c.get("source"),
			);
			return { task };
		}),
	)
	.post("/:id/complete", (c) =>
		handleRoute(c, async () => {
			const task = await completeTask(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.param("id"),
				c.get("source"),
			);
			return { task };
		}),
	)
	.delete("/:id", (c) =>
		handleRoute(c, async () =>
			deleteTask(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.param("id"),
				c.get("source"),
			),
		),
	);
