import type { QueryClient } from "@tanstack/react-query";
import { clearInboxHint } from "./inbox-hint";

/**
 * #101：清掉这个浏览器里「属于当前登录用户」的客户端状态 —— 唯一入口。
 * - 查询缓存（me / projects / 任务列表 / 设置…），下一个登录的人不会先看到上一个人的数据；
 * - 收件箱项目 id 提示（`gtd:inbox-project-id`）。
 *
 * 调用点：登录页挂载、退出成功、任何 401（Shell 的单次跳转）。别处不要再各自清。
 */
export function clearClientSession(queryClient: QueryClient): void {
	queryClient.clear();
	clearInboxHint();
}
