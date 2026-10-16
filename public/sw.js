/* #123 到期提醒。只处理推送和点击，不拦截 fetch，不做缓存。点击一律打开 /today。 */
self.addEventListener("push", (event) => {
	let title = "到期提醒";
	let body = "";
	try {
		if (event.data) {
			const payload = event.data.json();
			if (typeof payload.title === "string" && payload.title) title = payload.title;
			if (typeof payload.body === "string") body = payload.body;
		}
	} catch {
		body = event.data ? event.data.text() : "";
	}
	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			icon: "/icon-192.png",
			data: { url: "/today" },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = new URL("/today", self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const client of windows) {
				if ("focus" in client) {
					if ("navigate" in client) {
						try {
							await client.navigate(target);
						} catch {
							/* 旧浏览器没有 navigate，下面 openWindow。 */
						}
					}
					return client.focus();
				}
			}
			return self.clients.openWindow(target);
		})(),
	);
});
