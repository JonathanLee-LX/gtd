import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Task } from "../api";
import {
	applyOptimisticTaskPatch,
	removeTaskFromCaches,
	restoreTaskQueries,
	snapshotTaskQueries,
	stripSourceFromBody,
	taskMatchesListFilters,
	upsertTaskInCaches,
} from "./task-cache";
import { taskKeys } from "./task-query-keys";

function makeTask(overrides: Partial<Task> = {}): Task {
	return {
		id: "t1",
		title: "Task",
		notes: null,
		status: "next",
		priority: "none",
		dueAt: null,
		startAt: null,
		waitingOn: null,
		projectId: "p1",
		projectName: "Inbox",
		parentId: null,
		source: "human",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		completedAt: null,
		deletedAt: null,
		tags: [],
		...overrides,
	};
}

describe("taskMatchesListFilters", () => {
	it("matches status and project shards", () => {
		const task = makeTask({ status: "waiting", projectId: "p2" });
		expect(taskMatchesListFilters(task, { status: "waiting" })).toBe(true);
		expect(taskMatchesListFilters(task, { status: "next" })).toBe(false);
		expect(taskMatchesListFilters(task, { projectId: "p2" })).toBe(true);
		expect(taskMatchesListFilters(task, { projectId: "p1" })).toBe(false);
	});

	it("inbox: true matches the inbox project and optimistic rows without a project id (#105)", () => {
		const inboxTask = makeTask({ projectId: "inbox-id", projectName: "收件箱", status: "inbox" });
		const optimistic = makeTask({ id: "tmp-1", projectId: "", projectName: "收件箱", status: "inbox" });
		const other = makeTask({ projectId: "p2", projectName: "装修", status: "next" });
		expect(taskMatchesListFilters(inboxTask, { inbox: true })).toBe(true);
		expect(taskMatchesListFilters(optimistic, { inbox: true })).toBe(true);
		expect(taskMatchesListFilters(other, { inbox: true })).toBe(false);
		expect(taskMatchesListFilters(makeTask({ status: "completed", projectName: "收件箱" }), { inbox: true })).toBe(
			false,
		);
	});

	it("hides completed unless includeCompleted", () => {
		const task = makeTask({ status: "completed" });
		expect(taskMatchesListFilters(task, { projectId: "p1" })).toBe(false);
		expect(taskMatchesListFilters(task, { projectId: "p1", includeCompleted: "true" })).toBe(
			true,
		);
	});
});

describe("shared task cache", () => {
	it("moves a task into and out of the inbox:true shard (#105)", () => {
		const qc = new QueryClient();
		qc.setQueryData(taskKeys.list({ inbox: true }), { items: [] as Task[], nextCursor: null });
		const task = makeTask({ projectId: "inbox-id", projectName: "收件箱", status: "inbox" });
		upsertTaskInCaches(qc, task);
		expect(qc.getQueryData<{ items: Task[] }>(taskKeys.list({ inbox: true }))?.items.map((item) => item.id)).toEqual([
			"t1",
		]);
		upsertTaskInCaches(qc, { ...task, projectId: "p9", projectName: "其它", status: "next" });
		expect(qc.getQueryData<{ items: Task[] }>(taskKeys.list({ inbox: true }))?.items).toEqual([]);
	});

	it("keeps focus + status shards in sync on status change", () => {
		const qc = new QueryClient();
		const task = makeTask({ status: "next", priority: "none", dueAt: null });
		qc.setQueryData(taskKeys.focus(), { today: "2026-09-12", items: [task] });
		qc.setQueryData(taskKeys.list({ status: "next" }), {
			items: [task],
			nextCursor: null,
		});
		qc.setQueryData(taskKeys.list({ status: "waiting" }), {
			items: [] as Task[],
			nextCursor: null,
		});

		const updated = { ...task, status: "waiting" as const };
		upsertTaskInCaches(qc, updated);

		expect(qc.getQueryData<{ items: Task[] }>(taskKeys.focus())?.items).toEqual([]);
		expect(qc.getQueryData<{ items: Task[] }>(taskKeys.list({ status: "next" }))?.items).toEqual(
			[],
		);
		expect(
			qc.getQueryData<{ items: Task[] }>(taskKeys.list({ status: "waiting" }))?.items[0]?.status,
		).toBe("waiting");
	});

	it("removeTaskFromCaches clears every shard", () => {
		const qc = new QueryClient();
		const task = makeTask();
		qc.setQueryData(taskKeys.focus(), { today: "2026-09-12", items: [task] });
		qc.setQueryData(taskKeys.list({ status: "next" }), { items: [task], nextCursor: null });
		removeTaskFromCaches(qc, task.id);
		expect(qc.getQueryData<{ items: Task[] }>(taskKeys.focus())?.items).toEqual([]);
		expect(qc.getQueryData<{ items: Task[] }>(taskKeys.list({ status: "next" }))?.items).toEqual(
			[],
		);
	});

	it("optimistic patch rolls back via snapshot", () => {
		const qc = new QueryClient();
		const task = makeTask({ title: "Before" });
		qc.setQueryData(taskKeys.list({ status: "next" }), { items: [task], nextCursor: null });
		const snap = snapshotTaskQueries(qc);
		applyOptimisticTaskPatch(qc, task.id, { title: "After" });
		expect(
			qc.getQueryData<{ items: Task[] }>(taskKeys.list({ status: "next" }))?.items[0]?.title,
		).toBe("After");
		restoreTaskQueries(qc, snap);
		expect(
			qc.getQueryData<{ items: Task[] }>(taskKeys.list({ status: "next" }))?.items[0]?.title,
		).toBe("Before");
	});

	it("stripSourceFromBody drops source", () => {
		expect(stripSourceFromBody({ title: "x", source: "mcp" })).toEqual({ title: "x" });
	});

	it("does not blank sibling caches when upserting", () => {
		const qc = new QueryClient();
		const a = makeTask({ id: "a", status: "next" });
		const b = makeTask({ id: "b", status: "inbox", projectId: "inbox" });
		qc.setQueryData(taskKeys.list({ status: "next" }), { items: [a], nextCursor: null });
		qc.setQueryData(taskKeys.list({ projectId: "inbox" }), { items: [b], nextCursor: null });
		upsertTaskInCaches(qc, { ...a, title: "A2" });
		expect(
			qc.getQueryData<{ items: Task[] }>(taskKeys.list({ projectId: "inbox" }))?.items,
		).toEqual([b]);
		expect(
			qc.getQueryData<{ items: Task[] }>(taskKeys.list({ status: "next" }))?.items[0]?.title,
		).toBe("A2");
	});
});
