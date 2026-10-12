import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { getTaskAutosave, type AutosaveSnapshot, type TaskAutosaveQueue } from "../lib/task-autosave";

/** #115：这个 QueryClient 的任务自动保存队列（模块级，组件卸载后照样跑完）。 */
export function useTaskAutosave(): TaskAutosaveQueue {
	return getTaskAutosave(useQueryClient());
}

/** 某条任务的保存状态（保存中 / 已保存 / 保存失败）。 */
export function useTaskSaveStatus(taskId: string): AutosaveSnapshot {
	const queue = useTaskAutosave();
	const subscribe = useCallback((listener: () => void) => queue.subscribe(taskId, listener), [queue, taskId]);
	const get = useCallback(() => queue.getSnapshot(taskId), [queue, taskId]);
	return useSyncExternalStore(subscribe, get, get);
}
