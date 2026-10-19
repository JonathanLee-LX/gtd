import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { assertMigrationPrecedesDeploy, isDeployStep, isRemoteMigrateStep } from "./deploy-order";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function readWorkflow(name: string): unknown {
	return parse(readFileSync(resolve(root, ".github/workflows", name), "utf8"));
}

function jobsOf(workflow: unknown): Record<string, { if?: unknown; needs?: unknown; steps?: unknown[]; "continue-on-error"?: unknown }> {
	const jobs = (workflow as { jobs?: unknown }).jobs;
	if (typeof jobs !== "object" || jobs === null) throw new Error("missing jobs");
	return jobs as Record<string, { if?: unknown; steps?: unknown[] }>;
}

describe("deploy.yml migration 必须先于 deploy", () => {
	it("解析真实 deploy.yml：顺序、失败不能绕过、冒烟检查还在", () => {
		const workflow = readWorkflow("deploy.yml");
		expect(() => assertMigrationPrecedesDeploy(workflow)).not.toThrow();

		const deploy = jobsOf(workflow).deploy;
		expect(deploy.needs).toBe("check");
		expect(deploy["continue-on-error"]).toBeUndefined();
		const jobIf = String(deploy.if);
		expect(jobIf).toContain("success()");
		expect(jobIf).toContain("github.event_name == 'push'");
		expect(jobIf).toContain("github.event_name == 'workflow_dispatch'");
		expect(jobIf).not.toMatch(/\b(?:always|failure|cancelled)\s*\(/);

		const steps = deploy.steps ?? [];
		const migrateAt = steps.findIndex(isRemoteMigrateStep);
		const deployAt = steps.findIndex(isDeployStep);
		expect(migrateAt).toBeGreaterThanOrEqual(0);
		expect(deployAt).toBeGreaterThan(migrateAt);
		const migrate = steps[migrateAt] as { run?: string; if?: unknown; "continue-on-error"?: unknown };
		expect(migrate.run).toContain("pnpm exec wrangler d1 migrations apply gtd --remote");
		expect(migrate["continue-on-error"]).toBeUndefined();
		expect(migrate.if).toBeUndefined();
		const deployStep = steps[deployAt] as { if?: unknown; uses?: string; with?: { command?: string } };
		expect(deployStep.if).toBeUndefined();
		expect(deployStep.uses).toContain("cloudflare/wrangler-action");
		expect(deployStep.with?.command).toBe("deploy");

		const smokeAt = steps.findIndex((step) => {
			const run = (step as { run?: unknown }).run;
			return typeof run === "string" && run.includes("https://gtd.livs.top/api/health") && run.includes("remote-");
		});
		expect(smokeAt).toBeGreaterThan(deployAt);
	});

	it("needs：migration 在前一个 job 里也可以", () => {
		const workflow = parse(`
jobs:
  migrate:
    steps:
      - name: Apply D1 migrations
        run: pnpm exec wrangler d1 migrations apply gtd --remote
  deploy:
    needs: migrate
    if: success() && github.ref == 'refs/heads/main'
    steps:
      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v4
        with:
          command: deploy
`);
		expect(() => assertMigrationPrecedesDeploy(workflow)).not.toThrow();
	});

	it("反例：故意写错的 yaml 片段会被同一个检查函数拒绝", () => {
		const cases: { name: string; yaml: string; message: RegExp }[] = [
			{
				name: "deploy 写在 migration 前面",
				message: /远程 migration 必须在 deploy 之前/,
				yaml: `
jobs:
  ship:
    steps:
      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v4
        with:
          command: deploy
      - name: Apply D1 migrations
        run: pnpm exec wrangler d1 migrations apply gtd --remote
`,
			},
			{
				name: "migration continue-on-error",
				message: /continue-on-error: true/,
				yaml: `
jobs:
  ship:
    steps:
      - name: Apply D1 migrations
        continue-on-error: true
        run: pnpm exec wrangler d1 migrations apply gtd --remote
      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v4
        with:
          command: deploy
`,
			},
			{
				name: "deploy 步骤 if always()",
				message: /always\(\)\/failure\(\)\/cancelled\(\)/,
				yaml: `
jobs:
  ship:
    steps:
      - name: Apply D1 migrations
        run: pnpm exec wrangler d1 migrations apply gtd --remote
      - name: Deploy Worker
        if: always()
        uses: cloudflare/wrangler-action@v4
        with:
          command: deploy
`,
			},
			{
				name: "deploy job if failure()",
				message: /always\(\)\/failure\(\)\/cancelled\(\)/,
				yaml: `
jobs:
  ship:
    if: failure()
    steps:
      - name: Apply D1 migrations
        run: pnpm exec wrangler d1 migrations apply gtd --remote
      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v4
        with:
          command: deploy
`,
			},
		];

		for (const item of cases) {
			expect(() => assertMigrationPrecedesDeploy(parse(item.yaml)), item.name).toThrow(item.message);
		}
	});

	it("反例：migration 步骤自己带 if 会被拒绝", () => {
		const workflow = parse(`
jobs:
  ship:
    steps:
      - name: Apply D1 migrations
        if: success()
        run: pnpm exec wrangler d1 migrations apply gtd --remote
      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v4
        with:
          command: deploy
`);
		expect(() => assertMigrationPrecedesDeploy(workflow)).toThrow(/不能设置 if:/);
	});

	it("反例：migration 步骤吞掉失败会被拒绝", () => {
		const runs = [
			"pnpm exec wrangler d1 migrations apply gtd --remote || true",
			"pnpm exec wrangler d1 migrations apply gtd --remote || :",
			"pnpm exec wrangler d1 migrations apply gtd --remote; true",
			"set +e\npnpm exec wrangler d1 migrations apply gtd --remote",
			"set +euo pipefail\npnpm exec wrangler d1 migrations apply gtd --remote",
		];
		for (const run of runs) {
			const workflow = parse(`
jobs:
  ship:
    steps:
      - name: Apply D1 migrations
        run: ${JSON.stringify(run)}
      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v4
        with:
          command: deploy
`);
			expect(() => assertMigrationPrecedesDeploy(workflow), run).toThrow(/不能吞掉命令失败/);
		}
	});
});

describe("本地坏 migration", () => {
	const script = resolve(root, "scripts/broken-local-migration.sh");

	function run(sql?: string) {
		const env: NodeJS.ProcessEnv = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" };
		delete env.CLOUDFLARE_API_TOKEN;
		delete env.CLOUDFLARE_ACCOUNT_ID;
		delete env.CLOUDFLARE_API_KEY;
		if (sql !== undefined) env.MIGRATION_SQL = sql;
		return spawnSync("bash", [script], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
	}

	it("脚本只跑本地假库", () => {
		const text = readFileSync(script, "utf8");
		const prod = JSON.parse(readFileSync(resolve(root, "wrangler.json"), "utf8")) as {
			d1_databases: { database_id: string; database_name: string }[];
		};
		expect(text).toContain("--local");
		expect(text).toContain("gtd-migrate-fail-demo");
		expect(text).toContain("00000000-0000-0000-0000-000000000000");
		expect(text).not.toContain("--remote");
		expect(text).not.toContain(prod.d1_databases[0].database_id);
		expect(prod.d1_databases[0].database_name).toBe("gtd");
	});

	it("语法错误的 SQL 非零退出，且命令参数不含 --remote", () => {
		const invocation = wranglerInvocation(readFileSync(script, "utf8"));
		expect(invocation).toContain("d1 migrations apply");
		expect(invocation).toContain("--local");
		expect(invocation).not.toContain("--remote");
		const bad = run();
		expect(bad.status, `${bad.stdout}\n${bad.stderr}`).not.toBe(0);
	}, 60_000);

	it("同一条命令遇到合法 SQL 会成功，说明非零退出来自坏 migration", () => {
		const ok = run("CREATE TABLE IF NOT EXISTS migrate_fail_demo (id INTEGER PRIMARY KEY);");
		expect(ok.status, `${ok.stdout}\n${ok.stderr}`).toBe(0);
	}, 60_000);
});

function wranglerInvocation(scriptText: string): string {
	const lines = scriptText.split("\n");
	const start = lines.findIndex((line) => line.includes("wrangler d1 migrations apply"));
	if (start < 0) throw new Error("missing wrangler invocation");
	const parts = [lines[start]];
	for (let i = start; i < lines.length - 1 && lines[i].trimEnd().endsWith("\\"); i += 1) {
		parts.push(lines[i + 1]);
	}
	return parts.join(" ");
}

describe("migration-failure-demo.yml", () => {
	it("只手动触发，deploy 步骤换成 echo，且不连生产", () => {
		const raw = readFileSync(resolve(root, ".github/workflows/migration-failure-demo.yml"), "utf8");
		const workflow = parse(raw) as {
			on?: Record<string, unknown>;
			jobs?: Record<
				string,
				{
					"continue-on-error"?: unknown;
					steps?: { name?: string; run?: string; uses?: string; if?: unknown; "continue-on-error"?: unknown }[];
				}
			>;
		};
		expect(workflow.on && Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
		expect(workflow.on?.push).toBeUndefined();
		expect(workflow.on?.pull_request).toBeUndefined();

		const job = workflow.jobs?.["broken-migration"];
		expect(job?.["continue-on-error"]).toBeUndefined();
		const steps = job?.steps ?? [];
		const migrateAt = steps.findIndex((step) => step.name === "Apply D1 migrations");
		const buildAt = steps.findIndex((step) => step.name === "Build");
		const deployAt = steps.findIndex((step) => step.name === "Deploy Worker");
		const assertAt = steps.findIndex((step) => step.name === "Assert deploy was skipped");
		expect(migrateAt).toBeGreaterThanOrEqual(0);
		expect(buildAt).toBeGreaterThan(migrateAt);
		expect(deployAt).toBeGreaterThan(buildAt);
		expect(assertAt).toBeGreaterThan(deployAt);
		expect(steps[migrateAt]?.run).toContain("scripts/broken-local-migration.sh");
		expect(String(steps[buildAt]?.if)).toContain("steps.migrate.outcome");
		expect(steps[buildAt]?.run).toContain("pnpm exec vite build");
		expect(String(steps[deployAt]?.if)).toContain("steps.migrate.outcome");
		expect(steps[deployAt]?.run).toContain("echo ");
		expect(steps[deployAt]?.uses).toBeUndefined();
		expect(steps[assertAt]?.run).toContain('test "${{ steps.deploy.outcome }}" = "skipped"');
		expect(raw).not.toContain("--remote");
		expect(raw).not.toContain("wrangler-action");
		expect(raw).not.toContain("wrangler deploy");
		const prodId = (
			JSON.parse(readFileSync(resolve(root, "wrangler.json"), "utf8")) as {
				d1_databases: { database_id: string }[];
			}
		).d1_databases[0].database_id;
		expect(raw).not.toContain(prodId);
	});
});
