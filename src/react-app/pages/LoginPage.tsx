import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { CircleAlertIcon } from "lucide-react";
import { api } from "../api";

export function LoginPage() {
	const navigate = useNavigate();
	const [mode, setMode] = useState<"in" | "up">("in");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			if (mode === "up") {
				await api.signUp(name || email.split("@")[0]!, email, password);
			} else {
				await api.signIn(email, password);
			}
			navigate("/today");
		} catch (err) {
			setError(err instanceof Error ? err.message : "登录失败");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
			<Card className="w-full max-w-md">
				<CardHeader>
					<p className="text-xs font-medium tracking-[0.2em] text-muted-foreground">
						PERSONAL GTD
					</p>
					<CardTitle>进入工作台</CardTitle>
					<CardDescription>同一套任务，网页和 MCP 都能读写。</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={submit} className="flex flex-col gap-5">
						<FieldGroup>
							{mode === "up" ? (
								<Field>
									<FieldLabel htmlFor="name">名字</FieldLabel>
									<Input
										id="name"
										placeholder="怎么称呼你"
										value={name}
										onChange={(event) => setName(event.target.value)}
									/>
								</Field>
							) : null}
							<Field>
								<FieldLabel htmlFor="email">邮箱</FieldLabel>
								<Input
									id="email"
									placeholder="you@example.com"
									type="email"
									value={email}
									onChange={(event) => setEmail(event.target.value)}
									required
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="password">密码</FieldLabel>
								<Input
									id="password"
									placeholder="至少 8 位"
									type="password"
									value={password}
									onChange={(event) => setPassword(event.target.value)}
									required
									minLength={8}
								/>
							</Field>
						</FieldGroup>
						{error ? (
							<Alert variant="destructive">
								<CircleAlertIcon />
								<AlertTitle>无法继续</AlertTitle>
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<Button type="submit" disabled={busy} className="w-full">
							{busy ? <Spinner data-icon="inline-start" /> : null}
							{mode === "in" ? "进入工作台" : "创建账号"}
						</Button>
					</form>
				</CardContent>
				<CardFooter>
					<Button
						type="button"
						variant="link"
						className="px-0"
						onClick={() => setMode(mode === "in" ? "up" : "in")}
					>
						{mode === "in" ? "没有账号？注册" : "已有账号？登录"}
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}
