import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../auth/session-context";
import { OverviewProvider } from "../hooks/use-overview";
import { CredentialsPage } from "./credentials.js";
import { emptyOverview } from "../test/fixtures.js";
import type { AdminOverview } from "../api/types.js";
import type { SafeCredentialConfig } from "../api/credential-types.js";

const safeConfig: SafeCredentialConfig = {
  version: 2,
  pools: [
    {
      id: "tavily-main",
      service: "tavily",
      name: "Tavily 主池",
      enabled: true,
      credentialCount: 2,
      providerRefs: ["tavily"],
    },
  ],
  credentials: [
    {
      id: "key-1",
      poolId: "tavily-main",
      name: "primary",
      enabled: true,
      maskedSecret: "tvly-s****alue",
      availability: "available",
    },
    {
      id: "key-2",
      poolId: "tavily-main",
      name: "stale",
      enabled: true,
      maskedSecret: "tvly-st****0000",
      availability: "auth_failed",
      lastFailureCategory: "auth",
    },
  ],
  providers: [{ id: "tavily", poolId: "tavily-main" }],
};

function overviewWithCredentialRunner(overrides: Partial<AdminOverview["runtimes"][number]["capabilities"]> = {}) {
  return {
    ...emptyOverview,
    summary: {
      providers: 0, enabledProviders: 0, runtimes: 1, onlineRuntimes: 1,
      browserProfiles: 0, recentAudits: 0,
    },
    runtimes: [{
      id: "runner-1",
      hostname: "host-1",
      os: "linux" as const,
      version: "1.0",
      protocolVersion: "1",
      status: "online" as const,
      labels: {},
      capabilities: {
        providerTypes: [],
        providerIds: [],
        browsers: [],
        profiles: [],
        http: true,
        browserAutomation: false,
        credentialConfig: true,
        ...overrides,
      },
      capacity: { maxJobs: 4, activeJobs: 0 },
      lastSeenAt: 1_700_000_000_000,
    }],
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/credentials"]}>
      <SessionProvider>
        <OverviewProvider>
          <Routes>
            <Route path="/credentials" element={<CredentialsPage />} />
          </Routes>
        </OverviewProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

async function mountedSession() {
  // SessionProvider 需要先拿到会话与 overview 两次响应。
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(json({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf" }))
    .mockResolvedValue(json(overviewWithCredentialRunner()));
  renderPage();
  // 等到 Runner 下拉出现，说明 overview 已加载。
  await screen.findByLabelText(/Runner/);
  return fetchMock;
}

describe("CredentialsPage", () => {
  it("shows masked secrets and availability without exposing plaintext", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf" }))
      .mockResolvedValueOnce(json(overviewWithCredentialRunner()))
      .mockResolvedValue(json(safeConfig));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "读取配置" }));

    expect(await screen.findByText("tvly-s****alue")).toBeVisible();
    expect(screen.getByText("认证失效")).toBeVisible();
    expect(document.body.textContent).not.toContain("tvly-supersecretvalue");
  });

  it("does not send the plaintext secret back in the response path", async () => {
    const fetchMock = await mountedSession();
    fetchMock.mockResolvedValue(json(safeConfig));

    await userEvent.click(screen.getByRole("button", { name: "读取配置" }));
    await screen.findByText("tvly-s****alue");

    // 读取路径的响应里只有脱敏标识。
    const lastRead = fetchMock.mock.calls.at(-1)?.[0];
    expect(String(lastRead)).toContain("/credentials");
    expect(document.body.textContent).not.toContain("tvly-supersecretvalue");
  });

  it("clears the secret input after a successful save", async () => {
    const user = userEvent.setup();
    const fetchMock = await mountedSession();
    fetchMock.mockResolvedValue(json(safeConfig));

    await user.click(screen.getByRole("button", { name: "读取配置" }));
    await screen.findByText("tvly-s****alue");

    // 三个字段都必填；缺任一项都不会提交，也就不会清空输入。
    await user.selectOptions(screen.getByLabelText(/池 ID/), "tavily-main");
    await user.type(screen.getByLabelText("名称"), "fresh");
    const secretInput = screen.getByLabelText("Key 明文");
    await user.type(secretInput, "brand-new-secret");

    fetchMock.mockResolvedValue(json({ ...safeConfig, version: 3 }));
    await user.click(screen.getByRole("button", { name: "保存 Key" }));

    await waitFor(() => expect(secretInput).toHaveValue(""));
    // 页面状态里不再残留明文。
    expect(document.body.textContent).not.toContain("brand-new-secret");
  });

  it("shows an actionable hint when the runner lacks credential support", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf" }))
      .mockResolvedValue(json(overviewWithCredentialRunner({ credentialConfig: false })));
    renderPage();

    expect(await screen.findByText(/不支持凭据管理/)).toBeVisible();
    // 能力缺失时不允许写入，而不是点了才失败。
    expect(screen.queryByRole("button", { name: "新增池" })).not.toBeInTheDocument();
  });

  it("surfaces a 503 CONFIG_UNSUPPORTED write failure as an error, not a silent no-op", async () => {
    const user = userEvent.setup();
    const fetchMock = await mountedSession();
    fetchMock.mockResolvedValue(json(safeConfig));

    await user.click(screen.getByRole("button", { name: "读取配置" }));
    await screen.findByText("tvly-s****alue");

    // 只让下一次调用（写入）失败；后续读取仍成功，否则错误会被回读抹掉。
    fetchMock.mockImplementationOnce(async () => json({
      error: { code: "CONFIG_UNSUPPORTED", message: "Secure connection or credentials config support is required" },
    }, 503));

    await user.click(screen.getAllByRole("button", { name: "删除" })[0]!);

    // 页面展示错误码，运维据此处置；不能吞成无信息的失败。
    expect(await screen.findByText(/CONFIG_UNSUPPORTED/)).toBeVisible();
  });
});

/** 取出最后一次 POST 的请求体（写操作）。 */
function lastWriteBody(fetchMock: { mock: { calls: unknown[][] } }): Record<string, never> | undefined {
  const postCall = [...fetchMock.mock.calls]
    .reverse()
    .find((call) => (call[1] as { method?: string } | undefined)?.method === "POST");
  const init = postCall?.[1] as { body?: string } | undefined;
  return init?.body ? JSON.parse(init.body) as Record<string, never> : undefined;
}

describe("CredentialsPage mutations", () => {
  it("binds an unbound provider to a pool", async () => {
    const user = userEvent.setup();
    const unbound: SafeCredentialConfig = {
      ...safeConfig,
      providers: [{ id: "tavily", poolId: null, service: "tavily" }],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf" }))
      .mockResolvedValueOnce(json(overviewWithCredentialRunner()))
      .mockResolvedValue(json(unbound));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "读取配置" }));
    await screen.findByText(/未绑定/);

    fetchMock.mockResolvedValue(json({
      ...unbound,
      version: 3,
      providers: [{ id: "tavily", poolId: "tavily-main" }],
    }));
    await user.click(screen.getByRole("button", { name: "绑定" }));

    const body = lastWriteBody(fetchMock);
    expect(body).toMatchObject({
      expectedVersion: 2,
      mutation: { kind: "bind", providerId: "tavily", poolId: "tavily-main" },
    });
  });

  it("does not offer pools from a different service", async () => {
    const user = userEvent.setup();
    const mixed: SafeCredentialConfig = {
      ...safeConfig,
      pools: [
        ...safeConfig.pools,
        { id: "exa-main", service: "exa", name: "Exa", enabled: true, credentialCount: 0, providerRefs: [] },
      ],
      providers: [{ id: "tavily", poolId: null, service: "tavily" }],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf" }))
      .mockResolvedValueOnce(json(overviewWithCredentialRunner()))
      .mockResolvedValue(json(mixed));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "读取配置" }));
    await screen.findByText(/未绑定/);

    // 跨服务商的池不应出现在**绑定下拉**里，否则点了才报 service mismatch。
    // 注意只查绑定行：新增 Key 表单里列出全部池是合理的。
    const bindSelect = document.querySelector("#bind-pool-tavily");
    expect(bindSelect).not.toBeNull();
    const bindOptions = Array.from(bindSelect!.querySelectorAll("option")).map((option) => option.textContent);
    expect(bindOptions).toContain("tavily-main");
    expect(bindOptions).not.toContain("exa-main");

    fetchMock.mockResolvedValue(json({ ...mixed, version: 3 }));
    await user.click(screen.getByRole("button", { name: "绑定" }));

    // 点哪一行就绑哪一行，不能因 setState 异步而回退成第一个 Provider。
    expect(lastWriteBody(fetchMock)).toMatchObject({
      mutation: { kind: "bind", providerId: "tavily", poolId: "tavily-main" },
    });
  });

  it("sends the account group so account-scoped rate limiting can actually engage", async () => {
    const user = userEvent.setup();
    const fetchMock = await mountedSession();
    fetchMock.mockResolvedValue(json(safeConfig));

    await user.click(screen.getByRole("button", { name: "读取配置" }));
    await screen.findByText("tvly-s****alue");

    await user.selectOptions(screen.getByLabelText(/池 ID/), "tavily-main");
    await user.type(screen.getByLabelText("名称"), "teammate");
    await user.type(screen.getByLabelText("Key 明文"), "tvly-peer-key");
    await user.type(screen.getByLabelText(/账号组/), "team-a");

    fetchMock.mockResolvedValue(json({ ...safeConfig, version: 3 }));
    await user.click(screen.getByRole("button", { name: "保存 Key" }));

    await waitFor(() => expect(screen.getByText(/已保存/)).toBeInTheDocument());
    const body = lastWriteBody(fetchMock);
    expect(body).toMatchObject({
      mutation: { kind: "put-credential", accountGroup: "team-a", secret: "tvly-peer-key" },
    });
  });

  it("replaces an existing secret without changing its identity or losing availability state", async () => {
    const user = userEvent.setup();
    const fetchMock = await mountedSession();
    fetchMock.mockResolvedValue(json(safeConfig));

    await user.click(screen.getByRole("button", { name: "读取配置" }));
    await screen.findByText("tvly-s****alue");

    // 点第一行（primary）的“替换” → 表单带 id/name/pool 预填，只需输入新密钥。
    // 列表有多个 Key，每行各有一个按钮，按首行取。
    await user.click(screen.getAllByRole("button", { name: "替换" })[0]!);
    expect(screen.getByLabelText(/名称/)).toHaveValue("primary");
    expect(screen.getByLabelText(/池 ID/)).toHaveValue("tavily-main");

    await user.type(screen.getByLabelText("Key 明文"), "tvly-rotated-key");
    fetchMock.mockResolvedValue(json({ ...safeConfig, version: 3 }));
    await user.click(screen.getByRole("button", { name: "保存 Key" }));

    await waitFor(() => expect(screen.getByLabelText("Key 明文")).toHaveValue(""));
    const body = lastWriteBody(fetchMock);
    // 同 id + 新 secret = 原地轮换；而不是删旧建新导致可用性状态丢失。
    expect(body).toMatchObject({
      mutation: { kind: "put-credential", id: "key-1", poolId: "tavily-main", secret: "tvly-rotated-key" },
    });
    expect(screen.queryByText(/编辑中/)).not.toBeInTheDocument();
  });
});

describe("CredentialsPage usage", () => {
  it("shows official usage without turning unknown into zero", async () => {
    const user = userEvent.setup();
    const fetchMock = await mountedSession();
    fetchMock.mockResolvedValue(json(safeConfig));

    await user.click(screen.getByRole("button", { name: "读取配置" }));
    await screen.findByText("tvly-s****alue");

    fetchMock.mockResolvedValueOnce(json({
      providerId: "tavily",
      runtimeId: "runner-1",
      usage: {
        service: "tavily",
        fetchedAt: 1_700_000_000_000,
        accuracy: "official",
        supported: true,
        entries: [
          { scope: "credential", used: 150, limit: null, unit: "credits" },
          { scope: "account", unit: "credits" },
        ],
      },
    }));
    await user.click(screen.getByRole("button", { name: "查询用量" }));

    expect(await screen.findByText(/官方统计/)).toBeVisible();
    expect(screen.getByText(/150 \/ 无上限 credits/)).toBeVisible();
    // 账号用量未知：必须显示“未知”，绝不能是 0。
    expect(screen.getByText(/账号：未知 \/ 无上限 credits/)).toBeVisible();
    // 限定账号作用域：裸正则会匹配到 "150" 里以 0 结尾的部分。
    expect(screen.queryByText(/账号：0 \/ 无上限 credits/)).not.toBeInTheDocument();
  });

  it("marks an unsupported provider instead of pretending the usage is zero", async () => {
    const user = userEvent.setup();
    const fetchMock = await mountedSession();
    fetchMock.mockResolvedValue(json(safeConfig));

    await user.click(screen.getByRole("button", { name: "读取配置" }));
    await screen.findByText("tvly-s****alue");

    fetchMock.mockResolvedValueOnce(json({
      error: { code: "NO_COMPATIBLE_RUNTIME", message: "Runtime does not support usage" },
    }, 503));
    await user.click(screen.getByRole("button", { name: "查询用量" }));

    expect(await screen.findByText("该 Provider 不支持用量查询")).toBeVisible();
    expect(screen.queryByText(/credits/)).not.toBeInTheDocument();
  });
});
