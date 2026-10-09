import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { ProcessInboxInput } from "../../shared/schemas";
import { api } from "../api";

export type InboxProcessAction = ProcessInboxInput["action"];

/** Prompt for waitingOn; returns null if cancelled or empty. */
export function promptWaitingOn(): string | null {
	const who = window.prompt("在等谁？");
	if (who === null) return null;
	const trimmed = who.trim();
	if (!trimmed) {
		toast.error("请填写在等谁");
		return null;
	}
	return trimmed;
}

export async function runInboxProcess(
	taskId: string,
	action: InboxProcessAction,
	options?: { projectId?: string; waitingOn?: string },
) {
	return api.processInbox(taskId, {
		action,
		projectId: options?.projectId,
		waitingOn: options?.waitingOn,
	});
}

/**
 * Shared one-click inbox clarify actions (weekly review + daily inbox).
 * Waiting always prompts for who; discard → cancelled via TaskService.
 */
const skel = (on: boolean) => (on ? "skeleton-fill border-transparent disabled:opacity-100" : undefined);

export function InboxProcessActions({
	disabled,
	extra,
	onProcess,
	skeleton = false,
}: {
	disabled?: boolean;
	/** #99：骨架变体 —— 同样的按钮和尺寸，画成灰块、不可点、对读屏隐藏。 */
	skeleton?: boolean;
	/** Extra buttons (e.g. review「仅归项目」). */
	extra?: ReactNode;
	onProcess: (action: InboxProcessAction, waitingOn?: string) => void | Promise<void>;
}) {
	async function handle(action: InboxProcessAction) {
		if (action === "waiting") {
			const who = promptWaitingOn();
			if (!who) return;
			await onProcess(action, who);
			return;
		}
		await onProcess(action);
	}

	return (
		<div className="flex flex-wrap gap-2" aria-hidden={skeleton || undefined}>
			<Button
				size="sm"
				disabled={disabled || skeleton}
				tabIndex={skeleton ? -1 : undefined}
				className={skel(skeleton)}
				onClick={() => void handle("next")}
			>
				下一步
			</Button>
			<Button
				size="sm"
				variant="secondary"
				disabled={disabled || skeleton}
				tabIndex={skeleton ? -1 : undefined}
				className={skel(skeleton)}
				onClick={() => void handle("waiting")}
			>
				等待
			</Button>
			<Button
				size="sm"
				variant="secondary"
				disabled={disabled || skeleton}
				tabIndex={skeleton ? -1 : undefined}
				className={skel(skeleton)}
				onClick={() => void handle("someday")}
			>
				将来
			</Button>
			{skeleton ? null : extra}
			<Button
				size="sm"
				variant="ghost"
				disabled={disabled || skeleton}
				tabIndex={skeleton ? -1 : undefined}
				className={skel(skeleton)}
				onClick={() => void handle("discard")}
			>
				丢掉
			</Button>
		</div>
	);
}
