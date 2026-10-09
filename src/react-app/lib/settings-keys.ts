/** #99：设置页卡片列表的查询 key（也用作骨架行数的 localStorage key）。不放在 ["tasks"] 下，免得任务刷新连带重拉。 */
export const settingsKeys = {
	all: ["settings"] as const,
	tokens: () => [...settingsKeys.all, "tokens"] as const,
	deletedTasks: () => [...settingsKeys.all, "deleted-tasks"] as const,
	passkeys: () => [...settingsKeys.all, "passkeys"] as const,
};
