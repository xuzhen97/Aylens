import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { SessionProvider, useSession } from "./auth/session-context";
import { OverviewProvider } from "./hooks/use-overview";
import { AdminLayout } from "./components/admin-layout";
import { LoginPage } from "./pages/login";
import { OverviewPage } from "./pages/overview";
import { RuntimesPage } from "./pages/runtimes";
import { ProvidersPage } from "./pages/providers";
import { ProfilesPage } from "./pages/profiles";
import { AuditsPage } from "./pages/audits";
import { TesterPage } from "./pages/tester";

function LoginRoute() {
  const { login, status } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  if (status === "authenticated") return <Navigate to={location.state?.from ?? "/"} replace />;
  return <LoginPage onLogin={async (key) => {
    await login(key);
    const target = location.state?.from;
    navigate(typeof target === "string" && target.startsWith("/") && !target.startsWith("//") ? target : "/", { replace: true });
  }} />;
}

function ProtectedAdmin() {
  const { status } = useSession();
  const location = useLocation();
  if (status === "loading") return <main className="grid min-h-screen place-items-center text-sm text-slate-500">正在检查管理会话…</main>;
  if (status !== "authenticated") return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <OverviewProvider><Outlet /></OverviewProvider>;
}

export function App() {
  return <BrowserRouter basename="/admin"><SessionProvider><Routes>
    <Route path="/login" element={<LoginRoute />} />
    <Route element={<ProtectedAdmin />}>
      <Route element={<AdminLayout />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/runtimes" element={<RuntimesPage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/profiles" element={<ProfilesPage />} />
        <Route path="/audits" element={<AuditsPage />} />
        <Route path="/tester" element={<TesterPage />} />
      </Route>
    </Route>
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></SessionProvider></BrowserRouter>;
}
