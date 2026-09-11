import { ThemeProvider } from "next-themes";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { ProjectPage } from "./pages/ProjectPage";
import { ReviewPage } from "./pages/ReviewPage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsPage } from "./pages/SettingsPage";
import { Shell } from "./pages/Shell";
import { StatusListPage } from "./pages/StatusListPage";
import { TodayPage } from "./pages/TodayPage";

export default function App() {
	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
			<TooltipProvider>
				<Toaster />
				<BrowserRouter>
					<Routes>
						<Route path="/login" element={<LoginPage />} />
						<Route path="/" element={<Shell />}>
							<Route index element={<Navigate to="/today" replace />} />
							<Route path="today" element={<TodayPage />} />
							<Route path="next" element={<StatusListPage status="next" />} />
							<Route path="waiting" element={<StatusListPage status="waiting" />} />
							<Route path="scheduled" element={<StatusListPage status="scheduled" />} />
							<Route path="someday" element={<StatusListPage status="someday" />} />
							<Route path="inbox" element={<InboxPage />} />
							<Route path="review" element={<ReviewPage />} />
							<Route path="search" element={<SearchPage />} />
							<Route path="projects/:id" element={<ProjectPage />} />
							<Route path="settings" element={<SettingsPage />} />
						</Route>
					</Routes>
				</BrowserRouter>
			</TooltipProvider>
		</ThemeProvider>
	);
}
