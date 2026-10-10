import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// App icon 方案 C：index.html 的图标链接、site.webmanifest 与 public/ 里的文件保持一致。
const root = process.cwd();
const publicDir = resolve(root, "public");
const html = readFileSync(resolve(root, "index.html"), "utf8");

function pngSize(file: string) {
	const buf = readFileSync(resolve(publicDir, file));
	expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
	return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

describe("index.html icons", () => {
	it("links the adaptive SVG favicon, ICO fallback, apple-touch-icon and manifest", () => {
		expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
		expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="32x32" />');
		expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
		expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
		expect(html).not.toContain("vite.svg");
		expect(existsSync(resolve(publicDir, "vite.svg"))).toBe(false);
	});

	it("sets light/dark theme-color", () => {
		expect(html).toMatch(/<meta name="theme-color" content="#FFFFFF" media="\(prefers-color-scheme: light\)" \/>/);
		expect(html).toMatch(/<meta name="theme-color" content="#0A0A0A" media="\(prefers-color-scheme: dark\)" \/>/);
	});

	it("every linked icon exists in public/", () => {
		for (const href of ["favicon.svg", "favicon.ico", "apple-touch-icon.png", "site.webmanifest"]) {
			expect(existsSync(resolve(publicDir, href)), href).toBe(true);
		}
		expect(pngSize("apple-touch-icon.png")).toBe("180x180");
	});
});

describe("site.webmanifest", () => {
	const manifest = JSON.parse(readFileSync(resolve(publicDir, "site.webmanifest"), "utf8")) as {
		name: string;
		short_name: string;
		start_url: string;
		display: string;
		theme_color: string;
		background_color: string;
		icons: { src: string; sizes: string; type: string; purpose: string }[];
	};

	it("has app name, start_url and colors", () => {
		expect(manifest.name).toBe("GTD 工作台");
		expect(manifest.short_name).toBe("GTD");
		expect(manifest.start_url).toBe("/");
		expect(manifest.display).toBe("standalone");
		expect(manifest.theme_color).toMatch(/^#[0-9A-F]{6}$/i);
		expect(manifest.background_color).toMatch(/^#[0-9A-F]{6}$/i);
	});

	it("declares 192/512 any + 512 maskable icons that exist with matching sizes", () => {
		const keys = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
		expect(keys).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
		for (const icon of manifest.icons) {
			expect(icon.type).toBe("image/png");
			expect(icon.src.startsWith("/")).toBe(true);
			expect(pngSize(icon.src.slice(1))).toBe(icon.sizes);
		}
	});
});
