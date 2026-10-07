import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "./login";

describe("LoginPage", () => {
  it("clears the key after successful login and never stores it", async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    render(<LoginPage onLogin={login} />);
    const input = screen.getByLabelText("Gateway API Key");
    fireEvent.change(input, { target: { value: "private-key" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(login).toHaveBeenCalledWith("private-key"));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(storageSpy).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("aylens.admin.apiKey")).toBeNull();
  });

  it("shows rate-limit retry information", async () => {
    const login = vi.fn().mockRejectedValue(Object.assign(new Error("Too many"), {
      status: 429, retryAfterSeconds: 17,
    }));
    render(<LoginPage onLogin={login} />);
    fireEvent.change(screen.getByLabelText("Gateway API Key"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("17");
  });
});
