import { describe, expect, it, vi } from "vitest";
import { AppError } from "../lib/errors";
import { parseNaturalLanguage } from "./ai";

const DRAFT_PAYLOAD = {
	tasks: [
		{
			title: "买牛奶",
			notes: null,
			status: "next",
			priority: "none",
			dueAt: null,
			waitingOn: null,
			tagNames: [],
		},
	],
};

function fakeAi(response: string | undefined) {
	return {
		run: vi.fn().mockResolvedValue({ response }),
	} as unknown as Ai;
}

describe("parseNaturalLanguage (Workers AI)", () => {
	it("parses drafts from the Workers AI JSON response", async () => {
		const ai = fakeAi(JSON.stringify(DRAFT_PAYLOAD));
		const tasks = await parseNaturalLanguage(ai, "买牛奶", "Asia/Shanghai");
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.title).toBe("买牛奶");
		expect(ai.run).toHaveBeenCalledTimes(1);
		const [model, inputs] = (ai.run as ReturnType<typeof vi.fn>).mock.calls[0] as [
			string,
			{ messages: unknown[] },
		];
		expect(model).toContain("llama");
		expect(inputs.messages).toHaveLength(2);
	});

	it("503s when the AI binding is missing", async () => {
		const err = await parseNaturalLanguage(undefined, "买牛奶").catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(AppError);
		expect((err as AppError).status).toBe(503);
	});

	it("503s when Workers AI throws", async () => {
		const ai = {
			run: vi.fn().mockRejectedValue(new Error("boom")),
		} as unknown as Ai;
		const err = await parseNaturalLanguage(ai, "买牛奶").catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(AppError);
		expect((err as AppError).status).toBe(503);
	});

	it("400s on invalid draft JSON", async () => {
		const ai = fakeAi(JSON.stringify({ tasks: [{ title: 123 }] }));
		const err = await parseNaturalLanguage(ai, "买牛奶").catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(AppError);
		expect((err as AppError).status).toBe(400);
		expect((err as AppError).code).toBe("ai_invalid_draft");
	});
});
