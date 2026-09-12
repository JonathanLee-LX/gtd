import type { TaskDraft, TaskPriority, TaskStatus } from "../shared/schemas";

export type Tag = { id: string; name: string };

export type Project = {
	id: string;
	name: string;
	color: string | null;
	isInbox: boolean;
	archivedAt: string | null;
	sortOrder: number;
};

export type Task = {
	id: string;
	title: string;
	notes: string | null;
	status: TaskStatus;
	priority: TaskPriority;
	dueAt: string | null;
	startAt: string | null;
	waitingOn: string | null;
	projectId: string;
	projectName: string;
	parentId: string | null;
	source: string;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	deletedAt: string | null;
	tags: Tag[];
};

export type Me = { user: { id: string; email: string; name: string }; source: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (init.body && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json");
	}
	const response = await fetch(path, { credentials: "include", ...init, headers });
	const data = (await response.json().catch(() => ({}))) as T & {
		message?: string;
		error?: string;
	};
	if (!response.ok) {
		throw new Error(data.message || data.error || `请求失败 (${response.status})`);
	}
	return data;
}

export const api = {
	me: () => request<Me>("/api/me"),
	health: () => request<{ ok: boolean; signupEnabled: boolean }>("/api/health"),
	signIn: (email: string, password: string) =>
		request("/api/auth/sign-in/email", {
			method: "POST",
			body: JSON.stringify({ email, password }),
		}),
	signUp: (name: string, email: string, password: string) =>
		request("/api/auth/sign-up/email", {
			method: "POST",
			body: JSON.stringify({ name, email, password }),
		}),
	signOut: () => request("/api/auth/sign-out", { method: "POST" }),
	projects: () => request<{ items: Project[] }>("/api/projects"),
	createProject: (name: string) =>
		request<{ project: Project }>("/api/projects", {
			method: "POST",
			body: JSON.stringify({ name }),
		}),
	deleteProject: (id: string) =>
		request(`/api/projects/${id}`, { method: "DELETE" }),
	tasks: (query: Record<string, string | undefined>) => {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (value) params.set(key, value);
		}
		const suffix = params.size ? `?${params}` : "";
		return request<{ items: Task[]; nextCursor: string | null }>(`/api/tasks${suffix}`);
	},
	focus: () => request<{ today: string; items: Task[] }>("/api/tasks/focus"),
	createTask: (body: Record<string, unknown>) =>
		request<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(body) }),
	updateTask: (id: string, body: Record<string, unknown>) =>
		request<{ task: Task }>(`/api/tasks/${id}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
	completeTask: (id: string) =>
		request<{ task: Task }>(`/api/tasks/${id}/complete`, { method: "POST" }),
	nudgeWaiting: (id: string) =>
		request<{ task: Task }>(`/api/tasks/${id}/nudge`, { method: "POST" }),
	deleteTask: (id: string) =>
		request<{ ok: true }>(`/api/tasks/${id}`, { method: "DELETE" }),
	deletedTasks: () => request<{ items: Task[] }>("/api/tasks/deleted"),
	restoreTask: (id: string) =>
		request<{ task: Task }>(`/api/tasks/${id}/restore`, { method: "POST" }),
	tags: () => request<{ items: Tag[] }>("/api/tags"),
	createTag: (name: string) =>
		request<{ tag: Tag }>("/api/tags", {
			method: "POST",
			body: JSON.stringify({ name }),
		}),
	tokens: () =>
		request<{
			items: {
				id: string;
				name: string;
				prefix: string;
				createdAt: string;
				revokedAt: string | null;
				lastUsedAt: string | null;
			}[];
		}>("/api/tokens"),
	createToken: (name: string) =>
		request<{ id: string; name: string; token: string; prefix: string; createdAt: string }>(
			"/api/tokens",
			{ method: "POST", body: JSON.stringify({ name }) },
		),
	revokeToken: (id: string) => request(`/api/tokens/${id}`, { method: "DELETE" }),
	parseAi: (text: string) =>
		request<{ tasks: TaskDraft[] }>("/api/ai/parse", {
			method: "POST",
			body: JSON.stringify({ text }),
		}),
	commitAi: (draft: TaskDraft) =>
		request<{ task: Task }>("/api/ai/commit", {
			method: "POST",
			body: JSON.stringify(draft),
		}),
};
