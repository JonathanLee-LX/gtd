import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
		<div className="flex min-h-full items-center justify-center bg-[#1f2a24] p-6">
			<form
				onSubmit={submit}
				className="w-full max-w-md rounded-2xl bg-[#f3efe4] p-8 shadow-xl"
			>
				<p className="text-sm tracking-[0.2em] text-[#6b6458]">PERSONAL GTD</p>
				<h1 className="mt-2 text-3xl">把今天该做的事交给系统和助手</h1>
				<p className="mt-3 text-sm text-[#6b6458]">
					同一套任务，网页和 MCP 都能读写。
				</p>
				{mode === "up" ? (
					<input
						className="mt-6 w-full rounded-xl border border-[#ddd4c4] bg-white px-4 py-3"
						placeholder="名字"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				) : null}
				<input
					className="mt-3 w-full rounded-xl border border-[#ddd4c4] bg-white px-4 py-3"
					placeholder="邮箱"
					type="email"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					required
				/>
				<input
					className="mt-3 w-full rounded-xl border border-[#ddd4c4] bg-white px-4 py-3"
					placeholder="密码（至少 8 位）"
					type="password"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					required
					minLength={8}
				/>
				{error ? <p className="mt-3 text-sm text-[#8a3b2b]">{error}</p> : null}
				<button
					type="submit"
					disabled={busy}
					className="mt-6 w-full rounded-xl bg-[#1f2a24] py-3 text-white disabled:opacity-50"
				>
					{mode === "in" ? "进入工作台" : "创建账号"}
				</button>
				<button
					type="button"
					className="mt-3 w-full text-sm text-[#6b6458]"
					onClick={() => setMode(mode === "in" ? "up" : "in")}
				>
					{mode === "in" ? "没有账号？注册" : "已有账号？登录"}
				</button>
			</form>
		</div>
	);
}
