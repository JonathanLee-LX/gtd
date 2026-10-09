import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_INPUT_ACCEPT } from "../../shared/limits";
import { TaskAttachments } from "./TaskAttachments";

function render() {
	const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
	return renderToStaticMarkup(
		createElement(QueryClientProvider, { client }, createElement(TaskAttachments, { taskId: "t1" })),
	);
}

// #89：点击「添加附件」必须直接落在 file input 上（label 原生激活），不能靠 JS 转发 input.click()。
describe("TaskAttachments picker (#89)", () => {
	it("renders the visible trigger as a <label> wrapping the file input", () => {
		const html = render();
		const label = html.match(/<label[^>]*data-testid="attachment-picker"[^>]*>([\s\S]*?)<\/label>/);
		expect(label, html).not.toBeNull();
		const inner = label![1];
		expect(inner).toContain("添加附件");
		const input = inner.match(/<input[^>]*>/)?.[0] ?? "";
		expect(input).toContain('type="file"');
		expect(input).toContain(`accept="${ATTACHMENT_INPUT_ACCEPT}"`);
		expect(ATTACHMENT_INPUT_ACCEPT).toBe("image/*,application/pdf");
		expect(input).toContain("multiple");
		expect(input).not.toMatch(/\bdisabled\b/);
		// 只做视觉隐藏：不能用 hidden 属性 / display:none，也不能移出 tab 顺序。
		expect(input).toContain('class="sr-only"');
		expect(input).not.toMatch(/\shidden(=|\s|>)/);
		expect(input).not.toMatch(/display:\s*none/);
		expect(input).not.toContain('tabindex="-1"');
	});

	it("has no <button> forwarding clicks to the input", () => {
		const html = render();
		expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*添加附件/);
	});
});
