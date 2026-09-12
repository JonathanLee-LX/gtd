import { useEffect, useState } from "react";
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
	CheckIcon,
	CircleAlertIcon,
	CopyIcon,
	KeyRoundIcon,
	RotateCcwIcon,
	Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { SOFT_DELETE_RETENTION_DAYS } from "../../shared/constants";
import { statusLabel } from "../lib/format";
import { api, type Task } from "../api";

type TokenRow = {
	id: string;
	name: string;
	prefix: string;
	createdAt: string;
	revokedAt: string | null;
	lastUsedAt: string | null;
};

function deletedOn(value: string | null) {
	if (!value) return "";
	return value.slice(0, 10);
}

export function SettingsPage() {
	const [tokens, setTokens] = useState<TokenRow[]>([]);
	const [deleted, setDeleted] = useState<Task[]>([]);
	const [name, setName] = useState("MCP");
	const [freshToken, setFreshToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [recycleError, setRecycleError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [recycleLoading, setRecycleLoading] = useState(true);
	const [restoringId, setRestoringId] = useState<string | null>(null);
	const mcpUrl = `${window.location.origin}/mcp`;

	async function load() {
		const data = await api.tokens();
		setTokens(data.items);
	}

	async function loadDeleted() {
		const data = await api.deletedTasks();
		setDeleted(data.items);
	}

	useEffect(() => {
		void load().catch((err: unknown) => {
			setError(err instanceof Error ? err.message : "加载失败");
		});
		void loadDeleted()
			.catch((err: unknown) => {
				setRecycleError(err instanceof Error ? err.message : "回收站加载失败");
			})
			.finally(() => setRecycleLoading(false));
	}, []);

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
			setDeleted((items) => items.filter((item) => item.id !== id));
			toast.success("已恢复");
		} catch (err) {
			setRecycleError(err instanceof Error ? err.message : "恢复失败");
		} finally {
			setRestoringId(null);
		}
	}

	return (
		<section className="flex flex-col gap-6 overflow-auto p-6">
			<header className="flex flex-col gap-1">
				<h1 className="font-heading text-2xl tracking-tight">设置</h1>
				<p className="max-w-2xl text-sm text-muted-foreground">
					把 MCP URL 和个人 Token 配进 Grok / Claude。助手调用的是和网页同一套任务服务。
				</p>
			</header>
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
					{error ? (
						<Alert variant="destructive">
							<CircleAlertIcon />
							<AlertTitle>出错了</AlertTitle>
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<div className="flex flex-col gap-2">
						{tokens.map((token) => (
							<div
								key={token.id}
								className="flex items-center justify-between rounded-lg border px-3 py-3"
							>
								<div className="flex min-w-0 flex-col gap-1">
									<p className="truncate font-medium">{token.name}</p>
									<div className="flex flex-wrap items-center gap-1.5">
										<Badge variant="outline">{token.prefix}…</Badge>
										<Badge variant={token.revokedAt ? "secondary" : "default"}>
											{token.revokedAt ? "已撤销" : "有效"}
										</Badge>
									</div>
								</div>
								{token.revokedAt ? null : (
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
							</div>
						))}
					</div>
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
					{recycleError ? (
						<Alert variant="destructive">
							<CircleAlertIcon />
							<AlertTitle>出错了</AlertTitle>
							<AlertDescription>{recycleError}</AlertDescription>
						</Alert>
					) : null}
					{recycleLoading ? (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Spinner />
							加载回收站…
						</div>
					) : deleted.length === 0 ? (
						<p className="text-sm text-muted-foreground">回收站是空的。</p>
					) : (
						<div className="flex flex-col gap-2">
							{deleted.map((task) => (
								<div
									key={task.id}
									className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3"
								>
									<div className="min-w-0">
										<p className="truncate font-medium">{task.title}</p>
										<div className="mt-1 flex flex-wrap items-center gap-1.5">
											<Badge variant="outline">{statusLabel(task.status)}</Badge>
											{task.projectName ? (
												<Badge variant="secondary">{task.projectName}</Badge>
											) : null}
											{task.deletedAt ? (
												<Badge variant="outline">删除于 {deletedOn(task.deletedAt)}</Badge>
											) : null}
										</div>
									</div>
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
								</div>
							))}
						</div>
					)}
					<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Trash2Icon className="size-3.5" />
						网页与 MCP 走同一套 TaskService；默认列表不含已软删任务。
					</p>
				</CardContent>
			</Card>
		</section>
	);
}
