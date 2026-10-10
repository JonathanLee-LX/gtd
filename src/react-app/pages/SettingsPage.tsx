import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
	ArchiveRestoreIcon,
	CheckIcon,
	CircleAlertIcon,
	CopyIcon,
	FolderArchiveIcon,
	KeyRoundIcon,
	RotateCcwIcon,
	Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { PasskeyCard } from "../components/PasskeyCard";
import { SettingsListItem } from "../components/SettingsListItem";
import { EmptyLine } from "../components/EmptyLine";
import { QueryView } from "../components/QueryView";
import { loadErrorMessage } from "../lib/load-state";
import { settingsKeys } from "../lib/settings-keys";
import { SOFT_DELETE_RETENTION_DAYS } from "../../shared/constants";
import { statusLabel } from "../lib/format";
import { api, type Task } from "../api";
import { useShellContext } from "../hooks/use-shell-data";

type TokenRow = {
	id: string;
	name: string;
	prefix: string;
	createdAt: string;
	revokedAt: string | null;
	lastUsedAt: string | null;
};

/** 设置卡片里的红色提示（加载失败 / 操作失败）。 */
function LoadAlert({ message }: { message: string }) {
	return (
		<Alert variant="destructive">
			<CircleAlertIcon />
			<AlertTitle>出错了</AlertTitle>
			<AlertDescription>{message}</AlertDescription>
		</Alert>
	);
}

function deletedOn(value: string | null) {
	if (!value) return "";
	return value.slice(0, 10);
}

export function SettingsPage() {
	const { projects, projectsReady, projectsError, reloadProjects } = useShellContext();
	const queryClient = useQueryClient();
	// #99：设置页列表改用查询缓存 —— 再次进入直接显示上次数据（后台刷新），只有冷加载才出骨架。
	const tokensQuery = useQuery({
		queryKey: settingsKeys.tokens(),
		queryFn: () => api.tokens() as Promise<{ items: TokenRow[] }>,
		refetchOnMount: "always",
	});
	const deletedQuery = useQuery({
		queryKey: settingsKeys.deletedTasks(),
		queryFn: () => api.deletedTasks(),
		refetchOnMount: "always",
	});
	const [name, setName] = useState("MCP");
	const [freshToken, setFreshToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [recycleError, setRecycleError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [restoringId, setRestoringId] = useState<string | null>(null);
	const [unarchivingId, setUnarchivingId] = useState<string | null>(null);
	const mcpUrl = `${window.location.origin}/mcp`;
	const archivedProjects = projects.filter((project) => !project.isInbox && project.archivedAt);

	async function load() {
		await queryClient.invalidateQueries({ queryKey: settingsKeys.tokens() });
	}

	async function copy(value: string, label: string) {
		await navigator.clipboard.writeText(value);
		toast.success(`已复制${label}`);
	}

	async function create() {
		setError(null);
		setCreating(true);
		try {
			const created = await api.createToken(name.trim() || "MCP");
			setFreshToken(created.token);
			await load();
			toast.success("Token 已创建，请立刻复制");
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建失败");
		} finally {
			setCreating(false);
		}
	}

	async function restore(id: string) {
		setRecycleError(null);
		setRestoringId(id);
		try {
			await api.restoreTask(id);
			queryClient.setQueryData<{ items: Task[] }>(settingsKeys.deletedTasks(), (current) =>
				current ? { ...current, items: current.items.filter((item) => item.id !== id) } : current,
			);
			toast.success("已恢复");
		} catch (err) {
			setRecycleError(err instanceof Error ? err.message : "恢复失败");
		} finally {
			setRestoringId(null);
		}
	}

	async function unarchive(id: string) {
		setUnarchivingId(id);
		try {
			await api.updateProject(id, { archived: false });
			await reloadProjects();
			toast.success("已取消归档");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "取消归档失败");
		} finally {
			setUnarchivingId(null);
		}
	}

	return (
		<section className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6 pb-24 *:shrink-0 md:pb-6">
			<header className="flex flex-col gap-1">
				<h1 className="font-heading text-2xl tracking-tight">设置</h1>
				<p className="max-w-2xl text-sm text-muted-foreground">
					把 MCP URL 和个人 Token 配进 Grok / Claude。助手调用的是和网页同一套任务服务。
				</p>
			</header>
			<PasskeyCard />
			<Card className="max-w-xl">
				<CardHeader>
					<CardTitle>MCP</CardTitle>
					<CardDescription>Streamable HTTP，Header 带 Bearer Token。</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<Field>
						<FieldLabel>MCP URL</FieldLabel>
						<div className="flex gap-2">
							<Input readOnly value={mcpUrl} />
							<Button
								type="button"
								variant="outline"
								size="icon"
								aria-label="复制 MCP URL"
								onClick={() => void copy(mcpUrl, " URL")}
							>
								<CopyIcon />
							</Button>
						</div>
					</Field>
					<Field>
						<FieldLabel>Header</FieldLabel>
						<div className="flex gap-2">
							<Input readOnly value="Authorization: Bearer gtd_..." />
							<Button
								type="button"
								variant="outline"
								size="icon"
								aria-label="复制 Header"
								onClick={() => void copy("Authorization: Bearer gtd_...", " Header")}
							>
								<CopyIcon />
							</Button>
						</div>
					</Field>
				</CardContent>
			</Card>
			<Card className="max-w-xl">
				<CardHeader>
					<CardTitle>API Token</CardTitle>
					<CardDescription>明文只显示一次，之后只能看到前缀。</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					<FieldGroup>
						<Field orientation="horizontal">
							<FieldLabel htmlFor="token-name" className="sr-only">
								Token 名称
							</FieldLabel>
							<Input
								id="token-name"
								value={name}
								onChange={(event) => setName(event.target.value)}
								placeholder="MCP"
							/>
							<Button type="button" onClick={() => void create()} disabled={creating}>
								{creating ? (
									<Spinner data-icon="inline-start" />
								) : (
									<KeyRoundIcon data-icon="inline-start" />
								)}
								新建
							</Button>
						</Field>
					</FieldGroup>
					{freshToken ? (
						<Alert>
							<CheckIcon />
							<AlertTitle>只显示一次</AlertTitle>
							<AlertDescription>
								<code className="break-all">{freshToken}</code>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="mt-2"
									onClick={() => void copy(freshToken, " Token")}
								>
									<CopyIcon data-icon="inline-start" />
									复制
								</Button>
							</AlertDescription>
						</Alert>
					) : null}
					{error ? <LoadAlert message={error} /> : null}
					<QueryView
						query={tokensQuery}
						loadKey={settingsKeys.tokens()}
						maxCount={10}
						// #99：没记录时按「空」画一行空状态高度的骨架 —— 多数人这张卡片是空的；每张画 1 整行时，三张空卡片合起来让回收站上移 150px（> 一行）。
						fallbackCount={0}
						skeletonClassName="flex flex-col gap-2"
						skeletonLabel="正在加载 Token"
						skeleton={(index) => (
							<SettingsListItem.Skeleton key={index} index={index} actionLabel="撤销" />
						)}
						empty={<EmptyLine>还没有 Token。</EmptyLine>}
						error={(err) => <LoadAlert message={loadErrorMessage(err)} />}
					>
						{(data) => (
						<div className="flex flex-col gap-2">
							{data.items.map((token) => (
								<SettingsListItem
									key={token.id}
									title={token.name}
									meta={
										<>
											<Badge variant="outline">{token.prefix}…</Badge>
											<Badge variant={token.revokedAt ? "secondary" : "default"}>
												{token.revokedAt ? "已撤销" : "有效"}
											</Badge>
										</>
									}
									action={token.revokedAt ? null : (
										<AlertDialog>
											<AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
												撤销
											</AlertDialogTrigger>
											<AlertDialogContent>
												<AlertDialogHeader>
													<AlertDialogTitle>撤销这个 Token？</AlertDialogTitle>
													<AlertDialogDescription>
														助手立刻无法再调用 MCP。需要的话再新建一个。
													</AlertDialogDescription>
												</AlertDialogHeader>
												<AlertDialogFooter>
													<AlertDialogCancel>取消</AlertDialogCancel>
													<AlertDialogAction
														variant="destructive"
														onClick={() =>
															void api
																.revokeToken(token.id)
																.then(load)
																.then(() => toast.success("已撤销"))
														}
													>
														撤销
													</AlertDialogAction>
												</AlertDialogFooter>
											</AlertDialogContent>
										</AlertDialog>
									)}
								/>
							))}
						</div>
						)}
					</QueryView>
				</CardContent>
			</Card>
			<Card className="max-w-xl">
				<CardHeader>
					<CardTitle>已归档项目</CardTitle>
					<CardDescription>
						归档后侧栏和周回顾不再出现，任务不会被删除。取消归档后会回到侧栏。
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{/* #101：项目列表还没回来时出骨架，不先显示「没有已归档的项目」。 */}
					<QueryView
						query={{ data: projectsReady ? { items: archivedProjects } : undefined, error: projectsError }}
						loadKey={["projects", "archived"]}
						// #99：没记录时按「空」画一行空状态高度的骨架 —— 多数人这张卡片是空的；每张画 1 整行时，三张空卡片合起来让回收站上移 150px（> 一行）。
						fallbackCount={0}
						maxCount={10}
						skeletonClassName="flex flex-col gap-2"
						skeletonLabel="正在加载已归档项目"
						skeleton={(index) => (
							<SettingsListItem.Skeleton key={index} index={index} actionLabel="取消归档" />
						)}
						empty={<EmptyLine>没有已归档的项目。</EmptyLine>}
						error={(err) => <LoadAlert message={loadErrorMessage(err)} />}
					>
						{(data) => (
							<div className="flex flex-col gap-2">
								{data.items.map((project) => (
									<div
										key={project.id}
										className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3"
									>
										<div className="min-w-0">
											<Link
												to={`/projects/${project.id}`}
												className="block truncate font-medium hover:underline"
											>
												{project.name}
											</Link>
											{project.archivedAt ? (
												<div className="mt-1">
													<Badge variant="outline">
														归档于 {project.archivedAt.slice(0, 10)}
													</Badge>
												</div>
											) : null}
										</div>
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={unarchivingId === project.id}
											onClick={() => void unarchive(project.id)}
										>
											{unarchivingId === project.id ? (
												<Spinner data-icon="inline-start" />
											) : (
												<ArchiveRestoreIcon data-icon="inline-start" />
											)}
											取消归档
										</Button>
									</div>
								))}
							</div>
						)}
					</QueryView>
					<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<FolderArchiveIcon className="size-3.5" />
						网页与 MCP 走同一套 ProjectService；收件箱不能归档。
					</p>
				</CardContent>
			</Card>
			<Card className="max-w-xl">
				<CardHeader>
					<CardTitle>回收站</CardTitle>
					<CardDescription>
						软删除的任务会保留 {SOFT_DELETE_RETENTION_DAYS}{" "}
						天，之后由定时任务按用户物理清除。
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{recycleError ? <LoadAlert message={recycleError} /> : null}
					<QueryView
						query={deletedQuery}
						loadKey={settingsKeys.deletedTasks()}
						maxCount={10}
						// #99：没记录时只画 1 行（第一次进设置页，5 行骨架会让下面的卡片大幅跳动）。
						fallbackCount={1}
						skeletonClassName="flex flex-col gap-2"
						skeletonLabel="正在加载回收站"
						skeleton={(index) => (
							<SettingsListItem.Skeleton key={index} index={index} actionLabel="恢复" />
						)}
						empty={<EmptyLine>回收站是空的。</EmptyLine>}
						error={(err) => <LoadAlert message={loadErrorMessage(err, "回收站加载失败")} />}
					>
						{(data) => (
							<div className="flex flex-col gap-2">
								{data.items.map((task: Task) => (
									<SettingsListItem
										key={task.id}
										title={task.title}
										meta={
											<>
												<Badge variant="outline">{statusLabel(task.status)}</Badge>
												{task.projectName ? (
													<Badge variant="secondary">{task.projectName}</Badge>
												) : null}
												{task.deletedAt ? (
													<Badge variant="outline">删除于 {deletedOn(task.deletedAt)}</Badge>
												) : null}
											</>
										}
										action={
											<Button
												type="button"
												variant="outline"
												size="sm"
												disabled={restoringId === task.id}
												onClick={() => void restore(task.id)}
											>
												{restoringId === task.id ? (
													<Spinner data-icon="inline-start" />
												) : (
													<RotateCcwIcon data-icon="inline-start" />
												)}
												恢复
											</Button>
										}
									/>
								))}
							</div>
						)}
					</QueryView>
					<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Trash2Icon className="size-3.5" />
						网页与 MCP 走同一套 TaskService；默认列表不含已软删任务。
					</p>
				</CardContent>
			</Card>
		</section>
	);
}
