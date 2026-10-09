import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import {
	DETAIL_PANEL_DEFAULT_WIDTH,
	DETAIL_PANEL_STORAGE_KEY,
	clampPanelWidth,
	clearStoredPanelWidth,
	panelBounds,
	readStoredPanelWidth,
	widthAfterDrag,
	widthAfterKey,
	writeStoredPanelWidth,
} from "../lib/resizable-panel";

const viewportWidth = () => (typeof window === "undefined" ? 1280 : window.innerWidth);

type DragState = {
	pointerId: number;
	startX: number;
	startWidth: number;
	lastWidth: number;
	moved: boolean;
};

/**
 * #96：桌面（≥ 1024px）右侧边栏，左边缘可拖拽调宽。所有页面共用（TaskBoard 里渲染），
 * 宽度存 localStorage，刷新 / 切页面后保持；双击手柄（或聚焦后按 Enter）恢复默认。
 *
 * - 只在侧栏布局下渲染；< 1024px 的全屏详情（#94）和手机端根本不挂这个组件，没有手柄。
 * - 首帧同步读取保存值，不会先按默认宽度渲染再跳。
 * - 窗口 / 容器变窄时显示宽度自动夹到允许范围；保存的偏好不改，窗口拉宽后恢复。
 * - 宽度状态只在本组件里，拖动时不重渲染 TaskBoard / TaskDetail（详情是 portal 进来的）。
 */
export function ResizableSidePanel({
	children,
	className,
	storageKey = DETAIL_PANEL_STORAGE_KEY,
	defaultWidth = DETAIL_PANEL_DEFAULT_WIDTH,
	handleLabel = "调整详情宽度",
	...asideProps
}: {
	children: ReactNode;
	className?: string;
	storageKey?: string;
	defaultWidth?: number;
	handleLabel?: string;
	"aria-label"?: string;
	id?: string;
}) {
	const asideRef = useRef<HTMLElement>(null);
	const [viewport, setViewport] = useState(viewportWidth);
	/** 边栏所在 flex 容器（列表 + 边栏）的宽度；首帧前在 layout effect 里量。 */
	const [container, setContainer] = useState<number | undefined>(undefined);
	/** 用户偏好宽度（未夹取）。 */
	const [preferred, setPreferred] = useState<number>(
		() => readStoredPanelWidth(storageKey) ?? defaultWidth,
	);
	const [dragging, setDragging] = useState(false);
	const dragRef = useRef<DragState | null>(null);

	const bounds = panelBounds(viewport, container);
	const width = clampPanelWidth(preferred, bounds);

	useLayoutEffect(() => {
		const parent = asideRef.current?.parentElement;
		const measure = () => {
			setViewport(viewportWidth());
			if (parent) setContainer(parent.clientWidth || undefined);
		};
		measure();
		window.addEventListener("resize", measure);
		let observer: ResizeObserver | undefined;
		if (parent && typeof ResizeObserver !== "undefined") {
			observer = new ResizeObserver(measure);
			observer.observe(parent);
		}
		return () => {
			window.removeEventListener("resize", measure);
			observer?.disconnect();
		};
	}, []);

	// 其它标签页改了宽度时跟着变。
	useEffect(() => {
		function onStorage(event: StorageEvent) {
			if (event.key !== storageKey) return;
			setPreferred(readStoredPanelWidth(storageKey) ?? defaultWidth);
		}
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [storageKey, defaultWidth]);

	const setBodyDragStyles = useCallback((on: boolean) => {
		const style = document.body.style;
		style.cursor = on ? "col-resize" : "";
		style.userSelect = on ? "none" : "";
		style.webkitUserSelect = on ? "none" : "";
	}, []);

	const endDrag = useCallback(
		(commit: boolean) => {
			const drag = dragRef.current;
			if (!drag) return;
			dragRef.current = null;
			setDragging(false);
			setBodyDragStyles(false);
			if (commit && drag.moved) {
				setPreferred(drag.lastWidth);
				writeStoredPanelWidth(drag.lastWidth, storageKey);
			}
		},
		[setBodyDragStyles, storageKey],
	);

	useEffect(() => () => endDrag(false), [endDrag]);

	const reset = useCallback(() => {
		clearStoredPanelWidth(storageKey);
		setPreferred(defaultWidth);
	}, [storageKey, defaultWidth]);

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		// 鼠标只认主键；笔 / 触屏笔记本的触摸也可以拖。
		if (event.pointerType === "mouse" && event.button !== 0) return;
		event.preventDefault(); // 不开始选中文字
		event.currentTarget.focus({ preventScroll: true });
		try {
			event.currentTarget.setPointerCapture?.(event.pointerId);
		} catch {
			// ignore (old browsers / tests)
		}
		dragRef.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startWidth: width,
			lastWidth: width,
			moved: false,
		};
		setDragging(true);
		setBodyDragStyles(true);
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		event.preventDefault();
		const next = widthAfterDrag(drag.startWidth, drag.startX, event.clientX, bounds);
		if (next !== drag.startWidth) drag.moved = true;
		drag.lastWidth = next;
		setPreferred(next);
	}

	function onPointerUp(event: PointerEvent<HTMLDivElement>) {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId) return;
		try {
			event.currentTarget.releasePointerCapture?.(event.pointerId);
		} catch {
			// ignore
		}
		endDrag(true);
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Enter") {
			event.preventDefault();
			reset();
			return;
		}
		const next = widthAfterKey(event.key, event.shiftKey, width, bounds, defaultWidth);
		if (next === null) return;
		event.preventDefault();
		setPreferred(next);
		writeStoredPanelWidth(next, storageKey);
	}

	return (
		<aside
			{...asideProps}
			ref={asideRef}
			data-resizable-panel=""
			data-dragging={dragging ? "" : undefined}
			style={{ width }}
			className={cn("relative flex shrink-0 flex-col border-l bg-card", className)}
		>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label={handleLabel}
				aria-valuenow={width}
				aria-valuemin={bounds.min}
				aria-valuemax={bounds.max}
				aria-controls={asideProps.id}
				title="拖动调整宽度，双击恢复默认"
				tabIndex={0}
				data-panel-resize-handle=""
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={() => endDrag(true)}
				onLostPointerCapture={() => endDrag(true)}
				onDoubleClick={(event) => {
					event.preventDefault();
					reset();
				}}
				onKeyDown={onKeyDown}
				className={cn(
					"group absolute inset-y-0 -left-1.5 z-20 w-3 cursor-col-resize touch-none select-none outline-none",
				)}
			>
				<span
					aria-hidden
					className={cn(
						"pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors",
						"group-hover:bg-primary/40 group-focus-visible:bg-primary",
						dragging && "bg-primary",
					)}
				/>
			</div>
			{children}
		</aside>
	);
}
