import { DEFAULT_TIME_ZONE } from "../../shared/constants";
import {
	parseAiOutput,
	type CommitAiInput,
	type TaskDraft,
	type TaskSource,
} from "../../shared/schemas";
import { ymdInZone } from "../../shared/today";
import type { AppDatabase } from "../../db/client";
import { badRequest, serviceUnavailable } from "../lib/errors";
import { createTag } from "./tags";
import { createTask } from "./tasks";

const DRAFT_JSON_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["tasks"],
	properties: {
		tasks: {
			type: "array",
			minItems: 1,
			maxItems: 8,
			items: {
				type: "object",
				additionalProperties: false,
				required: [
					"title",
					"notes",
					"status",
					"priority",
					"dueAt",
					"waitingOn",
					"tagNames",
				],
				properties: {
					title: { type: "string" },
					notes: { type: ["string", "null"] },
					status: {
						type: "string",
						enum: [
							"inbox",
							"next",
							"waiting",
							"scheduled",
							"someday",
							"completed",
							"cancelled",
						],
					},
					priority: { type: "string", enum: ["none", "p1", "p2", "p3"] },
					dueAt: { type: ["string", "null"] },
					waitingOn: { type: ["string", "null"] },
					tagNames: {
						type: "array",
						maxItems: 8,
						items: { type: "string" },
					},
				},
			},
		},
	},
} as const;

/** Workers AI 文本生成模型。换模型只改这里。 */
const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

export async function parseNaturalLanguage(
	ai: Ai | undefined,
	text: string,
	timeZone = DEFAULT_TIME_ZONE,
): Promise<TaskDraft[]> {
	if (!ai) {
		throw serviceUnavailable("AI 服务尚未启用，普通创建任务不受影响。");
	}
	const today = ymdInZone(new Date(), timeZone);
	let result: { response?: string };
	try {
		result = await ai.run(AI_MODEL, {
			messages: [
				{
					role: "system",
					content:
						`你把用户的自然语言拆成 GTD 任务草稿。今天是 ${today}（时区 ${timeZone}）。` +
						"dueAt 用 YYYY-MM-DD，不知道就 null。status 默认 next；收件箱想法用 inbox；等人用 waiting。" +
						"不要编造用户没说的截止日期。只输出 JSON。",
				},
				{ role: "user", content: text },
			],
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "gtd_task_drafts",
					schema: DRAFT_JSON_SCHEMA,
				},
			},
		});
	} catch (err) {
		console.error("Workers AI parse failed", err);
		throw serviceUnavailable("AI 解析暂时不可用，请直接添加任务。");
	}
	const content = result.response;
	if (!content) throw serviceUnavailable("AI 没有返回草稿。");
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw badRequest("AI 返回的不是 JSON", "ai_invalid_json");
	}
	const drafts = parseAiOutput.safeParse(parsed);
	if (!drafts.success) {
		throw badRequest("AI 草稿不符合任务契约", "ai_invalid_draft");
	}
	return drafts.data.tasks;
}

export async function commitAiDraft(
	db: AppDatabase,
	userId: string,
	input: CommitAiInput,
	source: TaskSource = "ai",
) {
	const tagIds: string[] = [];
	for (const name of input.tagNames) {
		const tag = await createTag(db, userId, name, source);
		tagIds.push(tag.id);
	}
	return createTask(
		db,
		userId,
		{
			title: input.title,
			notes: input.notes ?? undefined,
			status: input.status,
			priority: input.priority,
			dueAt: input.dueAt,
			waitingOn: input.waitingOn,
			projectId: input.projectId,
			tagIds,
		},
		source,
	);
}
