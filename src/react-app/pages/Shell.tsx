import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api, type Me, type Project } from "../api";

export function Shell() {
	const navigate = useNavigate();
	const [me, setMe] = useState<Me["user"] | null>(null);
	const [projects, setProjects] = useState<Project[]>([]);
	const [error, setError] = useState<string | null>(null);

	async function load() {
		try {
			const [meRes, projectRes] = await Promise.all([api.me(), api.projects()]);
			setMe(meRes.user);
			setProjects(projectRes.items);
		} catch {
			navigate("/login");
		}
	}

	useEffect(() => {
		void load();
	}, []);

	async function addProject() {
		const name = window.prompt("项目名称");
		if (!name?.trim()) return;
		try {
			await api.createProject(name.trim());
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "创建项目失败");
		}
	}

	async function signOut() {
		await api.signOut();
		navigate("/login");
	}

	if (!me) {
		return (
			<div className="flex min-h-full items-center justify-center text-[#6b6458]">
				加载工作台…
			</div>
		);
	}

	const inbox = projects.find((project) => project.isInbox);
	const rest = projects.filter((project) => !project.isInbox && !project.archivedAt);

	return (
		<div className="flex min-h-full">
			<aside className="flex w-60 shrink-0 flex-col bg-[#1f2a24] text-[#e7efe4]">
				<div className="px-5 py-6">
					<p className="text-xs tracking-[0.25em] text-[#9fb6a6]">GTD</p>
					<p className="mt-2 text-lg">{me.name || me.email}</p>
				</div>
				<nav className="flex flex-col gap-1 px-3 text-sm">
					<NavLink
						to="/today"
						className={({ isActive }) =>
							`rounded-lg px-3 py-2 ${isActive ? "bg-[#2a3b32] text-white" : "text-[#c8e0c2]"}`
						}
					>
						今日焦点
					</NavLink>
					{inbox ? (
						<NavLink
							to="/inbox"
							className={({ isActive }) =>
								`rounded-lg px-3 py-2 ${isActive ? "bg-[#2a3b32] text-white" : "text-[#c8e0c2]"}`
							}
						>
							收件箱
						</NavLink>
					) : null}
					<p className="mt-4 px-3 text-xs tracking-wide text-[#8aa394]">项目</p>
					{rest.map((project) => (
						<NavLink
							key={project.id}
							to={`/projects/${project.id}`}
							className={({ isActive }) =>
								`rounded-lg px-3 py-2 ${isActive ? "bg-[#2a3b32] text-white" : "text-[#c8e0c2]"}`
							}
						>
							{project.name}
						</NavLink>
					))}
					<button
						type="button"
						onClick={() => void addProject()}
						className="rounded-lg px-3 py-2 text-left text-[#9fb6a6]"
					>
						+ 新项目
					</button>
				</nav>
				<div className="mt-auto px-3 py-4">
					{error ? <p className="px-3 pb-2 text-xs text-[#f0c7b8]">{error}</p> : null}
					<NavLink to="/settings" className="block rounded-lg px-3 py-2 text-sm text-[#c8e0c2]">
						设置 / MCP
					</NavLink>
					<button
						type="button"
						onClick={() => void signOut()}
						className="block rounded-lg px-3 py-2 text-sm text-[#9fb6a6]"
					>
						退出
					</button>
				</div>
			</aside>
			<main className="flex min-w-0 flex-1 flex-col bg-[#f3efe4]">
				<Outlet context={{ projects, reloadProjects: load }} />
			</main>
		</div>
	);
}
