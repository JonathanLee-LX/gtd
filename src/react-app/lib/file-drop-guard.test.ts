// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { installGlobalFileDropGuard, isFileDrag } from "./file-drop-guard";

function dispatchDrag(
	target: EventTarget,
	type: "dragover" | "drop",
	dataTransfer: Partial<DataTransfer> | null,
) {
	const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperty(event, "dataTransfer", { value: dataTransfer, configurable: true });
	target.dispatchEvent(event);
	return event;
}

function makeDataTransfer(
	init: { types?: string[]; files?: File[]; items?: Array<{ kind: string }>; dropEffect?: DataTransfer["dropEffect"] },
): DataTransfer {
	return {
		types: init.types ?? [],
		files: (init.files ?? []) as unknown as FileList,
		items: (init.items ?? []) as unknown as DataTransferItemList,
		dropEffect: init.dropEffect ?? "none",
	} as unknown as DataTransfer;
}

describe("file-drop-guard (#93)", () => {
	let dispose: (() => void) | null = null;

	afterEach(() => {
		dispose?.();
		dispose = null;
	});

	it("detects file drags via files, types, or items, and ignores plain text drags", () => {
		const file = new File(["x"], "a.png", { type: "image/png" });
		expect(isFileDrag(null)).toBe(false);
		expect(isFileDrag(makeDataTransfer({ types: ["text/plain"] }))).toBe(false);
		expect(isFileDrag(makeDataTransfer({ types: ["Files"] }))).toBe(true);
		expect(isFileDrag(makeDataTransfer({ files: [file] }))).toBe(true);
		expect(isFileDrag(makeDataTransfer({ items: [{ kind: "file" }] }))).toBe(true);
	});

	it("prevents default on dragover and drop anywhere on window for file drags", () => {
		dispose = installGlobalFileDropGuard(window);
		const file = new File(["pdf"], "doc.pdf", { type: "application/pdf" });

		const overDt = makeDataTransfer({ types: ["Files"], dropEffect: "move" });
		const overEvent = dispatchDrag(document.body, "dragover", overDt);
		expect(overEvent.defaultPrevented).toBe(true);
		expect(overDt.dropEffect).toBe("none");

		const dropEvent = dispatchDrag(document.body, "drop", makeDataTransfer({ types: ["Files"], files: [file] }));
		expect(dropEvent.defaultPrevented).toBe(true);
	});

	it("does not override dropEffect when an inner drop zone already handled dragover", () => {
		dispose = installGlobalFileDropGuard(window);
		const zone = document.createElement("div");
		document.body.appendChild(zone);
		zone.addEventListener("dragover", (event) => {
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		});

		const dt = makeDataTransfer({ types: ["Files"], dropEffect: "none" });
		const event = dispatchDrag(zone, "dragover", dt);
		expect(event.defaultPrevented).toBe(true);
		expect(dt.dropEffect).toBe("copy");
		zone.remove();
	});

	it("does not interfere with non-file drags and cleans up on dispose", () => {
		dispose = installGlobalFileDropGuard(window);
		const textDrag = dispatchDrag(document.body, "dragover", makeDataTransfer({ types: ["text/plain"] }));
		expect(textDrag.defaultPrevented).toBe(false);

		dispose();
		dispose = null;
		const afterDispose = dispatchDrag(
			document.body,
			"drop",
			makeDataTransfer({ types: ["Files"], files: [new File(["x"], "x.png", { type: "image/png" })] }),
		);
		expect(afterDispose.defaultPrevented).toBe(false);
	});
});
