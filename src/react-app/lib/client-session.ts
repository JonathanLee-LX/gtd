import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Me } from "../api";
import { buildUnsavedCreateRecords, persistUnsavedBatch } from "./autosave-persist";
import { clearInboxHint } from "./inbox-hint";
import { clearPendingCreates, exportPendingCreates } from "./pending-creates";
import { shellKeys } from "./shell-keys";
import { clearSkeletonCounts } from "./skeleton";
import { getTaskAutosave, peekTaskAutosave, releaseTaskAutosave } from "./task-autosave";

export type ClearClientSessionOptions = {
	/**
	 * #115 / #117：登录过期（401）：先把详情里还没保存的改动以及未完成的新建任务按用户暂存到本机，
	 * 同一用户重新登录后补发。写不进 localStorage 时留在内存里（停止发送、beforeunload 一直拦），并提示用户。
	 */
	persistUnsaved?: boolean;
	/** #115：用户确认过「退出后会丢失」：内存里留着的队列也一起丢掉。 */
	discardUnsaved?: boolean;
};

/**
 * #101：清掉这个浏览器里「属于当前登录用户」的客户端状态 —— 唯一入口。
 * - 查询缓存（me / projects / 任务列表 / 设置…），下一个登录的人不会先看到上一个人的数据；
 * - 收件箱项目 id 提示（`gtd:inbox-project-id`）；
 * - #99 骨架行数记录（`gtd:skeleton-count:*`，只按前缀删，别的 localStorage 不动）；
 * - #115 / #117 任务自动保存队列与未完成新建任务（见 options）。
 *
 * 调用点：登录页挂载、退出成功、任何 401（Shell 的单次跳转）。别处不要再各自清。
 */
export function clearClientSession(queryClient: QueryClient, options: ClearClientSessionOptions = {}): void {
	const queue = peekTaskAutosave(queryClient);
	const pendingCreates = exportPendingCreates(queryClient);
	let keep = false;

	if (options.discardUnsaved) {
		keep = false;
	} else if (queue?.heldUserId() !== undefined) {
		// 之前暂存失败、留在内存里等重新登录：登录页挂载时别丢。
		keep = true;
	} else if (options.persistUnsaved) {
		const records = queue ? queue.exportUnsaved() : [];
		const creates = buildUnsavedCreateRecords(pendingCreates, queue);
		if (records.length > 0 || creates.length > 0) {
			const userId = queryClient.getQueryData<Me>(shellKeys.me)?.user.id ?? null;
			if (!userId || !persistUnsavedBatch(userId, { updates: records, creates })) {
				keep = true;
				getTaskAutosave(queryClient).hold(userId, creates);
				toast.warning("登录已过期，有未保存的改动没能暂存到本机：请先别关闭页面，重新登录后会自动补发。");
			}
		}
	}

	if (!keep && queue) releaseTaskAutosave(queryClient);
	clearPendingCreates(queryClient);
	queryClient.clear();
	clearInboxHint();
	clearSkeletonCounts();
}
