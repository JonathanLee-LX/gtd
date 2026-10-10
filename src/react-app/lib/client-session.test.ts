// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { clearClientSession } from "./client-session";
import { readInboxHint, writeInboxHint } from "./inbox-hint";
import { readSkeletonCount, SKELETON_STORAGE_PREFIX, writeSkeletonCount } from "./skeleton";

beforeEach(() => localStorage.clear());

describe("clearClientSession (#101)", () => {
	it("clears the query cache, the inbox id hint and skeleton counts together", () => {
		const client = new QueryClient();
		client.setQueryData(["me"], { user: { id: "u1" } });
		client.setQueryData(["projects"], { items: [] });
		writeInboxHint("inbox-1");
		writeSkeletonCount(["tasks", "list", { status: "next" }], 3);
		writeSkeletonCount(["settings", "passkeys"], 0);
		localStorage.setItem("theme", "dark");
		localStorage.setItem("gtd:sidebar-width", "280");
		localStorage.setItem("gtd:skeleton-countx", "keep"); // 前缀不完全匹配，不删
		clearClientSession(client);
		expect(client.getQueryCache().getAll()).toHaveLength(0);
		expect(readInboxHint()).toBeNull();
		// #99：上一个用户的骨架行数记录全部清掉
		expect(readSkeletonCount(["tasks", "list", { status: "next" }])).toBeNull();
		expect(readSkeletonCount(["settings", "passkeys"])).toBeNull();
		expect(Object.keys(localStorage).filter((k) => k.startsWith(SKELETON_STORAGE_PREFIX))).toEqual([]);
		// 其他 localStorage 不动
		expect(localStorage.getItem("theme")).toBe("dark");
		expect(localStorage.getItem("gtd:sidebar-width")).toBe("280");
		expect(localStorage.getItem("gtd:skeleton-countx")).toBe("keep");
	});
});
