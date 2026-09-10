import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { ProjectPage } from "./pages/ProjectPage";
import { SettingsPage } from "./pages/SettingsPage";
import { Shell } from "./pages/Shell";
import { TodayPage } from "./pages/TodayPage";

export default function App() {
	return (
		<BrowserRouter>
			<Routes>
				<Route path="/login" element={<LoginPage />} />
				<Route path="/" element={<Shell />}>
					<Route index element={<Navigate to="/today" replace />} />
					<Route path="today" element={<TodayPage />} />
					<Route path="inbox" element={<InboxPage />} />
					<Route path="projects/:id" element={<ProjectPage />} />
					<Route path="settings" element={<SettingsPage />} />
				</Route>
			</Routes>
		</BrowserRouter>
	);
}
