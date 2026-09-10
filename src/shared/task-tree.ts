/** 列表展示用：按父子关系排序并计算缩进深度。缺失的父视为根（删除父后 SET NULL / 软删不可见）。 */
export type TaskTreeNode = {
	id: string;
	parentId: string | null;
};

export function orderTasksWithDepth<T extends TaskTreeNode>(
	items: T[],
): { task: T; depth: number }[] {
	const byId = new Map(items.map((item) => [item.id, item]));
	const children = new Map<string, T[]>();
	const roots: T[] = [];

	for (const item of items) {
		if (item.parentId && byId.has(item.parentId)) {
			const siblings = children.get(item.parentId) ?? [];
			siblings.push(item);
			children.set(item.parentId, siblings);
		} else {
			roots.push(item);
		}
	}

	const ordered: { task: T; depth: number }[] = [];
	const walk = (task: T, depth: number) => {
		ordered.push({ task, depth });
		for (const child of children.get(task.id) ?? []) {
			walk(child, Math.min(depth + 1, 8));
		}
	};
	for (const root of roots) walk(root, 0);
	return ordered;
}

/** 从 proposedParentId 向上走，若碰到 taskId 则成环。 */
export function createsParentCycle(
	taskId: string,
	proposedParentId: string,
	parentOf: (id: string) => string | null | undefined,
): boolean {
	if (proposedParentId === taskId) return true;
	const seen = new Set<string>();
	let current: string | null | undefined = proposedParentId;
	while (current) {
		if (current === taskId) return true;
		if (seen.has(current)) return true;
		seen.add(current);
		current = parentOf(current);
	}
	return false;
}
