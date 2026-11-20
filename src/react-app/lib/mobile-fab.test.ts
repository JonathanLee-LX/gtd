import { describe, expect, it } from "vitest";
import { mobileContentPaddingClass, mobileFabBottom, showMobileQuickCollect } from "./mobile-fab";

describe("mobile quick collect clearance", () => {
	it("hides the add button on settings and keeps it on other pages", () => {
		expect(showMobileQuickCollect("/settings")).toBe(false);
		expect(showMobileQuickCollect("/settings/tokens")).toBe(false);
		expect(showMobileQuickCollect("/today")).toBe(true);
		expect(showMobileQuickCollect("/projects/abc")).toBe(true);
	});

	it("reserves the button height plus 16px and safe-area only where the button shows", () => {
		const withFab = mobileContentPaddingClass("/today");
		expect(withFab).toContain("3.5rem+env(safe-area-inset-bottom,0px)+3.5rem+0.75rem+16px");
		expect(withFab).toContain("md:pb-0");
		const settings = mobileContentPaddingClass("/settings");
		expect(settings).not.toContain("16px");
		expect(settings).toContain("env(safe-area-inset-bottom,0px)");
		expect(mobileFabBottom()).toBe("calc(3.5rem + env(safe-area-inset-bottom, 0px) + 0.75rem)");
	});
});