/** 底栏高度，与 MobileBottomNav 的 h-14 一致。「+」边长也是 3.5rem（size-14）。 */
export const MOBILE_NAV_HEIGHT = "3.5rem";
/** 「+」底边离底栏的距离。 */
export const MOBILE_FAB_GAP = "0.75rem";

/** 设置页不放「+」，避免盖住卡片底部。 */
export function showMobileQuickCollect(pathname: string): boolean {
	return !pathname.startsWith("/settings");
}

/**
 * 「+」的 bottom。外壳已经为底栏留出同样的 3.5rem + safe-area，
 * 按钮再往上 0.75rem。
 */
export function mobileFabBottom(): string {
	return `calc(${MOBILE_NAV_HEIGHT} + env(safe-area-inset-bottom, 0px) + ${MOBILE_FAB_GAP})`;
}

/**
 * 有「+」的页面，内容区底部多留出按钮伸进列表的高度（3.5rem + 0.75rem）和 16px。
 * class 必须写成完整字面量，Tailwind 才扫得到。safe-area 算在同一条 calc 里。
 * 桌面没有「+」，padding 归零。
 */
export function mobileContentPaddingClass(pathname: string): string {
	if (showMobileQuickCollect(pathname)) {
		return "pb-[calc(3.5rem+env(safe-area-inset-bottom,0px)+3.5rem+0.75rem+16px)] md:pb-0";
	}
	return "pb-[calc(3.5rem+env(safe-area-inset-bottom,0px))] md:pb-0";
}
