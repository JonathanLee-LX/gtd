// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { clearClientSession } from "./client-session";
import { readInboxHint, writeInboxHint } from "./inbox-hint";

beforeEach(() => localStorage.clear());

describe("clearClientSession (#101)", () => {
	it("clears the query cache and the inbox id hint together", () => {
		const client = new QueryClient();
		client.setQueryData(["me"], { user: { id: "u1" } });
		client.setQueryData(["projects"], { items: [] });
		writeInboxHint("inbox-1");
		localStorage.setItem("gtd:skeleton-count:x", "3"); // 骨架行数记录不是会话数据，保留
		clearClientSession(client);
		expect(client.getQueryCache().getAll()).toHaveLength(0);
		expect(readInboxHint()).toBeNull();
		expect(localStorage.getItem("gtd:skeleton-count:x")).toBe("3");
	});
});
