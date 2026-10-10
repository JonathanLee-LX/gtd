// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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

const CARDS = ["通行密钥", "API Token", "回收站"] as const;

/** 按卡片标题找到卡片容器（只在卡片内查，不数整页 —— 页面上还有别的骨架，如已归档项目）。 */
function card(title: (typeof CARDS)[number]): HTMLElement {
	const heading = screen.getByText(title, { selector: '[data-slot="card-title"]' });
	const container = heading.closest<HTMLElement>('[data-slot="card"]');
	if (!container) throw new Error(`card「${title}」not found`);
	return container;
}

/** 三张卡片里各自的骨架（标签 + 行数），按 通行密钥、API Token、回收站 顺序。 */
function rowsPerCard() {
	return CARDS.map((title) => {
		const list = within(card(title)).getByTestId("skeleton-list");
		return { card: title, label: list.getAttribute("aria-label"), rows: list.querySelectorAll("[data-skeleton]").length };
	});
}

const variants = () =>
	CARDS.map((title) => within(card(title)).getByTestId("skeleton-list").dataset.skeletonVariant);

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
	it("no saved count → 通行密钥 / API Token draw one empty-line skeleton, 回收站 1 row (never the default 5)", async () => {
		mount();
		await wait(200);
		expect(rowsPerCard()).toEqual([
			{ card: "通行密钥", label: "正在加载通行密钥", rows: 1 },
			{ card: "API Token", label: "正在加载 Token", rows: 1 },
			{ card: "回收站", label: "正在加载回收站", rows: 1 },
		]);
		expect(variants()).toEqual(["empty", "empty", "rows"]);
	});

	it("saved counts still win (capped at 10)", async () => {
		writeSkeletonCount(settingsKeys.passkeys(), 2);
		writeSkeletonCount(settingsKeys.tokens(), 3);
		writeSkeletonCount(settingsKeys.deletedTasks(), 40);
		mount();
		await wait(200);
		expect(rowsPerCard().map((c) => c.rows)).toEqual([2, 3, 10]);
		expect(variants()).toEqual(["rows", "rows", "rows"]);
	});

	it("saved count 0 (empty last time) → empty-line skeleton in that card, not a full row", async () => {
		writeSkeletonCount(settingsKeys.passkeys(), 0);
		writeSkeletonCount(settingsKeys.tokens(), 0);
		writeSkeletonCount(settingsKeys.deletedTasks(), 4);
		mount();
		await wait(200);
		expect(variants()).toEqual(["empty", "empty", "rows"]);
		expect(rowsPerCard().map((c) => c.rows)).toEqual([1, 1, 4]);
		expect(within(card("通行密钥")).getByTestId("skeleton-list").querySelectorAll("[data-skeleton-empty]")).toHaveLength(1);
		expect(within(card("API Token")).getByTestId("skeleton-list").querySelectorAll("[data-skeleton-empty]")).toHaveLength(1);
	});
});
