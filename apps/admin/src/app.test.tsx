import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./app";

describe("admin app", () => {
  it("renders the login form while no session is available", async () => {
    window.history.replaceState({}, "", "/admin/login");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 401 }));
    render(<App />);
    expect(await screen.findByLabelText("Gateway API Key")).toBeVisible();
  });
});
