/**
 * #88：检查 GitHub Actions workflow 文档（已经用 YAML 解析成对象）。
 * 不执行 workflow，只看步骤顺序和会把失败绕过去的条件。
 *
 * 生产 deploy 必须先有远程 D1 migration（`wrangler d1 migrations apply … --remote`）：
 * 要么在同一个 job 里排在 deploy 前面，要么 deploy 所在 job `needs` migration 所在 job。
 * migration 步骤不能 `continue-on-error: true`，也不能自带 `if:`（被跳过后 deploy 仍会跑）。
 * migration 步骤的 `run` 不能用 `|| true`、`|| :`、结尾的 `; true`、`set +e` 把失败吞掉。
 * deploy 步骤和它所在的 job 不能用 `always()` / `failure()` / `cancelled()`。
 */

const BYPASS_STATUS = /\b(?:always|failure|cancelled)\s*\(/;

type Job = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandText(step: Record<string, unknown>): string {
	const parts: string[] = [];
	if (typeof step.run === "string") parts.push(step.run);
	if (isRecord(step.with) && typeof step.with.command === "string") parts.push(step.with.command);
	return parts.join("\n");
}

function isRemoteMigrateText(text: string): boolean {
	return text.includes("d1 migrations apply") && /(^|\s)--remote(?=$|[\s;|&])/.test(text);
}

export function isRemoteMigrateStep(step: unknown): step is Record<string, unknown> {
	return isRecord(step) && isRemoteMigrateText(commandText(step));
}

export function isDeployStep(step: unknown): step is Record<string, unknown> {
	if (!isRecord(step)) return false;
	const text = commandText(step);
	if (isRemoteMigrateText(text) || text.includes("--dry-run")) return false;
	const uses = typeof step.uses === "string" ? step.uses : "";
	if (uses.includes("wrangler-action")) {
		const command = isRecord(step.with) && typeof step.with.command === "string" ? step.with.command.trim() : "";
		return command === "" || /^deploy(\s|$)/.test(command);
	}
	return /(^|[\n;&|])\s*(?:pnpm(?:\s+exec)?\s+)?wrangler\s+deploy(\s|$)/.test(text);
}

function isContinueOnError(value: unknown): boolean {
	return value === true || value === "true";
}

function needsOf(job: Job): string[] {
	const needs = job.needs;
	if (typeof needs === "string") return [needs];
	if (!Array.isArray(needs)) return [];
	return needs.filter((item): item is string => typeof item === "string");
}

function assertNoBypass(condition: unknown, where: string): void {
	if (condition == null) return;
	const text = typeof condition === "string" ? condition : JSON.stringify(condition);
	if (BYPASS_STATUS.test(text)) {
		throw new Error(`${where} 不能使用 always()/failure()/cancelled() 绕过失败`);
	}
}

function swallowsFailure(run: string): boolean {
	const text = run.trim();
	if (/\|\|\s*true\b/.test(text)) return true;
	if (/\|\|\s*:/.test(text)) return true;
	if (/;\s*true\s*$/.test(text)) return true;
	if (/set\s+\+[a-zA-Z]*e/.test(text)) return true;
	if (/set\s+\+o\s+errexit\b/.test(text)) return true;
	return false;
}

function assertMigrateStep(step: Record<string, unknown>): void {
	if (isContinueOnError(step["continue-on-error"])) {
		throw new Error("migration 步骤不能设置 continue-on-error: true");
	}
	if ("if" in step) {
		throw new Error("migration 步骤不能设置 if:，被跳过后仍会继续 deploy");
	}
	if (typeof step.run === "string" && swallowsFailure(step.run)) {
		throw new Error("migration 步骤的 run 不能吞掉命令失败");
	}
}

function jobsOf(workflow: unknown): Map<string, Job> {
	if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
		throw new Error("workflow 必须有 jobs");
	}
	const jobs = new Map<string, Job>();
	for (const [id, job] of Object.entries(workflow.jobs)) {
		if (!isRecord(job)) throw new Error(`job ${id} 必须是 mapping`);
		jobs.set(id, job);
	}
	return jobs;
}

export function assertMigrationPrecedesDeploy(workflow: unknown): void {
	const jobs = jobsOf(workflow);
	const deploys: { jobId: string; job: Job; index: number }[] = [];
	for (const [jobId, job] of jobs) {
		const steps = Array.isArray(job.steps) ? job.steps : [];
		steps.forEach((step, index) => {
			if (isDeployStep(step)) deploys.push({ jobId, job, index });
		});
	}
	if (deploys.length !== 1) {
		throw new Error(`生产 workflow 必须恰好有一个 deploy 步骤，实际有 ${deploys.length} 个`);
	}

	const deploy = deploys[0];
	assertNoBypass(deploy.job.if, `job ${deploy.jobId}`);
	const deployStep = (deploy.job.steps as unknown[])[deploy.index];
	if (!isRecord(deployStep)) throw new Error(`job ${deploy.jobId} 的 deploy 步骤无效`);
	assertNoBypass(deployStep.if, `deploy 步骤（job ${deploy.jobId}）`);

	const steps = Array.isArray(deploy.job.steps) ? deploy.job.steps : [];
	const prior = steps.slice(0, deploy.index).filter(isRemoteMigrateStep);
	if (prior.length > 0) {
		for (const step of prior) assertMigrateStep(step);
		return;
	}

	const migrateJobs = needsOf(deploy.job).flatMap((id) => {
		const job = jobs.get(id);
		if (!job) throw new Error(`job ${deploy.jobId} needs 未知 job ${id}`);
		const migrateSteps = (Array.isArray(job.steps) ? job.steps : []).filter(isRemoteMigrateStep);
		return migrateSteps.length > 0 ? [{ id, job, migrateSteps }] : [];
	});
	if (migrateJobs.length === 0) {
		throw new Error("远程 migration 必须在 deploy 之前（同一 job 内靠前，或 deploy 所在 job needs migration 所在 job）");
	}
	for (const { id, job, migrateSteps } of migrateJobs) {
		if (isContinueOnError(job["continue-on-error"])) {
			throw new Error(`job ${id} 设置了 continue-on-error，migration 失败仍会继续 deploy`);
		}
		for (const step of migrateSteps) assertMigrateStep(step);
	}
}
