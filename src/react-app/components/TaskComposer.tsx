import { useState } from "react";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { PlusIcon, SparklesIcon } from "lucide-react";

export function TaskComposer({
	placeholder,
	onCreate,
	onParse,
	parsing,
}: {
	placeholder: string;
	onCreate: (title: string) => Promise<void>;
	onParse?: (text: string) => Promise<void>;
	parsing?: boolean;
}) {
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		const value = title.trim();
		if (!value) return;
		if (busy) {
			// 上一次提交尚未返回：给用户明确反馈，而不是静默吞掉回车
			//（注意：提交按钮在 busy 时不能 disabled，否则浏览器不会触发表单隐式提交）
			setNotice("正在添加，请稍候…");
			return;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await onCreate(value);
			setTitle("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建失败");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form onSubmit={submit}>
			<Field data-invalid={error ? true : undefined}>
				<FieldLabel htmlFor="task-title" className="sr-only">
					新任务
				</FieldLabel>
				<InputGroup className="h-10">
					<InputGroupInput
						id="task-title"
						value={title}
						onChange={(event) => {
							setTitle(event.target.value);
							setNotice(null);
						}}
						placeholder={placeholder}
						aria-invalid={Boolean(error)}
					/>
					<InputGroupAddon align="inline-end">
						{onParse ? (
							<InputGroupButton
								type="button"
								variant="outline"
								size="sm"
								disabled={busy || parsing}
								aria-label="AI 解析"
								onClick={() => {
									const value = title.trim();
									if (!value || busy || parsing) return;
									void onParse(value)
										.then(() => setTitle(""))
										.catch((err: unknown) => {
											setError(err instanceof Error ? err.message : "解析失败");
										});
								}}
							>
								{parsing ? (
									<Spinner data-icon="inline-start" />
								) : (
									<SparklesIcon data-icon="inline-start" />
								)}
								<span className="max-sm:hidden">AI</span>
							</InputGroupButton>
						) : null}
						<InputGroupButton type="submit" variant="default" size="sm" aria-label="添加">
							{busy ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
							<span className="max-sm:hidden">添加</span>
						</InputGroupButton>
					</InputGroupAddon>
				</InputGroup>
				{error ? <FieldError>{error}</FieldError> : null}
				{!error && notice ? (
					<p className="text-xs text-muted-foreground">{notice}</p>
				) : null}
			</Field>
		</form>
	);
}
