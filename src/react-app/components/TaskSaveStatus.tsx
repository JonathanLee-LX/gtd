import { cn } from "@/lib/utils";
import { useTaskAutosave, useTaskSaveStatus } from "../hooks/use-task-autosave";

/**
 * #115：详情标题旁的保存状态。「保存中…」→「已保存」；失败「保存失败 · 重试」（整块可点重试）。
 * 没改过东西时不显示。
 */
export function TaskSaveStatus({ taskId, className }: { taskId: string; className?: string }) {
	const queue = useTaskAutosave();
	const { status, error } = useTaskSaveStatus(taskId);
	if (status === "idle") return <span className={cn("sr-only", className)} aria-live="polite" />;
	if (status === "error") {
		return (
			<button
				type="button"
				className={cn(
					"shrink-0 rounded-sm text-xs font-medium text-destructive underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring",
					className,
				)}
				title={error ?? undefined}
				aria-live="polite"
				data-save-status="error"
				onClick={() => queue.retry(taskId)}
			>
				保存失败 · 重试
			</button>
		);
	}
	return (
		<span
			className={cn("shrink-0 text-xs font-normal text-muted-foreground", className)}
			aria-live="polite"
			data-save-status={status}
		>
			{status === "saving" ? "保存中…" : "已保存"}
		</span>
	);
}
