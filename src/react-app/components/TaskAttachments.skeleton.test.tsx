// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentKeys } from "../lib/attachment-service";
import { writeSkeletonCount } from "../lib/skeleton";

const listMock = vi.fn();
vi.mock("../lib/attachment-service", async (orig) => {
	const real = await orig<typeof import("../lib/attachment-service")>();
	return {
		...real,
		attachmentService: { ...real.attachmentService, list: (id: string) => listMock(id) },
	};
});

import { TaskAttachments } from "./TaskAttachments";

const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
const rows = () => document.querySelectorAll('[data-testid="skeleton-list"] li[data-skeleton]');

beforeEach(() => {
	localStorage.clear();
	listMock.mockReset();
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({
			matches: false,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})),
	);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function mount(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
	return render(
		<QueryClientProvider client={client}>
			<TaskAttachments taskId="t1" />
		</QueryClientProvider>,
	);
}

describe("TaskAttachments skeleton (#99)", () => {
	it("replaces「加载附件…」with skeleton rows (default 1, remembered count afterwards)", async () => {
		listMock.mockReturnValue(new Promise(() => {}));
		mount();
		expect(screen.queryByText("加载附件…")).toBeNull();
		await wait(200);
		expect(rows()).toHaveLength(1);
		expect(screen.queryByText("还没有附件。")).toBeNull();
		cleanup();

		writeSkeletonCount(attachmentKeys.task("t1"), 3);
		mount();
		await wait(200);
		expect(rows()).toHaveLength(3);
	});

	it("cache hit shows the list directly, no skeleton", async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
		client.setQueryData(attachmentKeys.task("t1"), { items: [] });
		mount(client);
		await wait(200);
		expect(rows()).toHaveLength(0);
		expect(screen.getByText("还没有附件。")).not.toBeNull();
	});
});
