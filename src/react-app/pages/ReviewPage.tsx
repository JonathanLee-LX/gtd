import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
	CheckCircle2Icon,
	ClipboardCheckIcon,
	FolderIcon,
	InboxIcon,
	CloudyIcon,
	ClockIcon,
} from "lucide-react";
import { toast } from "sonner";
import { api, type Project, type Task } from "../api";

type StepId = "inbox" | "waiting" | "someday" | "projects" | "done";

const STEPS: { id: StepId; label: string }[] = [
	{ id: "inbox", label: "清收件箱" },
	{ id: "waiting", label: "检查等待" },
	{ id: "someday", label: "审视将来" },
	{ id: "projects", label: "项目下一步" },
	{ id: "done", label: "完成" },
];

async function fetchAllByStatus(status: string): Promise<Task[]> {
	const items: Task[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await api.tasks({ status, cursor, limit: "100" });
		items.push(...page.items);
		if (!page.nextCursor) break;
		cursor = page.nextCursor;
	}
	return items;
}

export function ReviewPage() {
	const { projects } = useOutletContext<{ projects: Project[] }>();
	const activeProjects = useMemo(
		() => projects.filter((p) => !p.isInbox && !p.archivedAt),
		[projects],
	);

	const [step, setStep] = useState<StepId>("inbox");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [inbox, setInbox] = useState<Task[]>([]);
	const [waiting, setWaiting] = useState<Task[]>([]);
	const [someday, setSomeday] = useState<Task[]>([]);
	const [nextByProject, setNextByProject] = useState<Record<string, number>>({});
	const [inboxProjectId, setInboxProjectId] = useState<Record<string, string>>({});

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [inboxItems, waitingItems, somedayItems, nextItems] = await Promise.all([
				fetchAllByStatus("inbox"),
				fetchAllByStatus("waiting"),
				fetchAllByStatus("someday"),
				fetchAllByStatus("next"),
			]);
			setInbox(inboxItems);
			setWaiting(waitingItems);
			setSomeday(somedayItems);
			const counts: Record<string, number> = {};
			for (const task of nextItems) {
				counts[task.projectId] = (counts[task.projectId] ?? 0) + 1;
			}
			setNextByProject(counts);
			setInboxProjectId((prev) => {
				const next = { ...prev };
				for (const task of inboxItems) {
					if (!next[task.id]) next[task.id] = task.projectId;
				}
				return next;
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "加载失败");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const stepIndex = STEPS.findIndex((s) => s.id === step);
	const projectsMissingNext = activeProjects.filter((p) => (nextByProject[p.id] ?? 0) < 1);

	async function patchTask(id: string, body: Record<string, unknown>) {
		setBusy(true);
		try {
			await api.updateTask(id, body);
			await load();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "更新失败");
		} finally {
			setBusy(false);
		}
	}

	async function createNextForProject(projectId: string) {
		const title = window.prompt("为这个项目写一条下一步行动：");
		if (!title?.trim()) return;
		setBusy(true);
		try {
			await api.createTask({ title: title.trim(), projectId, status: "next" });
			toast.success("已添加下一步");
			await load();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "创建失败");
		} finally {
			setBusy(false);
		}
	}

	function goNext() {
		const next = STEPS[stepIndex + 1];
		if (next) setStep(next.id);
	}

	function goPrev() {
		const prev = STEPS[stepIndex - 1];
		if (prev) setStep(prev.id);
	}

	if (loading && inbox.length + waiting.length + someday.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center gap-3 p-6 text-muted-foreground">
				<Spinner />
				加载周回顾…
			</div>
		);
	}

	if (error) {
		return (
			<p className="p-6 text-sm text-destructive" role="alert">
				{error}
			</p>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
			<header className="mb-6 flex flex-col gap-1">
				<h1 className="font-heading text-2xl tracking-tight">周回顾</h1>
				<p className="text-sm text-muted-foreground">
					按顺序清零收件箱、检查等待与将来，并确认每个项目都有下一步。
				</p>
			</header>

			<ol className="mb-6 flex flex-wrap gap-2">
				{STEPS.filter((s) => s.id !== "done").map((s, i) => {
					const active = s.id === step;
					const done = STEPS.findIndex((x) => x.id === step) > i;
					return (
						<li key={s.id}>
							<button
								type="button"
								onClick={() => setStep(s.id)}
								className={`rounded-full px-3 py-1 text-sm ${
									active
										? "bg-primary text-primary-foreground"
										: done
											? "bg-muted text-foreground"
											: "bg-muted/50 text-muted-foreground"
								}`}
							>
								{i + 1}. {s.label}
							</button>
						</li>
					);
				})}
			</ol>

			{step === "inbox" ? (
				<section className="flex flex-col gap-4">
					<div className="flex items-center justify-between gap-2">
						<div>
							<h2 className="text-lg font-medium">1. 清收件箱</h2>
							<p className="text-sm text-muted-foreground">
								逐条整理成项目 / 下一步 / 等待 / 将来，或丢掉。剩 {inbox.length} 条。
							</p>
						</div>
						<Badge variant="outline">{inbox.length}</Badge>
					</div>
					{inbox.length === 0 ? (
						<Empty className="border">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<InboxIcon />
								</EmptyMedia>
								<EmptyTitle>收件箱已清空</EmptyTitle>
								<EmptyDescription>可以进入下一步检查等待中的事项。</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<ul className="flex flex-col gap-3">
							{inbox.map((task) => {
								const projectItems = projects.map((p) => ({
									value: p.id,
									label: p.name,
								}));
								const selectedProject = inboxProjectId[task.id] ?? task.projectId;
								return (
									<li
										key={task.id}
										className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between"
									>
										<div className="min-w-0">
											<p className="font-medium">{task.title}</p>
											{task.notes ? (
												<p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
													{task.notes}
												</p>
											) : null}
											<div className="mt-2 max-w-xs">
												<Select
													items={projectItems}
													value={selectedProject}
													onValueChange={(value) =>
														setInboxProjectId((prev) => ({
															...prev,
															[task.id]: String(value),
														}))
													}
												>
													<SelectTrigger className="w-full">
														<SelectValue placeholder="放到哪个项目" />
													</SelectTrigger>
													<SelectContent>
														<SelectGroup>
															{projectItems.map((item) => (
																<SelectItem key={item.value} value={item.value}>
																	{item.label}
																</SelectItem>
															))}
														</SelectGroup>
													</SelectContent>
												</Select>
											</div>
										</div>
										<div className="flex flex-wrap gap-2">
											<Button
												size="sm"
												disabled={busy}
												onClick={() =>
													void patchTask(task.id, {
														status: "next",
														projectId: selectedProject,
													})
												}
											>
												下一步
											</Button>
											<Button
												size="sm"
												variant="secondary"
												disabled={busy}
												onClick={() =>
													void patchTask(task.id, {
														status: "waiting",
														projectId: selectedProject,
													})
												}
											>
												等待
											</Button>
											<Button
												size="sm"
												variant="secondary"
												disabled={busy}
												onClick={() =>
													void patchTask(task.id, {
														status: "someday",
														projectId: selectedProject,
													})
												}
											>
												将来
											</Button>
											<Button
												size="sm"
												variant="outline"
												disabled={busy}
												onClick={() =>
													void patchTask(task.id, {
														projectId: selectedProject,
													})
												}
											>
												仅归项目
											</Button>
											<Button
												size="sm"
												variant="ghost"
												disabled={busy}
												onClick={() =>
													void patchTask(task.id, { status: "cancelled" })
												}
											>
												丢掉
											</Button>
										</div>
									</li>
								);
							})}
						</ul>
					)}
				</section>
			) : null}

			{step === "waiting" ? (
				<section className="flex flex-col gap-4">
					<div className="flex items-center justify-between gap-2">
						<div>
							<h2 className="text-lg font-medium">2. 检查等待</h2>
							<p className="text-sm text-muted-foreground">
								还在等吗？要不要催一催，或改回下一步。共 {waiting.length} 条。
							</p>
						</div>
						<Badge variant="outline">{waiting.length}</Badge>
					</div>
					{waiting.length === 0 ? (
						<Empty className="border">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ClockIcon />
								</EmptyMedia>
								<EmptyTitle>没有等待中的任务</EmptyTitle>
								<EmptyDescription>继续审视「将来 / 也许」。</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<ul className="flex flex-col gap-3">
							{waiting.map((task) => (
								<li
									key={task.id}
									className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between"
								>
									<div className="min-w-0">
										<p className="font-medium">{task.title}</p>
										<p className="mt-1 text-sm text-muted-foreground">
											{task.waitingOn ? `等：${task.waitingOn}` : "未填写等待对象"}
											{task.projectName ? ` · ${task.projectName}` : ""}
										</p>
									</div>
									<div className="flex flex-wrap gap-2">
										<Button
											size="sm"
											variant="secondary"
											disabled={busy}
											onClick={() => {
												toast.message("记得去催一下", {
													description: task.waitingOn
														? `对象：${task.waitingOn}`
														: task.title,
												});
											}}
										>
											要催
										</Button>
										<Button
											size="sm"
											variant="outline"
											disabled={busy}
											onClick={() => toast.success("继续等待")}
										>
											继续等
										</Button>
										<Button
											size="sm"
											disabled={busy}
											onClick={() => void patchTask(task.id, { status: "next" })}
										>
											改下一步
										</Button>
										<Button
											size="sm"
											variant="ghost"
											disabled={busy}
											onClick={() =>
												void patchTask(task.id, { status: "cancelled" })
											}
										>
											取消
										</Button>
									</div>
								</li>
							))}
						</ul>
					)}
				</section>
			) : null}

			{step === "someday" ? (
				<section className="flex flex-col gap-4">
					<div className="flex items-center justify-between gap-2">
						<div>
							<h2 className="text-lg font-medium">3. 审视将来</h2>
							<p className="text-sm text-muted-foreground">
								有没有该升成下一步的？共 {someday.length} 条。
							</p>
						</div>
						<Badge variant="outline">{someday.length}</Badge>
					</div>
					{someday.length === 0 ? (
						<Empty className="border">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<CloudyIcon />
								</EmptyMedia>
								<EmptyTitle>将来列表是空的</EmptyTitle>
								<EmptyDescription>接着核对各项目是否有下一步。</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<ul className="flex flex-col gap-3">
							{someday.map((task) => (
								<li
									key={task.id}
									className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between"
								>
									<div className="min-w-0">
										<p className="font-medium">{task.title}</p>
										{task.projectName ? (
											<p className="mt-1 text-sm text-muted-foreground">
												{task.projectName}
											</p>
										) : null}
									</div>
									<div className="flex flex-wrap gap-2">
										<Button
											size="sm"
											disabled={busy}
											onClick={() => void patchTask(task.id, { status: "next" })}
										>
											升成下一步
										</Button>
										<Button
											size="sm"
											variant="outline"
											disabled={busy}
											onClick={() => toast.success("仍放将来")}
										>
											仍放将来
										</Button>
										<Button
											size="sm"
											variant="ghost"
											disabled={busy}
											onClick={() =>
												void patchTask(task.id, { status: "cancelled" })
											}
										>
											丢掉
										</Button>
									</div>
								</li>
							))}
						</ul>
					)}
				</section>
			) : null}

			{step === "projects" ? (
				<section className="flex flex-col gap-4">
					<div className="flex items-center justify-between gap-2">
						<div>
							<h2 className="text-lg font-medium">4. 项目下一步</h2>
							<p className="text-sm text-muted-foreground">
								每个进行中的项目至少要有一条 next。缺下一步的项目 {projectsMissingNext.length}{" "}
								个。
							</p>
						</div>
						<Badge variant="outline">{projectsMissingNext.length}</Badge>
					</div>
					{activeProjects.length === 0 ? (
						<Empty className="border">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<FolderIcon />
								</EmptyMedia>
								<EmptyTitle>还没有项目</EmptyTitle>
								<EmptyDescription>可以在侧栏新建项目后再回来核对。</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : projectsMissingNext.length === 0 ? (
						<Empty className="border">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<CheckCircle2Icon />
								</EmptyMedia>
								<EmptyTitle>项目都有下一步</EmptyTitle>
								<EmptyDescription>本周回顾可以收工了。</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<ul className="flex flex-col gap-3">
							{projectsMissingNext.map((project) => (
								<li
									key={project.id}
									className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-center sm:justify-between"
								>
									<div>
										<p className="font-medium">{project.name}</p>
										<p className="text-sm text-muted-foreground">缺少下一步行动</p>
									</div>
									<div className="flex flex-wrap gap-2">
										<Button
											size="sm"
											disabled={busy}
											onClick={() => void createNextForProject(project.id)}
										>
											添加下一步
										</Button>
										<Button size="sm" variant="outline" render={<Link to={`/projects/${project.id}`} />}>
											打开项目
										</Button>
									</div>
								</li>
							))}
						</ul>
					)}
					{activeProjects.length > 0 && projectsMissingNext.length > 0 ? (
						<details className="rounded-lg border p-4 text-sm text-muted-foreground">
							<summary className="cursor-pointer font-medium text-foreground">
								已有下一步的项目（{activeProjects.length - projectsMissingNext.length}）
							</summary>
							<ul className="mt-3 flex flex-col gap-1">
								{activeProjects
									.filter((p) => (nextByProject[p.id] ?? 0) >= 1)
									.map((p) => (
										<li key={p.id}>
											{p.name} · {nextByProject[p.id]} 条 next
										</li>
									))}
							</ul>
						</details>
					) : null}
				</section>
			) : null}

			{step === "done" ? (
				<section className="flex flex-col gap-4">
					<Empty className="border">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<ClipboardCheckIcon />
							</EmptyMedia>
							<EmptyTitle>本周回顾完成</EmptyTitle>
							<EmptyDescription>
								收件箱 {inbox.length} · 等待 {waiting.length} · 将来 {someday.length} ·
								缺下一步项目 {projectsMissingNext.length}
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
					<div className="flex flex-wrap gap-2">
						<Button variant="outline" onClick={() => setStep("inbox")}>
							再走一遍
						</Button>
						<Button render={<Link to="/today" />}>回今日焦点</Button>
					</div>
				</section>
			) : null}

			<footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
				<Button type="button" variant="outline" disabled={stepIndex <= 0} onClick={goPrev}>
					上一步
				</Button>
				{step === "done" ? (
					<span className="text-sm text-muted-foreground">已到最后一步</span>
				) : (
					<Button type="button" onClick={goNext}>
						{step === "projects" ? "完成回顾" : "下一步"}
					</Button>
				)}
			</footer>
		</div>
	);
}
