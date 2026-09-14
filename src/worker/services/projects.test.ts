import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityLog, tasks } from "../../db/schema";
import { createTestDb, seedUser } from "../test/db";
import { callMcpTool } from "../mcp/tools";
import { createTask, getTask, listTasks } from "./tasks";
import { createProject, getProject, listProjects, updateProject } from "./projects";

describe("project service archive", () => {
	it("archives a non-inbox project, hides it from default list, and keeps tasks", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const project = await createProject(db as never, me.id, { name: "装修" }, "human");
		const task = await createTask(
			db as never,
			me.id,
			{ title: "量尺寸", projectId: project.id, status: "next" },
			"human",
		);

		const archived = await updateProject(
			db as never,
			me.id,
			project.id,
			{ archived: true },
			"human",
		);
		expect(archived.archivedAt).toBeTruthy();
		expect(archived.name).toBe("装修");

		const active = await listProjects(db as never, me.id);
		expect(active.map((item) => item.id)).not.toContain(project.id);
		expect(active.some((item) => item.isInbox)).toBe(true);

		const all = await listProjects(db as never, me.id, { includeArchived: true });
		expect(all.map((item) => item.id)).toContain(project.id);

		const listed = await listTasks(db as never, me.id, { projectId: project.id });
		expect(listed.items.map((item) => item.id)).toContain(task.id);
		const still = await getTask(db as never, me.id, task.id);
		expect(still.deletedAt).toBeNull();
		expect(still.projectId).toBe(project.id);

		const activities = await db
			.select()
			.from(activityLog)
			.where(eq(activityLog.userId, me.id));
		expect(activities.some((row) => row.summary === "归档项目「装修」")).toBe(true);
	});

	it("rejects archiving inbox and does not delete the inbox row", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const inbox = (await listProjects(db as never, me.id)).find((item) => item.isInbox);
		expect(inbox).toBeTruthy();

		await expect(
			updateProject(db as never, me.id, inbox!.id, { archived: true }, "human"),
		).rejects.toMatchObject({ status: 400, message: "收件箱不能归档" });

		const again = await getProject(db as never, me.id, inbox!.id);
		expect(again.archivedAt).toBeNull();
		expect(again.isInbox).toBe(true);
	});

	it("unarchives a project so it returns to the default list", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const project = await createProject(db as never, me.id, { name: "论文" }, "mcp");
		await updateProject(db as never, me.id, project.id, { archived: true }, "mcp");

		const restored = await updateProject(
			db as never,
			me.id,
			project.id,
			{ archived: false },
			"human",
		);
		expect(restored.archivedAt).toBeNull();

		const active = await listProjects(db as never, me.id);
		expect(active.map((item) => item.id)).toContain(project.id);

		const activities = await db
			.select()
			.from(activityLog)
			.where(eq(activityLog.userId, me.id));
		expect(activities.some((row) => row.summary === "取消归档项目「论文」")).toBe(true);
	});

	it("MCP list_projects hides archived by default; update_project archives and unarchives", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const created = (await callMcpTool(db as never, me.id, "create_project", {
			name: "健身",
		})) as { project: { id: string } };

		await callMcpTool(db as never, me.id, "create_task", {
			title: "跑步",
			projectId: created.project.id,
		});

		const archived = (await callMcpTool(db as never, me.id, "update_project", {
			id: created.project.id,
			archived: true,
		})) as { project: { id: string; archivedAt: string | null } };
		expect(archived.project.archivedAt).toBeTruthy();

		const listed = (await callMcpTool(db as never, me.id, "list_projects", {})) as {
			items: { id: string }[];
		};
		expect(listed.items.map((item) => item.id)).not.toContain(created.project.id);

		const withArchived = (await callMcpTool(db as never, me.id, "list_projects", {
			includeArchived: true,
		})) as { items: { id: string }[] };
		expect(withArchived.items.map((item) => item.id)).toContain(created.project.id);

		const restored = (await callMcpTool(db as never, me.id, "update_project", {
			id: created.project.id,
			archived: false,
		})) as { project: { archivedAt: string | null } };
		expect(restored.project.archivedAt).toBeNull();

		const listedAgain = (await callMcpTool(db as never, me.id, "list_projects", {})) as {
			items: { id: string }[];
		};
		expect(listedAgain.items.map((item) => item.id)).toContain(created.project.id);

		const remaining = await db.select().from(tasks).where(eq(tasks.userId, me.id));
		expect(remaining.map((row) => row.title)).toContain("跑步");
	});

	it("MCP update_project cannot archive inbox", async () => {
		const { db } = createTestDb();
		const me = await seedUser(db);
		const inbox = (await listProjects(db as never, me.id)).find((item) => item.isInbox)!;

		await expect(
			callMcpTool(db as never, me.id, "update_project", {
				id: inbox.id,
				archived: true,
			}),
		).rejects.toMatchObject({ status: 400, message: "收件箱不能归档" });
	});
});
