import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverviewProvider, useOverview } from "./use-overview";
import { SessionProvider, useSession } from "../auth/session-context";

function Probe() {
  const overview = useOverview();
  const session = useSession();
  return <div>
    <span>{overview.data ? "loaded" : "empty"}</span>
    <button onClick={() => void overview.refresh()}>refresh</button>
    <button onClick={() => void session.logout()}>logout</button>
  </div>;
}

const data = {
  generatedAt: 1,
  gateway: { status: "ready" as const },
  summary: { providers: 0, enabledProviders: 0, runtimes: 0, onlineRuntimes: 0, browserProfiles: 0, recentAudits: 0 },
  providers: [], runtimes: [], browserProfiles: [], audits: [],
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("OverviewProvider", () => {
  it("does not overlap refresh requests and discards results after logout", async () => {
    let resolveOverview!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ authenticated: true, expiresAt: Date.now() + 60_000, csrfToken: "csrf" }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOverview = resolve; }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const view = render(<SessionProvider><OverviewProvider><Probe /></OverviewProvider></SessionProvider>);
    await screen.findByText("empty");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => { view.getByRole("button", { name: "refresh" }).click(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { view.getByRole("button", { name: "logout" }).click(); });
    resolveOverview(json(data));
    await act(async () => { await Promise.resolve(); });
    expect(view.getByText("empty")).toBeVisible();
    expect(view.queryByText("loaded")).toBeNull();
  });
});
