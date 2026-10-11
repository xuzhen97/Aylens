import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/session-context";
import { OverviewProvider } from "../hooks/use-overview";
import { ProvidersPage } from "./providers.js";
import { emptyOverview } from "../test/fixtures.js";
import type { AdminOverview } from "../api/types.js";

type ProviderEntry = AdminOverview["providers"][number];

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 配置文件默认禁用、且没有覆盖：应显示"启用"，不该出现"跟随配置"。 */
const followConfig: ProviderEntry = {
  id: "tavily",
  type: "tavily",
  enabled: false,
  enabledMode: "config",
  authControl: false,
};

/** 存在覆盖且生效：应显示"停用" + "跟随配置"。 */
const overriddenOn: ProviderEntry = {
  id: "url-fetch",
  type: "url-fetch",
  enabled: true,
  enabledMode: "enabled",
  authControl: false,
};

/** 旧 Gateway 不下发 enabledMode 的兼容用例。 */
const legacyEntry: ProviderEntry = {
  id: "browserRead",
  type: "generic-browser",
  enabled: true,
  authControl: true,
};

function overviewWith(providers: ProviderEntry[]): AdminOverview {
  return {
    ...emptyOverview,
    summary: {
      ...emptyOverview.summary,
      providers: providers.length,
      enabledProviders: providers.filter((provider) => provider.enabled).length,
    },
    providers,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/providers"]}>
      <SessionProvider>
        <OverviewProvider>
          <Routes>
            <Route path="/providers" element={<ProvidersPage />} />
          </Routes>
        </OverviewProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
}

async function mounted(providers: ProviderEntry[]) {
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(json({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf" }))
    .mockResolvedValueOnce(json(overviewWith(providers)))
    .mockResolvedValue(json(overviewWith(providers)));
  renderPage();
  // id 与 type 可能同名（如 tavily），页面会把两者都渲染出来，因此用 findAllByText。
  await screen.findAllByText(providers[0]!.id);
  return fetchMock;
}

function lastEnabledBody(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown> | undefined {
  const call = [...fetchMock.mock.calls].reverse().find((entry) =>
    String(entry[0]).includes("/enabled") && (entry[1] as RequestInit | undefined)?.method === "POST");
  if (!call) return undefined;
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ProvidersPage enablement controls", () => {
  it("renders the effective state and only offers the config reset when an override exists", async () => {
    await mounted([followConfig, overriddenOn]);

    expect(screen.getByText("已禁用")).toBeVisible();
    expect(screen.getByText("已启用")).toBeVisible();
    expect(screen.getByRole("button", { name: "启用" })).toBeVisible();
    expect(screen.getByRole("button", { name: "停用" })).toBeVisible();
    // 只有 url-fetch 处在覆盖态，因此"跟随配置"只出现一次。
    expect(screen.getAllByRole("button", { name: "跟随配置" })).toHaveLength(1);
  });

  it("requires a second click before disabling", async () => {
    const fetchMock = await mounted([overriddenOn]);

    await userEvent.click(screen.getByRole("button", { name: "停用" }));
    expect(screen.getByRole("button", { name: "确认停用？" })).toBeVisible();
    expect(lastEnabledBody(fetchMock)).toBeUndefined();

    await userEvent.click(screen.getByRole("button", { name: "确认停用？" }));
    await waitFor(() => expect(lastEnabledBody(fetchMock)).toEqual({ mode: "disabled" }));
  });

  it("submits config mode to return to the file default", async () => {
    const fetchMock = await mounted([overriddenOn]);

    await userEvent.click(screen.getByRole("button", { name: "跟随配置" }));
    await waitFor(() => expect(lastEnabledBody(fetchMock)).toEqual({ mode: "config" }));
  });

  it("treats a missing enabledMode as config for older gateways", async () => {
    await mounted([legacyEntry]);

    expect(screen.getByRole("button", { name: "停用" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "跟随配置" })).toBeNull();
  });

  it("surfaces the error code when the write fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf" }))
      .mockResolvedValueOnce(json(overviewWith([followConfig])))
      .mockResolvedValueOnce(json({ error: { code: "PROVIDER_NOT_FOUND", message: "Unknown provider: tavily" } }, 404))
      .mockResolvedValue(json(overviewWith([followConfig])));
    renderPage();
    await screen.findAllByText("tavily");

    await userEvent.click(screen.getByRole("button", { name: "启用" }));

    expect(await screen.findByText(/PROVIDER_NOT_FOUND/)).toBeVisible();
  });

  it("keeps reporting success when only the follow-up refresh fails", async () => {
    // 写入已经成功了，刷新失败只影响展示新鲜度，不得被误报成操作失败。
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf" }))
      .mockResolvedValueOnce(json(overviewWith([followConfig])))
      .mockResolvedValueOnce(json({
        providerId: "tavily",
        enabled: true,
        enabledMode: "enabled",
        enabledSource: "override",
      }))
      .mockResolvedValue(json({ error: { code: "INTERNAL", message: "refresh exploded" } }, 500));
    renderPage();
    await screen.findAllByText("tavily");

    await userEvent.click(screen.getByRole("button", { name: "启用" }));

    expect(await screen.findByText(/tavily 已启用/)).toBeVisible();
    expect(screen.queryByText(/操作失败/)).toBeNull();
  });
});
