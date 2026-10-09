import { useState } from "react";
import { createFailedMessage, restoreFailedDraft } from "../lib/draft-restore";
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
	const [error, setError] = useState<string | null>(null);

	/**
	 * #90：乐观新建——提交当帧就清空输入框、任务已出现在列表里，可以接着输下一条；
	 * 不再等服务端返回（没有 busy / 转圈）。失败时把这条文字放回输入框（若用户还没输新内容），不丢输入。
	 */
	function submit(event: React.FormEvent) {
		event.preventDefault();
		const value = title.trim();
		if (!value) return;
		setTitle("");
		setError(null);
		void onCreate(value).catch((err: unknown) => {
			setTitle((current) => restoreFailedDraft(current, value));
			setError(createFailedMessage(value, err));
		});
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
						onChange={(event) => setTitle(event.target.value)}
						placeholder={placeholder}
						aria-invalid={Boolean(error)}
					/>
					<InputGroupAddon align="inline-end">
						{onParse ? (
							<InputGroupButton
								type="button"
								variant="outline"
								size="sm"
								disabled={parsing}
								aria-label="AI 解析"
								onClick={() => {
									const value = title.trim();
									if (!value || parsing) return;
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
							<PlusIcon data-icon="inline-start" />
							<span className="max-sm:hidden">添加</span>
						</InputGroupButton>
					</InputGroupAddon>
				</InputGroup>
				{error ? <FieldError>{error}</FieldError> : null}
			</Field>
		</form>
	);
}
