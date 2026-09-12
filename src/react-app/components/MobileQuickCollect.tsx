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
import { Spinner } from "@/components/ui/spinner";
import { useVisualViewportBottomInset } from "@/hooks/use-visual-viewport-bottom";
import { PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";

type MobileQuickCollectProps = {
	/** Called after a task is created so inbox (and similar) can refresh. */
	onCreated?: () => void;
};

/**
 * Mobile one-tap capture: FAB above the bottom nav opens a bottom sheet to
 * add an inbox task via the existing create-task API (source=human).
 * Sheet bottom tracks visualViewport so the submit control stays above the keyboard.
 */
export function MobileQuickCollect({ onCreated }: MobileQuickCollectProps) {
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const titleId = useId();
	const keyboardInset = useVisualViewportBottomInset();

	useEffect(() => {
		if (!open) {
			setTitle("");
			return;
		}
		const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
		return () => window.clearTimeout(timer);
	}, [open]);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		const value = title.trim();
		if (!value || busy) return;
		setBusy(true);
		try {
			// Same path as InboxPage: web session → source=human; default project is inbox.
			await api.createTask({ title: value, status: "inbox" });
			setTitle("");
			setOpen(false);
			toast.success("已加入收件箱");
			onCreated?.();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "加入收件箱失败");
		} finally {
			setBusy(false);
		}
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
								enterKeyHint="done"
								disabled={busy}
							/>
						</Field>
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								className="flex-1"
								disabled={busy}
								onClick={() => setOpen(false)}
							>
								取消
							</Button>
							<Button
								type="submit"
								className="flex-1"
								disabled={busy || !title.trim()}
							>
								{busy ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
								加入收件箱
							</Button>
						</div>
					</form>
				</SheetContent>
			</Sheet>
		</>
	);
}
