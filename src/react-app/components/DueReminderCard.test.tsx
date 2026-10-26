// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationSettings, SaveNotificationSettings } from "../api";
import type { PushProbe, PushSubscriptionKeys } from "../lib/push-client";
import { DueReminderCard } from "./DueReminderCard";

const SETTINGS: NotificationSettings = {
	enabled: false,
	digestTime: "09:00",
	tomorrowEnabled: false,
	tomorrowTime: "21:00",
	includeOverdue: true,
	timeZone: "Asia/Shanghai",
	saved: true,
	subscriptionCount: 0,
	vapidPublicKey: "test-public",
};

const SUB: PushSubscriptionKeys = {
	endpoint: "https://fcm.googleapis.com/fcm/send/device",
	p256dh: "p256",
	auth: "auth",
};

function probe(partial: Partial<PushProbe> = {}): PushProbe {
	return {
		inspect: () => "ok",
		readSubscription: async () => null,
		subscribe: async () => SUB,
		...partial,
	};
}

function renderCard(push: PushProbe, settings = SETTINGS) {
	const save = vi.fn(async (body: SaveNotificationSettings) => ({
		...settings,
		...body,
		saved: true,
		vapidPublicKey: settings.vapidPublicKey,
		subscriptionCount: settings.subscriptionCount,
	}));
	const testPush = vi.fn(async (endpoint: string) => ({ ok: endpoint.length > 0 }));
	const upsert = vi.fn(async () => ({ subscriptionCount: settings.subscriptionCount }));
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			const method = init?.method ?? "GET";
			const json = (body: unknown, status = 200) =>
				new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
			if (path === "/api/notifications" && method === "GET") return json(settings);
			if (path === "/api/notifications" && method === "PUT") {
				return json(await save(JSON.parse(String(init?.body)) as SaveNotificationSettings));
			}
			if (path === "/api/notifications/subscription") return json(await upsert());
			if (path === "/api/notifications/test") {
				await testPush(JSON.parse(String(init?.body)).endpoint);
				return json({ ok: true });
			}
			return json({}, 404);
		}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<DueReminderCard probe={push} />
		</QueryClientProvider>,
	);
	return { save, testPush, upsert };
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("due reminder settings", () => {
	it("does not request permission until the master switch is turned on", async () => {
		const subscribe = vi.fn(async () => SUB);
		const { save } = renderCard(probe({ subscribe }));
		await screen.findByRole("switch", { name: "到期提醒" });
		expect(subscribe).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("switch", { name: "到期提醒" }));
		await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(save).toHaveBeenCalled());
		expect(save.mock.calls[0]?.[0]).toMatchObject({ enabled: true, subscription: SUB });
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已保存"));
	});

	it("auto-saves a quarter-hour time and hides tomorrow's time until that switch is on", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const subscribe = vi.fn();
		const { save } = renderCard(probe({ subscribe }), { ...SETTINGS, enabled: true });
		await screen.findByRole("switch", { name: "到期提醒" });
		save.mockImplementation(async (body) => {
			await gate;
			return { ...SETTINGS, ...body, enabled: true, saved: true, vapidPublicKey: "test-public", subscriptionCount: 0 };
		});
		const time = screen.getByLabelText("推送时间");
		expect(time.querySelectorAll("option")).toHaveLength(96);
		expect(screen.queryByLabelText("明天的推送时间")).toBeNull();
		fireEvent.change(time, { target: { value: "09:15" } });
		expect(screen.getByRole("status").textContent).toContain("保存中");
		release();
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已保存"));
		expect(save).toHaveBeenCalledWith(expect.objectContaining({ digestTime: "09:15" }));
		expect(subscribe).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("switch", { name: "明天到期" }));
		expect(screen.getByLabelText("明天的推送时间")).toBeTruthy();
	});

	it("greys the children when the master switch is off but keeps them visible", async () => {
		renderCard(probe());
		await screen.findByRole("switch", { name: "到期提醒" });
		const time = screen.getByLabelText("推送时间") as HTMLSelectElement;
		expect(time.disabled).toBe(true);
		expect(time.isConnected).toBe(true);
		expect((screen.getByRole("switch", { name: "包含逾期" }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.queryByLabelText("明天的推送时间")).toBeNull();
		const master = screen.getByRole("switch", { name: "到期提醒" });
		expect(master.getAttribute("aria-disabled")).toBeNull();
		expect(master.className).toContain("bg-input");
		expect(master.className).toContain("border-muted-foreground");
		expect(master.className).not.toContain("opacity-50");
		expect(screen.getByRole("switch", { name: "明天到期" }).className).not.toContain("opacity-50");
		const children = document.querySelector("[data-children-disabled='true']");
		expect(children?.className).toContain("text-muted-foreground");
		expect(children?.className).not.toContain("opacity-50");
	});

	it("blocks the switch and points at the help text", async () => {
		const subscribe = vi.fn();
		renderCard(probe({ inspect: () => "ios-install", subscribe }));
		const sw = await screen.findByRole("switch", { name: "到期提醒" });
		expect(sw.getAttribute("aria-disabled")).toBe("true");
		expect(sw.className).not.toContain("opacity-50");
		expect(sw.className).toContain("border-muted-foreground");
		const help = document.getElementById(sw.getAttribute("aria-describedby") ?? "");
		expect(help?.textContent).toMatch(/添加到主屏幕/);
		expect(help?.querySelector("svg")).toBeTruthy();
		fireEvent.click(sw);
		expect(subscribe).not.toHaveBeenCalled();

		cleanup();
		renderCard(probe({ inspect: () => "denied", subscribe }));
		expect((await screen.findByRole("switch", { name: "到期提醒" })).getAttribute("aria-disabled")).toBe("true");
		expect(document.body.textContent).toMatch(/通知权限已被拒绝/);

		cleanup();
		renderCard(probe({ inspect: () => "unsupported", subscribe }));
		expect((await screen.findByRole("switch", { name: "到期提醒" })).getAttribute("aria-disabled")).toBe("true");
		expect(document.body.textContent).toMatch(/不支持网页推送/);
	});

	it("shows other devices and a test notification that reports 已发送", async () => {
		const { testPush } = renderCard(probe({ readSubscription: async () => SUB }), {
			...SETTINGS,
			enabled: true,
			subscriptionCount: 1,
		});
		await screen.findByRole("button", { name: "发一条测试通知" });
		expect(screen.queryByText(/其他/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "发一条测试通知" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "已发送" })).toBeTruthy());
		expect(testPush).toHaveBeenCalledWith(SUB.endpoint);

		cleanup();
		renderCard(probe({ readSubscription: async () => null }), { ...SETTINGS, enabled: true, subscriptionCount: 2 });
		expect(await screen.findByText("其他 2 台设备已开启")).toBeTruthy();
		expect(screen.getByRole("button", { name: "在这台设备上开启" })).toBeTruthy();
	});

	it("snaps the switch off and keeps an alert when subscribing fails", async () => {
		vi.stubGlobal("Notification", { permission: "granted" });
		const subscribe = vi
			.fn()
			.mockRejectedValueOnce(new Error("Registration failed - permission denied"))
			.mockResolvedValueOnce(SUB);
		const { save, upsert } = renderCard(probe({ subscribe }));
		const sw = await screen.findByRole("switch", { name: "到期提醒" });
		fireEvent.click(sw);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("开启失败，请重试");
		expect(sw.getAttribute("aria-checked")).toBe("false");
		expect(sw.getAttribute("aria-disabled")).toBeNull();
		expect(document.body.textContent).not.toMatch(/通知权限已被拒绝/);
		expect(save).not.toHaveBeenCalled();
		expect(upsert).not.toHaveBeenCalled();

		vi.useFakeTimers();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(screen.getByRole("alert").textContent).toContain("开启失败，请重试");
		vi.useRealTimers();

		fireEvent.click(screen.getByRole("switch", { name: "到期提醒" }));
		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		await waitFor(() =>
			expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("true"),
		);
		expect(save).toHaveBeenCalledTimes(1);
		expect(save.mock.calls[0]?.[0]).toMatchObject({ enabled: true, subscription: SUB });
	});

	it("shows the system-settings guidance when notification permission is denied", async () => {
		vi.stubGlobal("Notification", { permission: "denied" });
		const subscribe = vi.fn(async () => {
			throw new Error("Registration failed - permission denied");
		});
		const { save, upsert } = renderCard(probe({ subscribe }));
		fireEvent.click(await screen.findByRole("switch", { name: "到期提醒" }));
		await waitFor(() => expect(document.body.textContent).toMatch(/请到系统设置里允许此网站发送通知/));
		const sw = screen.getByRole("switch", { name: "到期提醒" });
		expect(sw.getAttribute("aria-checked")).toBe("false");
		expect(sw.getAttribute("aria-disabled")).toBe("true");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText("开启失败，请重试")).toBeNull();
		expect(save).not.toHaveBeenCalled();
		expect(upsert).not.toHaveBeenCalled();

		cleanup();
		const returned = vi.fn(async () => "denied" as const);
		const second = renderCard(probe({ subscribe: returned }));
		fireEvent.click(await screen.findByRole("switch", { name: "到期提醒" }));
		await waitFor(() => expect(document.body.textContent).toMatch(/请到系统设置里允许此网站发送通知/));
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("false");
		expect(screen.queryByText("开启失败，请重试")).toBeNull();
		expect(second.save).not.toHaveBeenCalled();
		expect(second.upsert).not.toHaveBeenCalled();
	});
});
