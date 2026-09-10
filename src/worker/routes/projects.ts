import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../../db/client";
import { createProjectInput, updateProjectInput } from "../../shared/schemas";
import type { WorkerEnv } from "../lib/auth";
import { handleRoute } from "../lib/route-utils";
import { requireUser, type AppVariables } from "../middleware/require-user";
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
	updateProject,
} from "../services/projects";

export const projectRoutes = new Hono<{
	Bindings: WorkerEnv;
	Variables: AppVariables;
}>()
	.use("*", requireUser)
	.get("/", (c) =>
		handleRoute(c, async () => {
			const items = await listProjects(createDb(c.env.DB), c.get("user").id);
			return { items };
		}),
	)
	.post("/", zValidator("json", createProjectInput), (c) =>
		handleRoute(
			c,
			async () => {
				const project = await createProject(
					createDb(c.env.DB),
					c.get("user").id,
					c.req.valid("json"),
					c.get("source"),
				);
				return { project };
			},
			201,
		),
	)
	.get("/:id", (c) =>
		handleRoute(c, async () => {
			const project = await getProject(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.param("id"),
			);
			return { project };
		}),
	)
	.patch("/:id", zValidator("json", updateProjectInput), (c) =>
		handleRoute(c, async () => {
			const project = await updateProject(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.param("id"),
				c.req.valid("json"),
				c.get("source"),
			);
			return { project };
		}),
	)
	.delete("/:id", (c) =>
		handleRoute(c, async () =>
			deleteProject(
				createDb(c.env.DB),
				c.get("user").id,
				c.req.param("id"),
				c.get("source"),
			),
		),
	);
