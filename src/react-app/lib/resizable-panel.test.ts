// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
	DETAIL_PANEL_DEFAULT_WIDTH,
	DETAIL_PANEL_MAX_WIDTH,
	DETAIL_PANEL_MIN_WIDTH,
	DETAIL_PANEL_STORAGE_KEY,
	clampPanelWidth,
	clearStoredPanelWidth,
	initialPanelWidth,
	panelBounds,
	readStoredPanelWidth,
	widthAfterDrag,
	widthAfterKey,
	writeStoredPanelWidth,
} from "./resizable-panel";

afterEach(() => localStorage.clear());

describe("panelBounds (#96)", () => {
	it("min 360, max = min(800, 60% viewport, container - 320)", () => {
		expect(DETAIL_PANEL_MIN_WIDTH).toBe(360);
		expect(DETAIL_PANEL_MAX_WIDTH).toBe(800);
		expect(DETAIL_PANEL_DEFAULT_WIDTH).toBe(448);
		expect(panelBounds(1920)).toEqual({ min: 360, max: 800 });
		expect(panelBounds(1280)).toEqual({ min: 360, max: 768 });
		// 1280 视口，左导航 256 → 容器 1024，列表至少留 320
		expect(panelBounds(1280, 1024)).toEqual({ min: 360, max: 704 });
		// 1024 视口：容器 768 → 最宽 448（= 默认），只能往窄拖
		expect(panelBounds(1024, 768)).toEqual({ min: 360, max: 448 });
	});

	it("max never drops below min on very narrow containers", () => {
		expect(panelBounds(1024, 500)).toEqual({ min: 360, max: 360 });
		expect(panelBounds(400)).toEqual({ min: 360, max: 360 });
	});

	it("ignores an unknown / zero container", () => {
		expect(panelBounds(1920, 0)).toEqual(panelBounds(1920));
		expect(panelBounds(1920, Number.NaN)).toEqual(panelBounds(1920));
	});
});

describe("clampPanelWidth", () => {
	const bounds = { min: 360, max: 700 };
	it("clamps and rounds", () => {
		expect(clampPanelWidth(100, bounds)).toBe(360);
		expect(clampPanelWidth(5000, bounds)).toBe(700);
		expect(clampPanelWidth(500.6, bounds)).toBe(501);
		expect(clampPanelWidth(Number.NaN, bounds)).toBe(360);
	});
});

describe("persist / restore / reset", () => {
	it("round-trips through localStorage", () => {
		expect(readStoredPanelWidth()).toBeNull();
		writeStoredPanelWidth(612.4);
		expect(localStorage.getItem(DETAIL_PANEL_STORAGE_KEY)).toBe("612");
		expect(readStoredPanelWidth()).toBe(612);
		clearStoredPanelWidth();
		expect(readStoredPanelWidth()).toBeNull();
	});

	it("treats garbage as missing", () => {
		localStorage.setItem(DETAIL_PANEL_STORAGE_KEY, "wide");
		expect(readStoredPanelWidth()).toBeNull();
		localStorage.setItem(DETAIL_PANEL_STORAGE_KEY, "-5");
		expect(readStoredPanelWidth()).toBeNull();
	});

	it("initial width = stored (clamped) or default", () => {
		const bounds = panelBounds(1280, 1024);
		expect(initialPanelWidth(448, bounds)).toBe(448);
		writeStoredPanelWidth(600);
		expect(initialPanelWidth(448, bounds)).toBe(600);
		writeStoredPanelWidth(2000);
		expect(initialPanelWidth(448, bounds)).toBe(704);
		writeStoredPanelWidth(10);
		expect(initialPanelWidth(448, bounds)).toBe(360);
	});

	it("uses a custom key without touching the default one", () => {
		writeStoredPanelWidth(500, "other");
		expect(readStoredPanelWidth("other")).toBe(500);
		expect(readStoredPanelWidth()).toBeNull();
	});
});

describe("drag + keyboard math", () => {
	const bounds = { min: 360, max: 700 };
	it("dragging the left edge left widens, right narrows, clamped", () => {
		expect(widthAfterDrag(448, 800, 700, bounds)).toBe(548);
		expect(widthAfterDrag(448, 800, 850, bounds)).toBe(398);
		expect(widthAfterDrag(448, 800, 0, bounds)).toBe(700);
		expect(widthAfterDrag(448, 800, 1600, bounds)).toBe(360);
	});

	it("arrow keys step 16 (shift 64), Home/End go to min/max, Enter = default", () => {
		expect(widthAfterKey("ArrowLeft", false, 448, bounds, 448)).toBe(464);
		expect(widthAfterKey("ArrowRight", false, 448, bounds, 448)).toBe(432);
		expect(widthAfterKey("ArrowLeft", true, 448, bounds, 448)).toBe(512);
		expect(widthAfterKey("ArrowRight", true, 370, bounds, 448)).toBe(360);
		expect(widthAfterKey("Home", false, 500, bounds, 448)).toBe(360);
		expect(widthAfterKey("End", false, 500, bounds, 448)).toBe(700);
		expect(widthAfterKey("Enter", false, 600, bounds, 448)).toBe(448);
		expect(widthAfterKey("a", false, 600, bounds, 448)).toBeNull();
	});
});
