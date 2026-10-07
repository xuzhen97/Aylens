import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./use-theme";

let listener: ((event: MediaQueryListEvent) => void) | undefined;
let isDark = true;

beforeEach(() => {
  isDark = true;
  listener = undefined;
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    get matches() { return isDark; },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => { listener = callback; },
    removeEventListener: vi.fn(),
  })));
  localStorage.clear();
});

describe("useTheme", () => {
  it("persists explicit themes and follows system changes only in system mode", () => {
    const { result } = renderHook(() => useTheme());
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => result.current.setMode("light"));
    expect(localStorage.getItem("aylens.admin.theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => result.current.setMode("system"));
    isDark = false;
    act(() => listener?.({ matches: false } as MediaQueryListEvent));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.themeMode).toBe("system");
  });
});
