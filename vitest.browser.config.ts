import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * #99：骨架 vs 真实组件的尺寸对比必须在真浏览器里跑（happy-dom 没有布局，高度全是 0）。
 * `pnpm test:browser`，CI 里单独一个 job。本地没装 Playwright 的 Chromium 时可用
 * PW_CHROMIUM_PATH=/usr/bin/google-chrome 指定。
 */
export default defineConfig({
	plugins: [react(), tailwindcss()],
	define: { __APP_COMMIT__: JSON.stringify("test") },
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	test: {
		include: ["src/**/*.browser.test.tsx"],
		browser: {
			enabled: true,
			headless: true,
			provider: playwright({
				launchOptions: process.env.PW_CHROMIUM_PATH
					? { executablePath: process.env.PW_CHROMIUM_PATH }
					: {},
			}),
			instances: [{ browser: "chromium" }],
		},
	},
});
