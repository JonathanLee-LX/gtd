import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TEMP #89 diagnostics — remove after root cause found：前端诊断上报带上构建 commit。
function buildCommit(): string {
	const fromEnv = process.env.GITHUB_SHA || process.env.WORKERS_CI_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA;
	if (fromEnv) return fromEnv.slice(0, 12);
	try {
		return execSync("git rev-parse --short=12 HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		return "";
	}
}

export default defineConfig({
	plugins: [react(), tailwindcss(), cloudflare()],
	// TEMP #89 diagnostics — remove after root cause found
	define: {
		__APP_COMMIT__: JSON.stringify(buildCommit()),
	},
	server: {
		watch: {
			ignored: ["**/src-tauri/**"],
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
});
