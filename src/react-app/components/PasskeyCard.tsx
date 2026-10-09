import { useCallback, useEffect, useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { CircleAlertIcon, FingerprintPatternIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { authClient, type UserPasskey } from "../auth-client";
import {
	browserSupportsPasskey,
	DEFAULT_PASSKEY_RP_ID,
	isPasskeyHost,
	PASSKEY_SETTINGS_HOST_HINT,
	passkeyLabel,
	passkeyRegisterErrorMessage,
} from "../lib/passkey";

function addedOn(value: UserPasskey["createdAt"]) {
	if (!value) return "";
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
}

/** #81 设置页：添加 / 查看 / 删除通行密钥。需已登录。 */
export function PasskeyCard() {
	const [rpID, setRpID] = useState(DEFAULT_PASSKEY_RP_ID);
	const [items, setItems] = useState<UserPasskey[]>([]);
	const [loading, setLoading] = useState(true);
	const [adding, setAdding] = useState(false);
	const [deletingId, setDeletingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const available = browserSupportsPasskey() && isPasskeyHost(window.location.hostname, rpID);

	const load = useCallback(async () => {
		const result = await authClient.$fetch<UserPasskey[]>("/passkey/list-user-passkeys", {
			method: "GET",
		});
		if (result.error) throw new Error(result.error.message || "通行密钥列表加载失败");
		setItems(result.data ?? []);
	}, []);

	useEffect(() => {
		void api
			.health()
			.then((health) => {
				if (health.passkeyRpId) setRpID(health.passkeyRpId);
			})
			.catch(() => undefined);
		void load()
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : "通行密钥列表加载失败");
			})
			.finally(() => setLoading(false));
	}, [load]);

	async function add() {
		setError(null);
		setAdding(true);
		try {
			const result = await authClient.passkey.addPasskey();
			if (result.error) {
				setError(passkeyRegisterErrorMessage(result.error, rpID));
				return;
			}
			await load();
			toast.success("已添加通行密钥，下次可以直接用它登录");
		} catch (err) {
			setError(passkeyRegisterErrorMessage({ message: err instanceof Error ? err.message : "" }, rpID));
		} finally {
			setAdding(false);
		}
	}

	async function remove(id: string) {
		setError(null);
		setDeletingId(id);
		try {
			const result = await authClient.$fetch("/passkey/delete-passkey", {
				method: "POST",
				body: { id },
			});
			if (result.error) throw new Error(result.error.message || "删除失败");
			setItems((current) => current.filter((item) => item.id !== id));
			toast.success("已删除，这个通行密钥不能再登录");
		} catch (err) {
			setError(err instanceof Error ? err.message : "删除失败");
		} finally {
			setDeletingId(null);
		}
	}

	return (
		<Card className="max-w-xl">
			<CardHeader>
				<CardTitle>通行密钥</CardTitle>
				<CardDescription>
					绑定后在登录页用指纹 / 面容 / 设备密码一步登录，不用输密码。邮箱密码登录仍然可用。
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4 pb-(--card-spacing)">
				{available ? (
					<div>
						<Button type="button" onClick={() => void add()} disabled={adding}>
							{adding ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
							添加通行密钥
						</Button>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						{PASSKEY_SETTINGS_HOST_HINT}
					</p>
				)}
				{error ? (
					<Alert variant="destructive">
						<CircleAlertIcon />
						<AlertTitle>出错了</AlertTitle>
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				{loading ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner />
						加载通行密钥…
					</div>
				) : items.length === 0 ? (
					<p className="text-sm text-muted-foreground">还没有绑定通行密钥。</p>
				) : (
					<div className="flex flex-col gap-2">
						{items.map((item) => (
							<div
								key={item.id}
								className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3"
							>
								<div className="flex min-w-0 items-center gap-2">
									<FingerprintPatternIcon className="size-4 shrink-0 text-muted-foreground" />
									<div className="min-w-0">
										<p className="truncate font-medium">{passkeyLabel(item.name)}</p>
										<div className="mt-1 flex flex-wrap items-center gap-1.5">
											{addedOn(item.createdAt) ? (
												<Badge variant="outline">添加于 {addedOn(item.createdAt)}</Badge>
											) : null}
											{item.backedUp ? <Badge variant="secondary">已同步</Badge> : null}
										</div>
									</div>
								</div>
								<AlertDialog>
									<AlertDialogTrigger
										render={
											<Button variant="destructive" size="sm" disabled={deletingId === item.id} />
										}
									>
										{deletingId === item.id ? <Spinner data-icon="inline-start" /> : null}
										删除
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>删除这个通行密钥？</AlertDialogTitle>
											<AlertDialogDescription>
												删除后它不能再登录本站。设备里的密钥条目可在系统密码管理中自行清理。
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>取消</AlertDialogCancel>
											<AlertDialogAction variant="destructive" onClick={() => void remove(item.id)}>
												删除
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
