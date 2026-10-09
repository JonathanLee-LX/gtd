import { describe, expect, it } from "vitest";
import type { Project } from "../api";
import { projectPickerItems } from "./project-items";

const p = (id: string, name: string): Project => ({ id, name, color: null, isInbox: false, archivedAt: null, sortOrder: 0 });

describe("projectPickerItems (#101)", () => {
	it("maps loaded projects", () => {
		expect(projectPickerItems([p("a", "A"), p("b", "B")], { id: "a", name: "A" })).toEqual([
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
		]);
	});
	it("keeps the current project selectable while the list is still loading", () => {
		expect(projectPickerItems([], { id: "x", name: "收件箱" })).toEqual([{ value: "x", label: "收件箱" }]);
		expect(projectPickerItems([], { id: "x", name: "" })).toEqual([{ value: "x", label: "当前项目" }]);
		expect(projectPickerItems([])).toEqual([]);
	});
});
