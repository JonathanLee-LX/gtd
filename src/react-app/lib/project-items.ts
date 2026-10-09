import type { Project } from "../api";

export type ProjectItem = { value: string; label: string };

/**
 * #101：项目选择器的选项。项目列表还没回来（冷启动）时，至少放上当前任务所在的项目，
 * 选择框能显示当前值；调用方同时把选择框禁用，等列表回来再开放。
 */
export function projectPickerItems(
	projects: readonly Project[],
	current?: { id: string; name: string } | null,
): ProjectItem[] {
	const items = projects.map((project) => ({ value: project.id, label: project.name }));
	if (current?.id && !items.some((item) => item.value === current.id)) {
		items.push({ value: current.id, label: current.name || "当前项目" });
	}
	return items;
}
