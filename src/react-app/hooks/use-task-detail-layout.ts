import { useSyncExternalStore } from "react";
import {
	currentTaskDetailLayout,
	subscribeTaskDetailLayout,
	type TaskDetailLayout,
} from "../lib/task-detail-layout";

/**
 * #94：详情用右侧面板还是全屏（断点 1024，= Tailwind `lg`）。
 * 首帧就是正确值（不像 useIsMobile 先返回 false 再修正），跨断点时同步切换。
 */
export function useTaskDetailLayout(): TaskDetailLayout {
	return useSyncExternalStore(subscribeTaskDetailLayout, currentTaskDetailLayout, () => "aside");
}
