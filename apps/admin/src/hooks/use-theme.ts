import { useEffect, useState } from "react";

export type ThemeMode = "system" | "light" | "dark";
const THEME_KEY = "aylens.admin.theme";

function readMode(): ThemeMode {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = () => setSystemDark(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = mode === "system" ? (systemDark ? "dark" : "light") : mode;
    document.documentElement.dataset.themeMode = mode;
  }, [mode, systemDark]);

  function setMode(next: ThemeMode) {
    setModeState(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Theme remains active for this tab even if storage is unavailable.
    }
  }

  return { mode, setMode };
}
