import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProxyEditor } from "./proxy-editor.js";
import type { SafeProxyConfig } from "../api/proxy-types.js";

const baseConfig: SafeProxyConfig = {
  version: 3,
  proxies: [
    { id: "direct", type: "direct", hasCredentials: false, providerRefs: [], profileRefs: [] },
    {
      id: "proxy-main",
      type: "http-proxy",
      address: "http://127.0.0.1:8899/",
      hasCredentials: true,
      providerRefs: ["url-fetch"],
      profileRefs: ["browser-main"],
    },
  ],
  providers: [{ id: "url-fetch", binding: { primary: "proxy-main", fallback: [] } }],
  browserRestartRequired: ["browser-main"],
};

const writeProxyConfig = vi.fn();

function harness(overrides: Partial<Parameters<typeof ProxyEditor>[0]> = {}) {
  return (
    <ProxyEditor
      runnerId="r1"
      runnerOnline={true}
      supportsProxyConfig={true}
      config={baseConfig}
      writeProxyConfig={writeProxyConfig}
      {...overrides}
    />
  );
}

beforeEach(() => {
  writeProxyConfig.mockReset();
});

describe("ProxyEditor", () => {
  it("shows proxies without credentials and lists references", () => {
    render(harness());
    expect(screen.getAllByText(/proxy-main/).length).toBeGreaterThan(0);
    expect(screen.getByText(/认证信息已配置/)).toBeInTheDocument();
    expect(screen.getByText(/url-fetch/)).toBeInTheDocument();
    expect(screen.getByText(/需重启对应 Chrome 才能生效/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("password=");
  });

  it("does not retry an uncertain write and asks the user to refresh", async () => {
    const user = userEvent.setup();
    writeProxyConfig.mockRejectedValue(Object.assign(new Error("Result unknown"), {
      status: 503, code: "CONFIG_RESULT_UNKNOWN",
    }));
    render(harness());

    await user.type(screen.getByLabelText(/代理地址/), 'http://127.0.0.1:9000');
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect((await screen.findAllByText(/结果待确认/)).length).toBeGreaterThan(0);
    expect(writeProxyConfig).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "刷新核对" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  });

  it("clears the password input after a successful save", async () => {
    const user = userEvent.setup();
    writeProxyConfig.mockResolvedValue({ ...baseConfig, version: 4 });
    render(harness());

    await user.type(screen.getByLabelText(/代理地址/), 'http://127.0.0.1:9000');
    const passwordInput = screen.getByLabelText(/代理密码/);
    await user.type(passwordInput, "super-secret");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect((screen.getByLabelText(/代理密码/) as HTMLInputElement).value).toBe("");
    });
    expect(writeProxyConfig).toHaveBeenCalledWith("r1", expect.objectContaining({
      expectedVersion: 3,
      mutation: expect.objectContaining({ kind: "put", id: "proxy-main" }),
    }), expect.anything());
  });

  it("keeps the draft after a version conflict", async () => {
    const user = userEvent.setup();
    writeProxyConfig.mockRejectedValue(Object.assign(new Error("conflict"), {
      status: 409, code: "CONFIG_VERSION_CONFLICT",
    }));
    render(harness());

    const addressInput = screen.getByLabelText(/代理地址/);
    await user.clear(addressInput);
    await user.type(addressInput, "http://127.0.0.1:9999");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/配置版本冲突/)).toBeInTheDocument();
    expect((screen.getByLabelText(/代理地址/) as HTMLInputElement).value).toContain("9999");
  });

  it("disables editing when the runner is offline or unsupported", () => {
    render(harness({ runnerOnline: false }));
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    expect(screen.getByText(/Runner 离线/)).toBeInTheDocument();
  });
});
