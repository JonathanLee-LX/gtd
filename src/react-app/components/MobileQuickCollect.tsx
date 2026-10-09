import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { useVisualViewportBottomInset } from "@/hooks/use-visual-viewport-bottom";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";
import type { Project } from "../api";
import { useCreateTask } from "../hooks/use-task-mutations";
import { createFailedMessage, restoreFailedDraft } from "../lib/draft-restore";

type MobileQuickCollectProps = {
	/** Shell 的项目列表：给乐观插入的临时行补上收件箱 id，立刻出现在收件箱列表里。 */
	projects?: readonly Project[];
	/** Called after a task is created so inbox (and similar) can refresh. */
	onCreated?: () => void;
};

/**
 * Mobile one-tap capture: FAB above the bottom nav opens a bottom sheet to
 * add an inbox task via the shared optimistic create hook (source=human).
 * Sheet bottom tracks visualViewport so the submit control stays above the keyboard.
 *
 * #90：提交当帧清空输入框、保持面板打开和键盘焦点，可以接着记下一条；
 * 任务先乐观出现在收件箱，失败时撤回并把文字放回输入框（必要时重新打开面板），不丢输入。
 */
export function MobileQuickCollect({ projects, onCreated }: MobileQuickCollectProps) {
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const titleId = useId();
	const keyboardInset = useVisualViewportBottomInset();
	const createTask = useCreateTask(projects);

	useEffect(() => {
		if (!open) {
			setTitle("");
			setError(null);
			return;
		}
		const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
		return () => window.clearTimeout(timer);
	}, [open]);

	function submit(event: React.FormEvent) {
		event.preventDefault();
		const value = title.trim();
		if (!value) return;
		setTitle("");
		setError(null);
		inputRef.current?.focus();
		// Same path as InboxPage: web session → source=human; default project is inbox.
		createTask
			.mutateAsync({ title: value, status: "inbox" })
			.then(() => {
				toast.success("已加入收件箱", { id: "quick-collect-ok", duration: 1500 });
				onCreated?.();
			})
			.catch((err: unknown) => {
				// 撤回 + toast 由 useCreateTask 处理；这里只负责不丢输入。
				setTitle((current) => restoreFailedDraft(current, value));
				setError(createFailedMessage(value, err, "没有加入收件箱"));
				setOpen(true);
			});
	}

	return (
		<>
			{open ? null : (
				<button
					type="button"
					className="fixed right-4 z-40 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
					style={{
						bottom: `calc(3.5rem + env(safe-area-inset-bottom, 0px) + 0.75rem)`,
					}}
					aria-label="加到收件箱"
					onClick={() => setOpen(true)}
				>
					<PlusIcon className="size-6" />
				</button>
			)}

			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent
					side="bottom"
					showCloseButton={false}
					className="z-50 gap-0 rounded-t-xl border-t p-0 md:hidden"
					style={{
						bottom: keyboardInset,
						paddingBottom: "max(1rem, env(safe-area-inset-bottom, 0px))",
					}}
				>
					<form onSubmit={submit} className="flex flex-col gap-3 p-4 pt-3">
						<SheetHeader className="p-0 text-left">
							<SheetTitle>加到收件箱</SheetTitle>
							<SheetDescription>随手记一条，稍后再整理。</SheetDescription>
						</SheetHeader>
						<Field>
							<FieldLabel htmlFor={titleId} className="sr-only">
								任务标题
							</FieldLabel>
							<Input
								ref={inputRef}
								id={titleId}
								value={title}
								onChange={(event) => setTitle(event.target.value)}
								placeholder="随便记一条…"
								autoComplete="off"
								enterKeyHint="send"
								aria-invalid={Boolean(error)}
							/>
							{error ? (
								<p className="text-xs text-destructive" role="alert">
									{error}
								</p>
							) : null}
						</Field>
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								className="flex-1"
								onClick={() => setOpen(false)}
							>
								关闭
							</Button>
							<Button
								type="submit"
								className="flex-1"
								disabled={!title.trim()}
							>
								<PlusIcon data-icon="inline-start" />
								加入收件箱
							</Button>
						</div>
					</form>
				</SheetContent>
			</Sheet>
		</>
	);
}
