// @vitest-environment happy-dom
/** #101：登录页挂载时清掉客户端会话（查询缓存 + 收件箱 id 提示）；#82 已登录直接进工作台不变。 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readInboxHint, writeInboxHint } from "../lib/inbox-hint";
import { readSkeletonCount, writeSkeletonCount } from "../lib/skeleton";
import { LoginPage } from "./LoginPage";

let meStatus = 401;
const ME = { user: { id: "u2", email: "next@example.com", name: "Next" }, source: "human" };

beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = String(input);
			const json = (status: number, body: unknown) =>
				new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
			if (path === "/api/me") return meStatus === 200 ? json(200, ME) : json(meStatus, { error: "unauthorized" });
			if (path === "/api/health") return json(200, { ok: true, signupEnabled: false });
			return json(404, {});
		}),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function renderLogin(client: QueryClient) {
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/login"]}>
				<Routes>
					<Route path="/login" element={<LoginPage />} />
					<Route path="/today" element={<p>工作台</p>} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
}

describe("LoginPage clears the client session (#101)", () => {
	it("clears the inbox id hint and the previous user's query cache on mount", async () => {
		meStatus = 401;
		writeInboxHint("previous-user-inbox");
		writeSkeletonCount(["settings", "passkeys"], 2);
		localStorage.setItem("theme", "dark");
		const client = new QueryClient();
		client.setQueryData(["me"], { user: { id: "u1", email: "prev@example.com", name: "Prev" } });
		client.setQueryData(["tasks", "list", { projectId: "previous-user-inbox" }], { items: [] });
		renderLogin(client);
		await act(flush);
		expect(readInboxHint()).toBeNull();
		expect(readSkeletonCount(["settings", "passkeys"])).toBeNull();
		expect(localStorage.getItem("theme")).toBe("dark");
		expect(client.getQueryData(["me"])).toBeUndefined();
		expect(client.getQueryData(["tasks", "list", { projectId: "previous-user-inbox" }])).toBeUndefined();
		expect(screen.queryByText("工作台")).toBeNull();
	});

	it("#82: with an active session it still goes straight to /today, seeding [\"me\"]", async () => {
		meStatus = 200;
		writeInboxHint("stale");
		const client = new QueryClient();
		renderLogin(client);
		await act(flush);
		expect(screen.getByText("工作台")).toBeTruthy();
		expect(readInboxHint()).toBeNull();
		expect(client.getQueryData(["me"])).toEqual(ME);
	});
});
