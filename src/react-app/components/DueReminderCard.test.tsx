// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, NotificationSettings, SaveNotificationSettings } from "../api";
import {
	clearPushSubscriptionOwner,
	PUSH_UNSUBSCRIBE_TIMEOUT_MS,
	resetPushUnsubscribeForTests,
	SIGN_OUT_REQUEST_TIMEOUT_MS,
	readPushSubscriptionOwner,
	reconcilePushSubscriptionForUser,
	unsubscribePushBounded,
	writePushSubscriptionOwner,
	type PushProbe,
	type PushSubscriptionKeys,
} from "../lib/push-client";
import { shellKeys } from "../lib/shell-keys";
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
	subscriptionEndpoints: [],
	vapidPublicKey: "test-public",
};

const SUB: PushSubscriptionKeys = {
	endpoint: "https://fcm.googleapis.com/fcm/send/device",
	p256dh: "p256",
	auth: "auth",
};

const OTHER_EP = "https://fcm.googleapis.com/fcm/send/other-device";

function probe(partial: Partial<PushProbe> = {}): PushProbe {
	return {
		inspect: () => "ok",
		readSubscription: async () => null,
		subscribe: async () => SUB,
		unsubscribe: async () => ({ status: "none" }),
		...partial,
	};
}

function renderCard(
	push: PushProbe,
	settings = SETTINGS,
	options?: {
		me?: Me;
		onMe?: () => Promise<Response> | Response;
		onDelete?: (endpoint: string) => Promise<Response> | Response;
	},
) {
	let currentCount = settings.subscriptionCount;
	let currentEndpoints = [...(settings.subscriptionEndpoints ?? [])];
	const save = vi.fn(async (body: SaveNotificationSettings): Promise<NotificationSettings> => {
		if (body.subscription) {
			if (!currentEndpoints.includes(body.subscription.endpoint)) {
				currentEndpoints = [...currentEndpoints, body.subscription.endpoint];
			}
			currentCount = Math.max(currentCount, currentEndpoints.length);
		}
		return {
			...settings,
			...body,
			saved: true,
			vapidPublicKey: settings.vapidPublicKey,
			subscriptionCount: currentCount,
			subscriptionEndpoints: currentEndpoints,
		};
	});
	const testPush = vi.fn(async (endpoint: string) => ({ ok: endpoint.length > 0 }));
	const upsert = vi.fn(async () => ({ subscriptionCount: Math.max(1, currentCount) }));
	const remove = vi.fn(async (endpoint: string) => {
		if (options?.onDelete) return options.onDelete(endpoint);
		currentCount = Math.max(0, currentCount - 1);
		return new Response(JSON.stringify({ subscriptionCount: currentCount, deleted: true }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			const method = init?.method ?? "GET";
			const json = (body: unknown, status = 200) =>
				new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
			if (path === "/api/me" && method === "GET") {
				if (options?.onMe) return options.onMe();
				if (options?.me) return json(options.me);
				return json({}, 404);
			}
			if (path === "/api/notifications" && method === "GET") return json(settings);
			if (path === "/api/notifications" && method === "PUT") {
				return json(await save(JSON.parse(String(init?.body)) as SaveNotificationSettings));
			}
			if (path === "/api/notifications/subscription" && method === "POST") {
				const res = await upsert();
				currentCount = res.subscriptionCount;
				return json(res);
			}
			if (path === "/api/notifications/subscription" && method === "DELETE") {
				const body = JSON.parse(String(init?.body)) as { endpoint: string };
				return remove(body.endpoint);
			}
			if (path === "/api/notifications/test") {
				await testPush(JSON.parse(String(init?.body)).endpoint);
				return json({ ok: true });
			}
			return json({}, 404);
		}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	if (options?.me && !options?.onMe) client.setQueryData(shellKeys.me, options.me);
	render(
		<QueryClientProvider client={client}>
			<DueReminderCard probe={push} />
		</QueryClientProvider>,
	);
	return { save, testPush, upsert, remove, client };
}

afterEach(() => {
	cleanup();
	localStorage.clear();
	clearPushSubscriptionOwner();
	resetPushUnsubscribeForTests();
	vi.unstubAllGlobals();
	vi.useRealTimers();
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
			subscriptionEndpoints: [SUB.endpoint],
		});
		await screen.findByRole("button", { name: "发一条测试通知" });
		expect(screen.queryByText(/其他/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "发一条测试通知" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "已发送" })).toBeTruthy());
		expect(testPush).toHaveBeenCalledWith(SUB.endpoint);

		cleanup();
		renderCard(probe({ readSubscription: async () => null }), {
			...SETTINGS,
			enabled: true,
			subscriptionCount: 2,
			subscriptionEndpoints: [OTHER_EP, "https://fcm.googleapis.com/fcm/send/other-2"],
		});
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

	function hold() {
		let release: () => void = () => {};
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { promise, release: () => release() };
	}

	function savedSettings(body: SaveNotificationSettings): NotificationSettings {
		return {
			...SETTINGS,
			...body,
			saved: true,
			vapidPublicKey: "test-public",
			subscriptionCount: body.subscription ? 1 : 0,
			subscriptionEndpoints: body.subscription ? [body.subscription.endpoint] : [],
		};
	}

	it("keeps the switch on and sends the edited time after the in-flight enable save settles", async () => {
		const first = hold();
		const second = hold();
		const { save } = renderCard(probe());
		save.mockImplementation(async (body) => {
			if (body.digestTime === "09:00") await first.promise;
			if (body.digestTime === "10:00") await second.promise;
			return savedSettings(body);
		});
		fireEvent.click(await screen.findByRole("switch", { name: "到期提醒" }));
		await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
		const opening = await screen.findByRole("button", { name: "正在开启这台设备…" });
		expect((opening as HTMLButtonElement).disabled).toBe(true);
		expect(screen.queryByRole("button", { name: "在这台设备上开启" })).toBeNull();
		expect((screen.getByLabelText("推送时间") as HTMLSelectElement).disabled).toBe(false);
		fireEvent.change(screen.getByLabelText("推送时间"), { target: { value: "10:00" } });
		expect(save).toHaveBeenCalledTimes(1);
		expect(save.mock.calls[0]?.[0]?.digestTime).toBe("09:00");
		await act(async () => {
			first.release();
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "在此设备关闭" })).toBeTruthy());
		expect(screen.queryByRole("button", { name: "在这台设备上开启" })).toBeNull();
		expect(screen.getByRole("status").textContent).toContain("保存中");
		await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
		expect(save.mock.calls[1]?.[0]?.digestTime).toBe("10:00");
		await act(async () => {
			second.release();
		});
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已保存"));
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("true");
		expect((screen.getByLabelText("推送时间") as HTMLSelectElement).value).toBe("10:00");
		expect(screen.queryByText("开启失败，请重试")).toBeNull();
		expect(screen.getByRole("button", { name: "在此设备关闭" })).toBeTruthy();
	});

	it("retries the latest time after the enable save fails and does not snap the switch off", async () => {
		const first = hold();
		const { save } = renderCard(probe());
		save.mockImplementation(async (body) => {
			if (save.mock.calls.length === 1) {
				await first.promise;
				throw new Error("服务器忙");
			}
			return savedSettings(body);
		});
		fireEvent.click(await screen.findByRole("switch", { name: "到期提醒" }));
		await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
		fireEvent.change(screen.getByLabelText("推送时间"), { target: { value: "10:00" } });
		await act(async () => {
			first.release();
		});
		await waitFor(() => expect(save.mock.calls.some((call) => call[0]?.digestTime === "10:00")).toBe(true));
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已保存"));
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("true");
		expect((screen.getByLabelText("推送时间") as HTMLSelectElement).value).toBe("10:00");
		expect(screen.queryByText("开启失败，请重试")).toBeNull();
		expect(screen.getByRole("button", { name: "在此设备关闭" })).toBeTruthy();
	});

	it("keeps the switch on and shows an error when the later time save keeps failing", async () => {
		const first = hold();
		const { save } = renderCard(probe());
		save.mockImplementation(async (body) => {
			if (body.digestTime === "09:00") {
				await first.promise;
				return savedSettings(body);
			}
			throw new Error("保存时间失败");
		});
		fireEvent.click(await screen.findByRole("switch", { name: "到期提醒" }));
		await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
		fireEvent.change(screen.getByLabelText("推送时间"), { target: { value: "10:00" } });
		await act(async () => {
			first.release();
		});
		expect(await screen.findByText("保存时间失败")).toBeTruthy();
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("true");
		expect((screen.getByLabelText("推送时间") as HTMLSelectElement).value).toBe("10:00");
		expect(screen.queryByText("开启失败，请重试")).toBeNull();
		expect(screen.getByRole("button", { name: "在此设备关闭" })).toBeTruthy();
	});

	it("snaps the master switch off when subscribe works but saving settings fails", async () => {
		vi.stubGlobal("Notification", { permission: "granted" });
		const { save, upsert } = renderCard(probe());
		save.mockImplementation(async () => {
			throw new Error("服务器忙");
		});
		fireEvent.click(await screen.findByRole("switch", { name: "到期提醒" }));
		await waitFor(() => {
			expect(document.body.textContent ?? "").toMatch(/服务器忙|开启失败，请重试/);
		});
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("false");
		expect(screen.queryByRole("button", { name: "在这台设备上开启" })).toBeNull();
		expect(upsert).not.toHaveBeenCalled();
		expect(save.mock.calls.length).toBeGreaterThan(1);
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

	it("turns off the master switch without deleting or unsubscribing this device", async () => {
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		const { save, remove } = renderCard(
			probe({ readSubscription: async () => SUB, unsubscribe }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 2, subscriptionEndpoints: [SUB.endpoint, OTHER_EP] },
		);
		const sw = await screen.findByRole("switch", { name: "到期提醒" });
		await screen.findByRole("button", { name: "在此设备关闭" });
		fireEvent.click(sw);
		await waitFor(() => expect(save).toHaveBeenCalled());
		expect(save.mock.calls[0]?.[0]).toMatchObject({ enabled: false });
		expect(save.mock.calls[0]?.[0]?.subscription).toBeUndefined();
		expect(remove).not.toHaveBeenCalled();
		expect(unsubscribe).not.toHaveBeenCalled();
	});

	it("disables push on this device only, keeps master switch and other devices, and allows re-enabling + testing", async () => {
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		const subscribe = vi.fn(async () => SUB);
		const { save, remove, upsert, testPush } = renderCard(
			probe({ readSubscription: async () => SUB, unsubscribe, subscribe }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 2, subscriptionEndpoints: [SUB.endpoint, OTHER_EP] },
		);
		const btn = await screen.findByRole("button", { name: "在此设备关闭" });
		fireEvent.click(btn);
		await waitFor(() => expect(remove).toHaveBeenCalledWith(SUB.endpoint));
		await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
		expect(unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
		expect(save).not.toHaveBeenCalled();
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("true");
		expect(await screen.findByText("其他 1 台设备已开启")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "在此设备关闭" })).toBeNull();
		expect(screen.queryByRole("button", { name: "发一条测试通知" })).toBeNull();
		expect(readPushSubscriptionOwner()).toBeNull();

		// 重新在此设备开启并发测试通知
		fireEvent.click(screen.getByRole("button", { name: "在这台设备上开启" }));
		await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
		await waitFor(() => expect(screen.getByRole("button", { name: "发一条测试通知" })).toBeTruthy());
		expect(upsert).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "发一条测试通知" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "已发送" })).toBeTruthy());
		expect(testPush).toHaveBeenCalledWith(SUB.endpoint);
	});

	it("still deletes on server without showing an error when browser unsubscribe fails, and avoids silently re-upserting on remount", async () => {
		const unsubscribe = vi.fn(async () => ({ status: "failed" as const, endpoint: SUB.endpoint }));
		const { remove } = renderCard(
			probe({ readSubscription: async () => SUB, unsubscribe }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 1, subscriptionEndpoints: [SUB.endpoint] },
		);
		fireEvent.click(await screen.findByRole("button", { name: "在此设备关闭" }));
		await waitFor(() => expect(remove).toHaveBeenCalledWith(SUB.endpoint));
		await waitFor(() => expect(screen.getByRole("button", { name: "在这台设备上开启" })).toBeTruthy());
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status").textContent).toContain("已保存");
		expect(readPushSubscriptionOwner()).toMatchObject({ endpoint: SUB.endpoint, pendingUnsubscribe: true });

		// 重新挂载时即使浏览器还残留订阅，也不会静默补回服务端，而是后台重试退订
		cleanup();
		const retryUnsub = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		const remount = renderCard(
			probe({ readSubscription: async () => SUB, unsubscribe: retryUnsub }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 0, subscriptionEndpoints: [] },
		);
		await screen.findByRole("button", { name: "在这台设备上开启" });
		await waitFor(() => expect(retryUnsub).toHaveBeenCalledOnce());
		expect(remount.upsert).not.toHaveBeenCalled();
		expect(readPushSubscriptionOwner()).toBeNull();
	});

	it("does not call DELETE until a stalled browser unsubscribe times out, then deletes only this device", async () => {
		const calls: string[] = [];
		const { remove } = renderCard(
			probe({
				readSubscription: async () => SUB,
				unsubscribe: () => {
					calls.push("browser");
					return new Promise(() => {});
				},
			}),
			{ ...SETTINGS, enabled: true, subscriptionCount: 2, subscriptionEndpoints: [SUB.endpoint, OTHER_EP] },
		);
		const btn = await screen.findByRole("button", { name: "在此设备关闭" });

		vi.useFakeTimers();
		fireEvent.click(btn);
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(remove).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "关闭中…" })).toBeTruthy();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PUSH_UNSUBSCRIBE_TIMEOUT_MS + 50);
		});
		expect(calls).toEqual(["browser"]);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledWith(SUB.endpoint);
		expect(screen.getByRole("button", { name: "在这台设备上开启" })).toBeTruthy();
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("true");
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status").textContent).toContain("已保存");
		expect(readPushSubscriptionOwner()).toMatchObject({ endpoint: SUB.endpoint, pendingUnsubscribe: true });
		expect(screen.getByText("其他 1 台设备已开启")).toBeTruthy();
	});

	it("does not subscribe while a previous unsubscribe is still unsettled, and the retry stays available", async () => {
		const subscribe = vi.fn(async () => SUB);
		let release: () => void = () => {};
		renderCard(probe({ readSubscription: async () => null, subscribe }), {
			...SETTINGS,
			enabled: true,
			subscriptionCount: 0,
			subscriptionEndpoints: [],
		});
		await screen.findByRole("button", { name: "在这台设备上开启" });
		const hung = unsubscribePushBounded(
			probe({
				unsubscribe: () =>
					new Promise((resolve) => {
						release = () => resolve({ status: "unsubscribed", endpoint: SUB.endpoint });
					}),
			}),
			SUB.endpoint,
			30,
		);
		vi.useFakeTimers();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(40);
		});
		await hung;
		fireEvent.click(screen.getByRole("button", { name: "在这台设备上开启" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(PUSH_UNSUBSCRIBE_TIMEOUT_MS + 20);
		});
		expect(screen.getByText("上一次退订还没结束，请稍后再试")).toBeTruthy();
		expect(subscribe).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "在这台设备上开启" })).toBeTruthy();
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("true");
		release();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});
		fireEvent.click(screen.getByRole("button", { name: "在这台设备上开启" }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10);
		});
		expect(subscribe).toHaveBeenCalledOnce();
	});

	it("shows an error and keeps the close button when DELETE times out after the browser unsubscribe", async () => {
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		const { remove } = renderCard(
			probe({ readSubscription: async () => SUB, unsubscribe }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 2, subscriptionEndpoints: [SUB.endpoint, OTHER_EP] },
			{ onDelete: () => new Promise(() => {}) },
		);
		const btn = await screen.findByRole("button", { name: "在此设备关闭" });
		vi.useFakeTimers();
		fireEvent.click(btn);
		await act(async () => {
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(SIGN_OUT_REQUEST_TIMEOUT_MS + 50);
		});
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledWith(SUB.endpoint);
		expect(screen.getByRole("button", { name: "在此设备关闭" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "在这台设备上开启" })).toBeNull();
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("true");
		expect(document.body.textContent).toContain("请求超时");
		expect(screen.queryByText("其他 1 台设备已开启")).toBeNull();
	});

	it("keeps the close button and shows an error when DELETE fails, then succeeds on retry", async () => {
		let failOnce = true;
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		const { remove } = renderCard(
			probe({ readSubscription: async () => SUB, unsubscribe }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 1, subscriptionEndpoints: [SUB.endpoint] },
			{
				onDelete: async () => {
					if (failOnce) {
						failOnce = false;
						return new Response(JSON.stringify({ message: "服务暂时不可用" }), {
							status: 500,
							headers: { "Content-Type": "application/json" },
						});
					}
					return new Response(JSON.stringify({ subscriptionCount: 0, deleted: true }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				},
			},
		);
		fireEvent.click(await screen.findByRole("button", { name: "在此设备关闭" }));
		await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]!);
		expect(await screen.findByText("服务暂时不可用")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain("保存失败");
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("true");
		expect(screen.getByRole("button", { name: "在此设备关闭" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "在这台设备上开启" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "在此设备关闭" }));
		await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(2));
		expect(unsubscribe.mock.invocationCallOrder[1]).toBeLessThan(remove.mock.invocationCallOrder[1]!);
		await waitFor(() => expect(screen.getByRole("button", { name: "在这台设备上开启" })).toBeTruthy());
		expect(screen.getByRole("switch", { name: "到期提醒" }).getAttribute("aria-checked")).toBe("true");
	});

	it("does not silently hijack a leftover browser subscription when localStorage is missing or userId is null and server does not own this endpoint", async () => {
		// 场景 1：localStorage 缺失，但新账号在其他设备有订阅（subscriptionCount = 1，endpoint 不同）
		const { upsert } = renderCard(
			probe({ readSubscription: async () => SUB }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 1, subscriptionEndpoints: [OTHER_EP] },
			{ me: { user: { id: "user-b", email: "b@example.com", name: "B" }, source: "human" } },
		);
		expect(await screen.findByText("其他 1 台设备已开启")).toBeTruthy();
		expect(screen.getByRole("button", { name: "在这台设备上开启" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "在此设备关闭" })).toBeNull();
		expect(upsert).not.toHaveBeenCalled();

		// 场景 2：localStorage 里 userId 为 null，同样绝不静默 upsert 接管
		cleanup();
		writePushSubscriptionOwner(null, SUB.endpoint);
		const second = renderCard(
			probe({ readSubscription: async () => SUB }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 1, subscriptionEndpoints: [OTHER_EP] },
			{ me: { user: { id: "user-b", email: "b@example.com", name: "B" }, source: "human" } },
		);
		expect(await screen.findByText("其他 1 台设备已开启")).toBeTruthy();
		expect(screen.getByRole("button", { name: "在这台设备上开启" })).toBeTruthy();
		expect(second.upsert).not.toHaveBeenCalled();
	});

	it("does not wrongly unsubscribe a valid browser subscription when gtd:push-owner records a different stale endpoint", async () => {
		writePushSubscriptionOwner("user-a", "https://fcm.googleapis.com/fcm/send/stale-old-ep");
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		renderCard(
			probe({ readSubscription: async () => SUB, unsubscribe }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 1, subscriptionEndpoints: [SUB.endpoint] },
			{ me: { user: { id: "user-b", email: "b@example.com", name: "B" }, source: "human" } },
		);
		expect(await screen.findByRole("button", { name: "在此设备关闭" })).toBeTruthy();
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(readPushSubscriptionOwner()).toEqual({
			userId: "user-b",
			endpoint: SUB.endpoint,
			pendingUnsubscribe: false,
		});
	});

	it("serializes Shell reconcilePushSubscriptionForUser with DueReminderCard mount probe so unsubscribe runs once and never re-upserts", async () => {
		writePushSubscriptionOwner("user-a", SUB.endpoint);
		let releaseUnsub: () => void = () => {};
		const unsubscribe = vi.fn(
			() =>
				new Promise<{ status: "unsubscribed"; endpoint: string }>((resolve) => {
					releaseUnsub = () => resolve({ status: "unsubscribed", endpoint: SUB.endpoint });
				}),
		);
		const sharedProbe = probe({ readSubscription: async () => SUB, unsubscribe });
		// 模拟 Shell 在同一轮 commit 里先发起 reconcile
		const shellReconcile = reconcilePushSubscriptionForUser("user-b", sharedProbe);
		const { upsert } = renderCard(
			sharedProbe,
			{ ...SETTINGS, enabled: true, subscriptionCount: 1, subscriptionEndpoints: [OTHER_EP] },
			{ me: { user: { id: "user-b", email: "b@example.com", name: "B" }, source: "human" } },
		);
		await screen.findByRole("switch", { name: "到期提醒" });
		await act(async () => {
			releaseUnsub();
			await shellReconcile;
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(upsert).not.toHaveBeenCalled();
		expect(readPushSubscriptionOwner()).toBeNull();
		expect(screen.getByRole("button", { name: "在这台设备上开启" })).toBeTruthy();
	});

	it("prevents Shell reconcile from unsubscribing a new subscription created by turnOn while /api/me was pending", async () => {
		writePushSubscriptionOwner("user-a", "https://fcm.googleapis.com/fcm/send/prev-user");
		let resolveMe: (res: Response) => void = () => {};
		const mePromise = new Promise<Response>((resolve) => {
			resolveMe = resolve;
		});
		let releaseSubscribe: () => void = () => {};
		const subscribe = vi.fn(
			() =>
				new Promise<PushSubscriptionKeys>((resolve) => {
					releaseSubscribe = () => resolve(SUB);
				}),
		);
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		const sharedProbe = probe({ subscribe, unsubscribe });
		renderCard(sharedProbe, SETTINGS, { onMe: () => mePromise });

		// /api/me 还在途时用户点击开启总开关
		fireEvent.click(await screen.findByRole("switch", { name: "到期提醒" }));
		await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

		// subscribe 还在途时 /api/me 返回 user-b，Shell 立即触发 reconcilePushSubscriptionForUser
		let reconcilePromise: Promise<unknown> = Promise.resolve();
		await act(async () => {
			resolveMe(
				new Response(
					JSON.stringify({ user: { id: "user-b", email: "b@example.com", name: "B" }, source: "human" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
			reconcilePromise = reconcilePushSubscriptionForUser("user-b", sharedProbe);
			await Promise.resolve();
		});

		// subscribe 完成并保存后，reconcile 不应退订刚创建的新订阅
		await act(async () => {
			releaseSubscribe();
			await reconcilePromise;
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "在此设备关闭" })).toBeTruthy());
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(readPushSubscriptionOwner()).toEqual({
			userId: "user-b",
			endpoint: SUB.endpoint,
			pendingUnsubscribe: false,
		});
	});

	it("does not silently hijack a leftover browser subscription owned by another account", async () => {
		writePushSubscriptionOwner("user-a", SUB.endpoint);
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		const { upsert } = renderCard(
			probe({ readSubscription: async () => SUB, unsubscribe }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 1 },
			{ me: { user: { id: "user-b", email: "b@example.com", name: "B" }, source: "human" } },
		);
		await screen.findByRole("button", { name: "在这台设备上开启" });
		await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
		expect(upsert).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "在此设备关闭" })).toBeNull();
	});

	it("waits for /api/me on cold start before checking push ownership so /api/notifications arriving first never hijacks another account's subscription", async () => {
		writePushSubscriptionOwner("user-a", SUB.endpoint);
		let resolveMe: (res: Response) => void = () => {};
		const mePromise = new Promise<Response>((resolve) => {
			resolveMe = resolve;
		});
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		const readSubscription = vi.fn(async () => SUB);
		const { upsert } = renderCard(
			probe({ readSubscription, unsubscribe }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 1 },
			{ onMe: () => mePromise },
		);

		// /api/notifications 已返回，但 /api/me 仍在途：此时绝不能把 user-a 的订阅 upsert 给当前账号
		await screen.findByRole("switch", { name: "到期提醒" });
		await act(async () => {
			await Promise.resolve();
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(upsert).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "在此设备关闭" })).toBeNull();

		// /api/me 晚到并返回 user-b：识别出跨账号残留，执行浏览器退订且绝不 upsert
		await act(async () => {
			resolveMe(
				new Response(
					JSON.stringify({ user: { id: "user-b", email: "b@example.com", name: "B" }, source: "human" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
			await Promise.resolve();
		});
		await waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
		expect(upsert).not.toHaveBeenCalled();
		expect(readPushSubscriptionOwner()).toBeNull();
		expect(screen.getByRole("button", { name: "在这台设备上开启" })).toBeTruthy();
	});

	it("fails closed without hijacking when /api/me fails and gtd:push-owner belongs to a recorded userId", async () => {
		writePushSubscriptionOwner("user-a", SUB.endpoint);
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		const { upsert } = renderCard(
			probe({ readSubscription: async () => SUB, unsubscribe }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 1 },
			{
				onMe: async () =>
					new Response(JSON.stringify({ message: "暂时不可用" }), {
						status: 503,
						headers: { "Content-Type": "application/json" },
					}),
			},
		);
		await screen.findByRole("button", { name: "在这台设备上开启" });
		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(upsert).not.toHaveBeenCalled();
		expect(unsubscribe).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "在此设备关闭" })).toBeNull();
	});

	it("backfills gtd:push-owner userId when /api/me resolves after turning on push", async () => {
		let resolveMe: (res: Response) => void = () => {};
		const mePromise = new Promise<Response>((resolve) => {
			resolveMe = resolve;
		});
		renderCard(probe({ subscribe: async () => SUB }), SETTINGS, { onMe: () => mePromise });
		fireEvent.click(await screen.findByRole("switch", { name: "到期提醒" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "在此设备关闭" })).toBeTruthy());
		expect(readPushSubscriptionOwner()).toMatchObject({ userId: null, endpoint: SUB.endpoint });

		await act(async () => {
			resolveMe(
				new Response(
					JSON.stringify({ user: { id: "user-b", email: "b@example.com", name: "B" }, source: "human" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
			await Promise.resolve();
		});
		await waitFor(() =>
			expect(readPushSubscriptionOwner()).toEqual({
				userId: "user-b",
				endpoint: SUB.endpoint,
				pendingUnsubscribe: false,
			}),
		);
	});

	it("ignores stale PUT subscriptionCount when the user disables this device while a time edit is in flight", async () => {
		let releasePut: () => void = () => {};
		const putGate = new Promise<void>((resolve) => {
			releasePut = resolve;
		});
		const unsubscribe = vi.fn(async () => ({ status: "unsubscribed" as const, endpoint: SUB.endpoint }));
		const { save, remove } = renderCard(
			probe({ readSubscription: async () => SUB, unsubscribe }),
			{ ...SETTINGS, enabled: true, subscriptionCount: 2, subscriptionEndpoints: [SUB.endpoint, OTHER_EP] },
		);
		await screen.findByRole("button", { name: "在此设备关闭" });

		save.mockImplementationOnce(async (body) => {
			await putGate;
			// 模拟先发出的 PUT 带回了删除前的旧 subscriptionCount: 2
			return { ...SETTINGS, ...body, enabled: true, saved: true, vapidPublicKey: "test-public", subscriptionCount: 2 };
		});

		fireEvent.change(screen.getByLabelText("推送时间"), { target: { value: "10:00" } });
		fireEvent.click(screen.getByRole("button", { name: "在此设备关闭" }));
		await waitFor(() => expect(remove).toHaveBeenCalledWith(SUB.endpoint));
		expect(await screen.findByText("其他 1 台设备已开启")).toBeTruthy();

		// 晚到的旧 PUT 返回后不应把计数覆盖回 2
		await act(async () => {
			releasePut();
			await Promise.resolve();
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 10));
		});
		expect(screen.getByText("其他 1 台设备已开启")).toBeTruthy();
		expect(screen.queryByText("其他 2 台设备已开启")).toBeNull();
	});
});
