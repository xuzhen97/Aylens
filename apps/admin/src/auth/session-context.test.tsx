import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "./session-context";

function Probe() {
  const session = useSession();
  return <div>
    <span>{session.status}</span>
    <button onClick={() => void session.login("secret")}>login</button>
    <button onClick={() => void session.logout()}>logout</button>
  </div>;
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("SessionProvider", () => {
  it("probes a cookie session and immediately becomes anonymous on logout", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({
      authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf",
    })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    render(<SessionProvider><Probe /></SessionProvider>);
    await screen.findByText("authenticated");
    await act(async () => { screen.getByRole("button", { name: "logout" }).click(); });
    await screen.findByText("anonymous");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/v1/admin/session");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/v1/admin/session/logout");
  });

  it("does not let a stale login response restore a logged-out session", async () => {
    let resolveLogin!: (value: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ error: { code: "AUTH_FAILED", message: "none" } }, 401))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveLogin = resolve; }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const view = render(<SessionProvider><Probe /></SessionProvider>);
    await screen.findByText("anonymous");
    act(() => { within(view.container).getByRole("button", { name: "login" }).click(); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { within(view.container).getByRole("button", { name: "logout" }).click(); });
    resolveLogin(response({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "old" }));
    await waitFor(() => expect(within(view.container).getByText("anonymous")).toBeVisible());
  });

  it("stays locally anonymous when server-side logout cannot be confirmed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ error: { code: "AUTH_FAILED", message: "none" } }, 401))
      .mockRejectedValueOnce(new Error("offline"));
    const view = render(<SessionProvider><Probe /></SessionProvider>);
    await screen.findByText("anonymous");
    await act(async () => { view.getByRole("button", { name: "logout" }).click(); });
    expect(within(view.container).getByText("anonymous")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/v1/admin/session/logout");
  });
});
