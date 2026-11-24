import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityLog } from "../../db/schema";
import { createTestDb, seedUser } from "../test/db";
import { FakeR2, PDF_BYTES, PNG_BYTES } from "../test/fake-r2";
import { callMcpTool, decodeBase64, MCP_TOOLS } from "./tools";

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

describe("MCP tools task attachments support (#133)", () => {
	it("exposes attachment tools in MCP_TOOLS schemas", () => {
		const getTask = MCP_TOOLS.find((t) => t.name === "get_task");
		expect(getTask?.description).toContain("附件");

		const listAtt = MCP_TOOLS.find((t) => t.name === "list_attachments");
		expect(listAtt).toBeDefined();
		expect((listAtt?.inputSchema.properties as Record<string, unknown>).taskId).toBeDefined();
		expect(listAtt?.inputSchema.required).toEqual(["taskId"]);

		const uploadAtt = MCP_TOOLS.find((t) => t.name === "upload_attachment");
		expect(uploadAtt).toBeDefined();
		expect(uploadAtt?.inputSchema.required).toEqual(["taskId", "fileName", "content"]);

		const deleteAtt = MCP_TOOLS.find((t) => t.name === "delete_attachment");
		expect(deleteAtt).toBeDefined();
		expect(deleteAtt?.inputSchema.required).toEqual(["taskId", "id"]);
	});

	it("decodes pure base64 and data URI base64 correctly", () => {
		const original = new Uint8Array([1, 2, 3, 4, 5, 255]);
		const base64Str = Buffer.from(original).toString("base64");
		const dataUriStr = `data:image/png;base64,${base64Str}`;

		expect(decodeBase64(base64Str)).toEqual(original);
		expect(decodeBase64(dataUriStr)).toEqual(original);
		expect(decodeBase64(`  ${base64Str} \n`)).toEqual(original);
	});

	it("rejects invalid base64 with invalid_base64 (Buffer.from would silently drop bad chars)", () => {
		for (const bad of ["", "   ", "!!!", "abc", "a===", "AB=C", "aGVsbG8", "aGVsbG8td29ybGQ"]) {
			expect(() => decodeBase64(bad)).toThrow("无效的 base64 内容");
		}
	});

	it("tolerates whitespace inside base64 (MIME-style line breaks)", () => {
		const original = new Uint8Array([1, 2, 3, 4, 5, 255]);
		const base64Str = Buffer.from(original).toString("base64");
		const broken = `${base64Str.slice(0, 4)}\n${base64Str.slice(4)}`;
		expect(decodeBase64(broken)).toEqual(original);
	});

	it("throws when calling upload_attachment or delete_attachment without bucket configured", async () => {
		const { db } = createTestDb();
		const user = await seedUser(db);

		await expect(
			callMcpTool(db as never, user.id, "upload_attachment", {
				taskId: "t1",
				fileName: "test.png",
				content: "AAAA",
			}),
		).rejects.toThrow("未配置附件存储桶");

		await expect(
			callMcpTool(db as never, user.id, "delete_attachment", {
				taskId: "t1",
				id: "a1",
			}),
		).rejects.toThrow("未配置附件存储桶");
	});

	it("supports uploading, listing, viewing in get_task, and deleting attachments", async () => {
		const { db } = createTestDb();
		const user = await seedUser(db);
		const bucket = new FakeR2();

		// 1. Create a task
		const createResult = (await callMcpTool(db as never, user.id, "create_task", {
			title: "带附件的任务",
		})) as { task: { id: string } };
		const taskId = createResult.task.id;

		// 2. Initial get_task has empty attachments
		const getInit = (await callMcpTool(db as never, user.id, "get_task", { id: taskId })) as {
			task: { id: string; attachments: unknown[] };
		};
		expect(getInit.task.attachments).toEqual([]);

		// 3. Upload attachment via upload_attachment
		const pngBase64 = Buffer.from(PNG_BYTES).toString("base64");
		const uploadRes = (await callMcpTool(
			db as never,
			user.id,
			"upload_attachment",
			{
				taskId,
				fileName: "screen.png",
				content: pngBase64,
			},
			{ bucket: bucket as never },
		)) as {
			attachment: {
				id: string;
				taskId: string;
				kind: string;
				fileName: string;
				mime: string;
				size: number;
				contentUrl: string;
			};
		};

		expect(uploadRes.attachment.id).toBeDefined();
		expect(uploadRes.attachment.taskId).toBe(taskId);
		expect(uploadRes.attachment.kind).toBe("image");
		expect(uploadRes.attachment.fileName).toBe("screen.png");
		expect(uploadRes.attachment.mime).toBe("image/png");
		expect(uploadRes.attachment.size).toBe(PNG_BYTES.byteLength);
		expect(uploadRes.attachment.contentUrl).toBe(`/api/attachments/${uploadRes.attachment.id}/content`);
		expect(bucket.objects.size).toBe(1);

		// 4. get_task now includes the attachment
		const getWithAtt = (await callMcpTool(db as never, user.id, "get_task", { id: taskId })) as {
			task: { id: string; attachments: Array<{ id: string; fileName: string }> };
		};
		expect(getWithAtt.task.attachments).toHaveLength(1);
		expect(getWithAtt.task.attachments[0].id).toBe(uploadRes.attachment.id);
		expect(getWithAtt.task.attachments[0].fileName).toBe("screen.png");

		// 5. list_attachments returns the attachment and usage
		const listRes = (await callMcpTool(db as never, user.id, "list_attachments", { taskId })) as {
			items: Array<{ id: string; fileName: string }>;
			usage: { count: number; bytes: number };
		};
		expect(listRes.items).toHaveLength(1);
		expect(listRes.items[0].id).toBe(uploadRes.attachment.id);
		expect(listRes.usage.count).toBe(1);
		expect(listRes.usage.bytes).toBe(PNG_BYTES.byteLength);

		// 6. delete_attachment deletes the attachment from database and R2
		const delRes = (await callMcpTool(
			db as never,
			user.id,
			"delete_attachment",
			{
				taskId,
				id: uploadRes.attachment.id,
			},
			{ bucket: bucket as never },
		)) as { ok: boolean; r2Deleted: boolean };

		expect(delRes.ok).toBe(true);
		expect(delRes.r2Deleted).toBe(true);
		expect(bucket.objects.size).toBe(0);

		// 7. Verification: list_attachments and get_task are now empty
		const listAfterDel = (await callMcpTool(db as never, user.id, "list_attachments", { taskId })) as {
			items: unknown[];
			usage: { count: number; bytes: number };
		};
		expect(listAfterDel.items).toHaveLength(0);
		expect(listAfterDel.usage.count).toBe(0);

		const getAfterDel = (await callMcpTool(db as never, user.id, "get_task", { id: taskId })) as {
			task: { id: string; attachments: unknown[] };
		};
		expect(getAfterDel.task.attachments).toHaveLength(0);

		// 8. Test uploading PDF file
		const pdfBase64 = Buffer.from(PDF_BYTES).toString("base64");
		const uploadPdfRes = (await callMcpTool(
			db as never,
			user.id,
			"upload_attachment",
			{
				taskId,
				fileName: "document.pdf",
				content: pdfBase64,
			},
			{ bucket: bucket as never },
		)) as {
			attachment: {
				kind: string;
				fileName: string;
				mime: string;
				size: number;
			};
		};
		expect(uploadPdfRes.attachment.kind).toBe("file");
		expect(uploadPdfRes.attachment.fileName).toBe("document.pdf");
		expect(uploadPdfRes.attachment.mime).toBe("application/pdf");
		expect(uploadPdfRes.attachment.size).toBe(PDF_BYTES.byteLength);
	});
});

describe("MCP tools tag management (#122)", () => {
	it("exposes delete_tag in MCP_TOOLS and documents taskCount in list_tags", () => {
		const listTagsTool = MCP_TOOLS.find((t) => t.name === "list_tags");
		expect(listTagsTool?.description).toContain("taskCount");

		const deleteTagTool = MCP_TOOLS.find((t) => t.name === "delete_tag");
		expect(deleteTagTool).toBeDefined();
		expect(deleteTagTool?.inputSchema.required).toEqual(["id"]);
		expect((deleteTagTool?.inputSchema.properties as Record<string, unknown>).id).toBeDefined();
	});

	it("lists tags with taskCount, deletes owned tags via delete_tag, and isolates tenants", async () => {
		const { db } = createTestDb();
		const userA = await seedUser(db, "mcp-a@example.com");
		const userB = await seedUser(db, "mcp-b@example.com");

		const { tag: tag1 } = (await callMcpTool(db as never, userA.id, "create_tag", {
			name: "qa119a",
		})) as { tag: { id: string; name: string } };
		const { tag: tag2 } = (await callMcpTool(db as never, userA.id, "create_tag", {
			name: "保留标签",
		})) as { tag: { id: string; name: string } };

		const { task: activeTask } = (await callMcpTool(db as never, userA.id, "create_task", {
			title: "有标签的任务",
			tagIds: [tag1.id, tag2.id],
		})) as { task: { id: string } };
		const { task: deletedTask } = (await callMcpTool(db as never, userA.id, "create_task", {
			title: "软删任务",
			tagIds: [tag1.id],
		})) as { task: { id: string } };
		await callMcpTool(db as never, userA.id, "delete_task", { id: deletedTask.id });

		// list_tags returns taskCount excluding soft-deleted tasks
		const before = (await callMcpTool(db as never, userA.id, "list_tags", {})) as {
			items: Array<{ id: string; name: string; taskCount: number }>;
		};
		expect(before.items.find((t) => t.id === tag1.id)?.taskCount).toBe(1);
		expect(before.items.find((t) => t.id === tag2.id)?.taskCount).toBe(1);

		// Multi-tenant isolation: User B cannot delete User A's tag
		await expect(
			callMcpTool(db as never, userB.id, "delete_tag", { id: tag1.id }),
		).rejects.toMatchObject({ status: 404, code: "not_found" });

		// Rejects empty id
		await expect(
			callMcpTool(db as never, userA.id, "delete_tag", { id: "   " }),
		).rejects.toThrow();

		// User A deletes tag1 via MCP
		const delRes = (await callMcpTool(db as never, userA.id, "delete_tag", {
			id: tag1.id,
		})) as { ok: boolean };
		expect(delRes).toEqual({ ok: true });

		// Gone from list_tags and from task
		const after = (await callMcpTool(db as never, userA.id, "list_tags", {})) as {
			items: Array<{ id: string; name: string; taskCount: number }>;
		};
		expect(after.items.map((t) => t.id)).toEqual([tag2.id]);

		const taskAfter = (await callMcpTool(db as never, userA.id, "get_task", {
			id: activeTask.id,
		})) as { task: { tags: Array<{ id: string; name: string }> } };
		expect(taskAfter.task.tags).toEqual([{ id: tag2.id, name: "保留标签" }]);

		// Recorded in activity_log with actorType = "mcp"
		const logs = await db.select().from(activityLog).where(eq(activityLog.userId, userA.id));
		expect(logs.find((row) => row.action === "tag.delete")).toMatchObject({
			actorType: "mcp",
			entityType: "tag",
			entityId: tag1.id,
			summary: "删除标签「qa119a」",
		});
	});
});
