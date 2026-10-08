/**
 * 主题（两态手动＋首访跟系统一次，2026-10-08 裁决）：存本机 `watchparty_theme`。
 * 播放器面恒黑，由房间页在 ready 时另行钉 `.dark`（见 room/[id]/page.tsx）。
 */

export type ThemePreference = "light" | "dark";

const THEME_KEY = "watchparty_theme";

export function readStoredTheme(): ThemePreference | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function systemTheme(): ThemePreference {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function resolveTheme(): ThemePreference {
  return readStoredTheme() ?? systemTheme();
}

export function applyTheme(theme: ThemePreference) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function storeTheme(theme: ThemePreference) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 忽略存储失败
  }
  applyTheme(theme);
}
