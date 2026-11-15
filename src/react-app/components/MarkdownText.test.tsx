// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownText } from "./MarkdownText";

describe("MarkdownText", () => {
	it("renders headings (h1, h2, h3)", () => {
		const md = "# 标题一\n## 标题二\n### 标题三";
		const { container } = render(<MarkdownText>{md}</MarkdownText>);

		const h1 = container.querySelector("h1");
		const h2 = container.querySelector("h2");
		const h3 = container.querySelector("h3");

		expect(h1).not.toBeNull();
		expect(h1?.textContent).toBe("标题一");
		expect(h2).not.toBeNull();
		expect(h2?.textContent).toBe("标题二");
		expect(h3).not.toBeNull();
		expect(h3?.textContent).toBe("标题三");
	});

	it("renders unordered and ordered lists", () => {
		const md = "- 列表项一\n- 列表项二\n\n1. 第一步\n2. 第二步";
		const { container } = render(<MarkdownText>{md}</MarkdownText>);

		const ul = container.querySelector("ul");
		const ol = container.querySelector("ol");
		const lis = container.querySelectorAll("li");

		expect(ul).not.toBeNull();
		expect(ol).not.toBeNull();
		expect(lis.length).toBe(4);
		expect(lis[0]?.textContent).toBe("列表项一");
		expect(lis[2]?.textContent).toBe("第一步");
	});

	it("renders GFM task list with disabled checkboxes", () => {
		const md = "- [ ] 待办任务\n- [x] 已完成任务";
		const { container } = render(<MarkdownText>{md}</MarkdownText>);

		const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		expect(checkboxes.length).toBe(2);
		expect(checkboxes[0]?.checked).toBe(false);
		expect(checkboxes[0]?.disabled).toBe(true);
		expect(checkboxes[1]?.checked).toBe(true);
		expect(checkboxes[1]?.disabled).toBe(true);
	});

	it("renders inline code and code block", () => {
		const md = "这是 `const a = 1;` 行内代码\n\n```ts\nfunction hello() {\n  return 'world';\n}\n```";
		const { container } = render(<MarkdownText>{md}</MarkdownText>);

		const pre = container.querySelector("pre");
		expect(pre).not.toBeNull();
		expect(pre?.textContent).toContain("function hello()");

		const codes = container.querySelectorAll("code");
		expect(codes.length).toBeGreaterThanOrEqual(2);
		const inline = Array.from(codes).find((c) => c.textContent === "const a = 1;");
		expect(inline).toBeDefined();
	});

	it("renders safe links with target=_blank and rel=noopener noreferrer", () => {
		const md = "[官方链接](https://example.com)";
		render(<MarkdownText>{md}</MarkdownText>);

		const link = screen.getByRole("link", { name: "官方链接" });
		expect(link).toBeDefined();
		expect(link.getAttribute("href")).toBe("https://example.com");
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toBe("noopener noreferrer");
	});

	it("renders GFM table", () => {
		const md = "| 姓名 | 角色 |\n| :--- | :--- |\n| 张三 | 管理员 |\n| 李四 | 成员 |";
		const { container } = render(<MarkdownText>{md}</MarkdownText>);

		const table = container.querySelector("table");
		expect(table).not.toBeNull();

		const ths = container.querySelectorAll("th");
		expect(ths.length).toBe(2);
		expect(ths[0]?.textContent).toBe("姓名");
		expect(ths[1]?.textContent).toBe("角色");

		const tds = container.querySelectorAll("td");
		expect(tds.length).toBe(4);
		expect(tds[0]?.textContent).toBe("张三");
		expect(tds[3]?.textContent).toBe("成员");
	});

	it("renders strikethrough", () => {
		const md = "~~已废弃~~";
		const { container } = render(<MarkdownText>{md}</MarkdownText>);

		const del = container.querySelector("del");
		expect(del).not.toBeNull();
		expect(del?.textContent).toBe("已废弃");
	});

	describe("XSS safety", () => {
		it("does not execute or render script tags as executable DOM elements", () => {
			const md = "<script>window.__xss_executed = true;</script>";
			const { container } = render(<MarkdownText>{md}</MarkdownText>);

			const script = container.querySelector("script");
			expect(script).toBeNull();
			expect((window as unknown as Record<string, unknown>).__xss_executed).toBeUndefined();
			expect(container.textContent).toContain("<script>window.__xss_executed = true;</script>");
		});

		it("does not execute or render raw img tags with onerror handlers", () => {
			const md = '<img src="invalid-src" onerror="window.__xss_img = true" />';
			const { container } = render(<MarkdownText>{md}</MarkdownText>);

			const img = container.querySelector("img");
			expect(img).toBeNull();
			expect((window as unknown as Record<string, unknown>).__xss_img).toBeUndefined();
		});

		it("does not render javascript: links as clickable links", () => {
			const md = "[恶意链接](javascript:window.__xss_js_link=true)";
			const { container } = render(<MarkdownText>{md}</MarkdownText>);

			const link = screen.queryByRole("link", { name: "恶意链接" });
			expect(link).toBeNull();
			const anchor = container.querySelector('a[href^="javascript:"]');
			expect(anchor).toBeNull();

			// 渲染为普通非可点文本
			expect(container.textContent).toContain("恶意链接");
			expect((window as unknown as Record<string, unknown>).__xss_js_link).toBeUndefined();
		});

		it("does not render data: or vbscript: links as clickable links", () => {
			const md = "[VB](vbscript:alert(1)) 和 [Data](data:text/html,<script>alert(1)</script>)";
			const { container } = render(<MarkdownText>{md}</MarkdownText>);

			expect(screen.queryByRole("link", { name: "VB" })).toBeNull();
			expect(screen.queryByRole("link", { name: "Data" })).toBeNull();
			expect(container.querySelectorAll("a").length).toBe(0);
		});
	});

	it("renders nothing when children is null or empty", () => {
		const { container: c1 } = render(<MarkdownText>{null}</MarkdownText>);
		expect(c1.innerHTML).toBe("");

		const { container: c2 } = render(<MarkdownText>{""}</MarkdownText>);
		expect(c2.innerHTML).toBe("");
	});
});
