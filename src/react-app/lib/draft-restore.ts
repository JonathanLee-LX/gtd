/**
 * #90 乐观新建：提交时输入框已清空；失败后把文字放回来，不丢输入。
 * 如果用户已经接着输了下一条，就不覆盖（失败的那条在错误提示里点名，可再输一次）。
 */
export function restoreFailedDraft(current: string, failed: string): string {
	return current.trim() ? current : failed;
}

export function createFailedMessage(title: string, err: unknown, what = "没有添加成功"): string {
	const reason = err instanceof Error && err.message ? err.message : "请重试";
	return `「${title}」${what}：${reason}`;
}
