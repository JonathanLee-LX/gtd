import { cn } from "@/lib/utils";
import { CheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useTaskAutosave, useTaskSaveStatus } from "../hooks/use-task-autosave";

/**
 * #115：详情标题旁的保存状态。宽度固定（状态切换时标题这一行不跳）。
 * - 保存中…：12px 转圈（prefers-reduced-motion 时不转），muted；
 * - 已保存：12px 对勾，muted；
 * - 标题被清空：「标题未保存」，muted；
 * - 网络 / 5xx 失败：12px 三角 +「保存失败」（destructive）+ 单独的「重试」文字按钮（下划线、hover、可 Tab 聚焦）；
 * - 4xx 校验失败：三角 +「保存失败」+ 服务端给的原因（不能重试）。
 */
export function TaskSaveStatus({ taskId, className }: { taskId: string; className?: string }) {
	const queue = useTaskAutosave();
	const { status, error, titleInvalid } = useTaskSaveStatus(taskId);
	const icon = "size-3 shrink-0";
	let content: React.ReactNode = null;
	let state: string = status;
	if (status === "error" || status === "rejected") {
		content = (
			<>
				<TriangleAlertIcon aria-hidden className={cn(icon, "text-destructive")} />
				<span className="shrink-0 text-destructive">保存失败</span>
				{status === "error" ? (
					<button
						type="button"
						className="shrink-0 rounded-sm text-destructive underline underline-offset-2 hover:text-destructive/80 hover:decoration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
						title={error ?? undefined}
						onClick={() => queue.retry(taskId)}
					>
						重试
					</button>
				) : (
					<span className="min-w-0 truncate text-muted-foreground" title={error ?? undefined}>
						{error}
					</span>
				)}
			</>
		);
	} else if (status === "saving") {
		content = (
			<>
				<Loader2Icon aria-hidden className={cn(icon, "animate-spin motion-reduce:animate-none")} />
				<span>保存中…</span>
			</>
		);
	} else if (titleInvalid) {
		state = "title-invalid";
		content = <span>标题未保存</span>;
	} else if (status === "saved") {
		content = (
			<>
				<CheckIcon aria-hidden className={icon} />
				<span>已保存</span>
			</>
		);
	}
	return (
		<span
			className={cn(
				// 固定宽度：「保存中…」「已保存」「保存失败 重试」切换时不挤动标题行。
				"inline-flex w-44 min-w-0 shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground",
				className,
			)}
			role="status"
			aria-live="polite"
			data-save-status={content ? state : undefined}
		>
			{content}
		</span>
	);
}
