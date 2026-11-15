import { describe, expect, it } from "vitest";
import { createTestDb, seedUser } from "../test/db";
import { callMcpTool, MCP_TOOLS } from "./tools";

describe("MCP tools markdown notes support (#131)", () => {
	it("exposes markdown descriptions in MCP tool schemas", () => {
		const getTask = MCP_TOOLS.find((t) => t.name === "get_task");
		expect(getTask?.description).toContain("Markdown");

		const createTask = MCP_TOOLS.find((t) => t.name === "create_task");
		const createNotes = (createTask?.inputSchema.properties as Record<string, { description?: string }>).notes;
		expect(createNotes?.description).toContain("Markdown");
		expect(createNotes?.description).toContain("8000");

		const updateTask = MCP_TOOLS.find((t) => t.name === "update_task");
		const updateNotes = (updateTask?.inputSchema.properties as Record<string, { description?: string }>).notes;
		expect(updateNotes?.description).toContain("Markdown");
		expect(updateNotes?.description).toContain("8000");
	});

	it("creates and updates tasks with Markdown notes, reading back exact content via get_task / list_tasks / search_tasks", async () => {
		const { db } = createTestDb();
		const user = await seedUser(db);

		const markdownNotes = [
			"# 待办备注",
			"",
			"包含一些关键上下文：",
			"- [ ] 任务一",
			"- [x] 任务二",
			"",
			"```ts",
			"const code = 'block';",
			"```",
			"",
			"| 表头 1 | 表头 2 |",
			"| :--- | :--- |",
			"| 单元格 A | 单元格 B |",
			"",
			"参考文档：[Google](https://google.com)",
		].join("\n");

		// 1. callMcpTool: create_task with Markdown notes
		const createResult = (await callMcpTool(db as never, user.id, "create_task", {
			title: "测试 Markdown 待办",
			notes: markdownNotes,
		})) as { task: { id: string; notes: string | null } };

		expect(createResult.task).toBeDefined();
		expect(createResult.task.notes).toBe(markdownNotes);
		const taskId = createResult.task.id;

		// 2. callMcpTool: get_task returns exact same markdown notes
		const getResult = (await callMcpTool(db as never, user.id, "get_task", {
			id: taskId,
		})) as { task: { id: string; notes: string | null } };
		expect(getResult.task.notes).toBe(markdownNotes);

		// 3. callMcpTool: list_tasks contains exact same markdown notes
		const listResult = (await callMcpTool(db as never, user.id, "list_tasks", {})) as {
			items: Array<{ id: string; notes: string | null }>;
		};
		const foundInList = listResult.items.find((item) => item.id === taskId);
		expect(foundInList).toBeDefined();
		expect(foundInList?.notes).toBe(markdownNotes);

		// 4. callMcpTool: search_tasks matches by keyword in notes and returns exact markdown
		const searchResult = (await callMcpTool(db as never, user.id, "search_tasks", {
			q: "单元格 A",
		})) as { items: Array<{ id: string; notes: string | null }> };
		const foundInSearch = searchResult.items.find((item) => item.id === taskId);
		expect(foundInSearch).toBeDefined();
		expect(foundInSearch?.notes).toBe(markdownNotes);

		// 5. callMcpTool: update_task updates Markdown notes
		const updatedMarkdownNotes = "## 更新后的备注\n\n- 新项目列表\n\n[新链接](https://example.org)";
		const updateResult = (await callMcpTool(db as never, user.id, "update_task", {
			id: taskId,
			notes: updatedMarkdownNotes,
		})) as { task: { id: string; notes: string | null } };
		expect(updateResult.task.notes).toBe(updatedMarkdownNotes);

		// 6. Verify get_task and search_tasks with updated content
		const getAfterUpdate = (await callMcpTool(db as never, user.id, "get_task", {
			id: taskId,
		})) as { task: { id: string; notes: string | null } };
		expect(getAfterUpdate.task.notes).toBe(updatedMarkdownNotes);

		const searchAfterUpdate = (await callMcpTool(db as never, user.id, "search_tasks", {
			q: "新项目列表",
		})) as { items: Array<{ id: string; notes: string | null }> };
		expect(searchAfterUpdate.items.some((item) => item.id === taskId)).toBe(true);
		expect(searchAfterUpdate.items.find((item) => item.id === taskId)?.notes).toBe(updatedMarkdownNotes);
	});
});
