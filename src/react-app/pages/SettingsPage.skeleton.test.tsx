// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSkeletonCount } from "../lib/skeleton";
import { settingsKeys } from "../lib/settings-keys";

const never = () => new Promise(() => {});
vi.mock("../api", () => ({
	api: {
		tokens: vi.fn(() => never()),
		deletedTasks: vi.fn(() => never()),
		health: vi.fn(() => never()),
	},
}));
vi.mock("../auth-client", () => ({
	authClient: { $fetch: vi.fn(() => never()), passkey: { addPasskey: vi.fn() } },
}));

import { SettingsPage } from "./SettingsPage";

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

function mount() {
	return render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter>
				<Routes>
					<Route element={<Outlet context={{ projects: [], reloadProjects: async () => {} }} />}>
						<Route path="/" element={<SettingsPage />} />
					</Route>
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

/** 每张卡片里的骨架行数，按卡片顺序：通行密钥、API Token、回收站。 */
function rowsPerCard() {
	return screen.getAllByTestId("skeleton-list").map((list) => ({
		label: list.getAttribute("aria-label"),
		rows: list.querySelectorAll("[data-skeleton]").length,
	}));
}

beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} })),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("settings card skeletons (#99)", () => {
	it("no saved count → each card shows 1 skeleton row (not the default 5)", async () => {
		mount();
		await wait(200);
		expect(rowsPerCard()).toEqual([
			{ label: "正在加载通行密钥", rows: 1 },
			{ label: "正在加载 Token", rows: 1 },
			{ label: "正在加载回收站", rows: 1 },
		]);
	});

	it("saved counts still win (capped at 10)", async () => {
		writeSkeletonCount(settingsKeys.passkeys(), 2);
		writeSkeletonCount(settingsKeys.tokens(), 3);
		writeSkeletonCount(settingsKeys.deletedTasks(), 40);
		mount();
		await wait(200);
		expect(rowsPerCard().map((c) => c.rows)).toEqual([2, 3, 10]);
	});
});
