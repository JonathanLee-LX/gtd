import { useState } from "react";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { PlusIcon } from "lucide-react";

export function TaskComposer({
	placeholder,
	onCreate,
}: {
	placeholder: string;
	onCreate: (title: string) => Promise<void>;
}) {
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		const value = title.trim();
		if (!value || busy) return;
		setBusy(true);
		setError(null);
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
						onChange={(event) => setTitle(event.target.value)}
						placeholder={placeholder}
						aria-invalid={Boolean(error)}
					/>
					<InputGroupAddon align="inline-end">
						<InputGroupButton type="submit" variant="default" size="sm" disabled={busy} aria-label="添加">
							{busy ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
							<span className="max-sm:hidden">添加</span>
						</InputGroupButton>
					</InputGroupAddon>
				</InputGroup>
				{error ? <FieldError>{error}</FieldError> : null}
			</Field>
		</form>
	);
}
