import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
		// #99：尺寸对比测试只在真浏览器里跑（vitest.browser.config.ts / pnpm test:browser）。
		exclude: ["**/node_modules/**", "src/**/*.browser.test.tsx"],
	},
});
