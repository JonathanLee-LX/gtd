import { useCallback, useEffect, useRef, useState } from "react";

/** 判断拖拽事件是否包含文件（不拦截普通文本选区或页面元素拖拽）。 */
export function isFileDrag(dataTransfer: DataTransfer | null | undefined): boolean {
	if (!dataTransfer) return false;
	if (dataTransfer.files && dataTransfer.files.length > 0) return true;
	if (dataTransfer.types && Array.from(dataTransfer.types).includes("Files")) return true;
	if (dataTransfer.items && Array.from(dataTransfer.items).some((item) => item.kind === "file")) {
		return true;
	}
	return false;
}

/**
 * #93：整页层面拦截默认文件拖放，防止 Chrome 等浏览器直接打开文件离开页面、丢失未保存输入。
 * 只在拖拽包含文件时 preventDefault，不影响文本拖拽；已被内层投放区处理的事件不覆盖其 dropEffect。
 */
export function installGlobalFileDropGuard(target: Window = window): () => void {
	const onDragOver = (event: DragEvent) => {
		if (!isFileDrag(event.dataTransfer)) return;
		if (!event.defaultPrevented && event.dataTransfer) {
			try {
				event.dataTransfer.dropEffect = "none";
			} catch {
				// ignore read-only dataTransfer in tests
			}
		}
		event.preventDefault();
	};
	const onDrop = (event: DragEvent) => {
		if (!isFileDrag(event.dataTransfer)) return;
		event.preventDefault();
	};
	target.addEventListener("dragover", onDragOver);
	target.addEventListener("drop", onDrop);
	return () => {
		target.removeEventListener("dragover", onDragOver);
		target.removeEventListener("drop", onDrop);
	};
}

/**
 * #93：用原生 DOM 事件把整个容器（包括 createPortal 挂入的子树）变成文件投放区。
 * - 用 relatedTarget 判断是否真正离开容器，避免经过子元素时高亮闪烁；
 * - disabled 时仍阻止默认打开行为，但不高亮、不触发上传（可走 onDisabledDrop 提示）。
 */
export function useFileDropZone({
	disabled = false,
	onDropFiles,
	onDisabledDrop,
}: {
	disabled?: boolean;
	onDropFiles: (files: FileList | File[]) => void;
	onDisabledDrop?: () => void;
}) {
	const [node, setNode] = useState<HTMLElement | null>(null);
	const [dragActive, setDragActive] = useState(false);
	const onDropFilesRef = useRef(onDropFiles);
	const onDisabledDropRef = useRef(onDisabledDrop);

	useEffect(() => {
		onDropFilesRef.current = onDropFiles;
		onDisabledDropRef.current = onDisabledDrop;
	}, [onDropFiles, onDisabledDrop]);

	const ref = useCallback((el: HTMLElement | null) => {
		setNode(el);
	}, []);

	useEffect(() => {
		if (disabled) setDragActive(false);
	}, [disabled]);

	useEffect(() => {
		if (!node) {
			setDragActive(false);
			return;
		}
		const onDragEnter = (event: DragEvent) => {
			if (!isFileDrag(event.dataTransfer)) return;
			event.preventDefault();
			if (!disabled) setDragActive(true);
		};
		const onDragOver = (event: DragEvent) => {
			if (!isFileDrag(event.dataTransfer)) return;
			event.preventDefault();
			if (event.dataTransfer) {
				try {
					event.dataTransfer.dropEffect = disabled ? "none" : "copy";
				} catch {
					// ignore read-only dataTransfer in tests
				}
			}
			if (!disabled) setDragActive(true);
		};
		const onDragLeave = (event: DragEvent) => {
			const related = event.relatedTarget as Node | null;
			if (related && node.contains(related)) return;
			setDragActive(false);
		};
		const onDrop = (event: DragEvent) => {
			if (!isFileDrag(event.dataTransfer)) return;
			event.preventDefault();
			setDragActive(false);
			if (disabled) {
				onDisabledDropRef.current?.();
				return;
			}
			const files = event.dataTransfer?.files;
			if (files && files.length > 0) {
				onDropFilesRef.current(files);
			}
		};
		const clear = () => setDragActive(false);

		node.addEventListener("dragenter", onDragEnter);
		node.addEventListener("dragover", onDragOver);
		node.addEventListener("dragleave", onDragLeave);
		node.addEventListener("drop", onDrop);
		window.addEventListener("dragend", clear);
		return () => {
			node.removeEventListener("dragenter", onDragEnter);
			node.removeEventListener("dragover", onDragOver);
			node.removeEventListener("dragleave", onDragLeave);
			node.removeEventListener("drop", onDrop);
			window.removeEventListener("dragend", clear);
		};
	}, [node, disabled]);

	return { ref, dragActive };
}
