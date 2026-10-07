import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/session-context";
import { OverviewProvider } from "../hooks/use-overview";
import { AdminLayout } from "../components/admin-layout";
import { OverviewPage } from "./overview";
import { RuntimesPage } from "./runtimes";
import { ProvidersPage } from "./providers";
import { ProfilesPage } from "./profiles";
import { AuditsPage } from "./audits";
import { TesterPage } from "./tester";
import { emptyOverview, overviewWithOldRunner, partialSearch } from "../test/fixtures";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function renderAt(path: string, overview = emptyOverview) {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(json({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf" }))
    .mockResolvedValue(json(overview));
  const view = render(<MemoryRouter initialEntries={[path]}><SessionProvider><OverviewProvider><Routes>
    <Route element={<AdminLayout />}>
      <Route path="/" element={<OverviewPage />} /><Route path="/runtimes" element={<RuntimesPage />} />
      <Route path="/providers" element={<ProvidersPage />} /><Route path="/profiles" element={<ProfilesPage />} />
      <Route path="/audits" element={<AuditsPage />} /><Route path="/tester" element={<TesterPage />} />
    </Route>
  </Routes></OverviewProvider></SessionProvider></MemoryRouter>);
  return { ...view, fetchMock };
}

describe("Admin pages", () => {
  it("shows overview and safe old-Runner missing fields", async () => {
    const view = renderAt("/", overviewWithOldRunner);
    expect(await screen.findByText("基础设施运行总览")).toBeVisible();
    view.unmount();
    const old = renderAt("/profiles", overviewWithOldRunner);
    expect((await within(old.container).findAllByText("Runner 未上报")).length).toBeGreaterThan(0);
    old.unmount();
  });

  it("offers login and check controls without leaving the Gateway", async () => {
    const view = renderAt("/providers", overviewWithOldRunner);
    const card = await screen.findByText("browserRead");
    const region = card.closest<HTMLElement>(".rounded-xl") ?? card.parentElement!.parentElement!;
    expect(within(region).getByRole("button", { name: /重新登录|登录/ })).toBeVisible();
    expect(within(region).getByRole("button", { name: "检查状态" })).toBeVisible();
    view.unmount();
  });

  it("renders each routed page with its identifying content", async () => {
    const cases = [
      ["/runtimes", "Runtime / Runner"], ["/audits", "检索审计"],
      ["/tester", "请求测试"], ["/", "基础设施运行总览"],
    ];
    for (const [path, heading] of cases) {
      const view = renderAt(path);
      expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
      view.unmount();
    }
  });
});

describe("TesterPage", () => {
  it("preserves tester input across overview updates and renders partial failures", async () => {
    const view = renderAt("/tester", overviewWithOldRunner);
    const query = await screen.findByLabelText("查询 / URL");
    fireEvent.change(query, { target: { value: "hello" } });
    const provider = screen.getByLabelText("Provider");
    fireEvent.change(provider, { target: { value: "browserRead" } });
    fireEvent.click(screen.getByRole("button", { name: "发送请求" }));
    await waitFor(() => expect(view.fetchMock).toHaveBeenCalledWith("/v1/search", expect.objectContaining({
      method: "POST", body: JSON.stringify({ query: "hello", limit: 10 }),
    })));
    view.fetchMock.mockResolvedValueOnce(json(partialSearch));
    expect(query).toHaveValue("hello");
  });
});
