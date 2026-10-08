import { LayoutDashboard, LogOut, Moon, RefreshCw, Server, Sun, Search, Puzzle, PanelsTopLeft, FileClock, Network } from "lucide-react";
import { NavLink, Outlet } from "react-router-dom";
import { useSession } from "../auth/session-context";
import { useOverview } from "../hooks/use-overview";
import { useTheme } from "../hooks/use-theme";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";

const navigation = [
  { to: "/", label: "系统总览", icon: LayoutDashboard, end: true },
  { to: "/runtimes", label: "Runtime / Runner", icon: Server },
  { to: "/providers", label: "Providers", icon: Puzzle },
  { to: "/proxies", label: "代理配置", icon: Network },
  { to: "/profiles", label: "Browser Profiles", icon: PanelsTopLeft },
  { to: "/audits", label: "检索审计", icon: FileClock },
  { to: "/tester", label: "请求测试", icon: Search },
];

export function AdminLayout() {
  const { logout, session } = useSession();
  const { autoRefresh, data, error, loading, refresh, setAutoRefresh } = useOverview();
  const { mode, setMode } = useTheme();

  return <div className="min-h-screen bg-slate-50 text-slate-950 md:grid md:grid-cols-[250px_1fr]">
    <aside className="border-b border-slate-200 bg-white p-4 md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
      <div className="flex items-center gap-3 px-2 py-3">
        <div className="grid size-10 place-items-center rounded-xl bg-slate-900 font-bold text-white">A</div>
        <div><strong className="block tracking-widest">AYLENS</strong><span className="text-xs text-slate-500">Retrieval Control Plane</span></div>
      </div>
      <Separator className="my-4" />
      <nav aria-label="后台导航" className="grid grid-cols-2 gap-1 md:grid-cols-1">
        {navigation.map(({ to, label, icon: Icon, end }) => <NavLink key={to} to={to} end={end}
          className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm ${isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}>
          <Icon aria-hidden="true" size={17} />{label}
        </NavLink>)}
      </nav>
      <div className="mt-5 hidden rounded-lg bg-slate-50 p-3 text-xs text-slate-600 md:block">
        <span className={`mr-2 inline-block size-2 rounded-full ${session ? "bg-emerald-500" : "bg-slate-300"}`} />
        {session ? "管理 API 已连接" : "正在检查会话"}
      </div>
    </aside>
    <main className="min-w-0 p-4 sm:p-6 lg:p-8">
      <header className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <span className="text-xs font-semibold tracking-widest text-slate-500">CONTROL PLANE</span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />5 秒自动刷新
          </label>
          <label className="sr-only" htmlFor="theme-mode">主题</label>
          <select id="theme-mode" aria-label="主题" className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm" value={mode}
            onChange={(event) => setMode(event.target.value as "system" | "light" | "dark")}>
            <option value="system">跟随系统</option><option value="light">亮色</option><option value="dark">暗色</option>
          </select>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading} aria-label="立即刷新">
            <RefreshCw size={15} />刷新
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void logout()} aria-label="退出登录"><LogOut size={15} />退出</Button>
          <span className="sr-only" aria-hidden="true"><Sun /><Moon /></span>
        </div>
      </header>
      <section className="mx-auto mt-8 max-w-7xl">
        {error ? <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        <Outlet context={{ data, loading, refresh }} />
      </section>
    </main>
  </div>;
}
