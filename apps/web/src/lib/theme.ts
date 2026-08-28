export type ThemePref = "system" | "light" | "dark";
export const THEME_STORAGE_KEY = "pubrick-theme";

export function applyTheme(pref: ThemePref): void {
  try {
    if (pref === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
      document.documentElement.removeAttribute("data-theme");
      return;
    }
    localStorage.setItem(THEME_STORAGE_KEY, pref);
    document.documentElement.setAttribute("data-theme", pref);
  } catch {
    // Storage can be unavailable (private mode); the attribute alone still works.
    document.documentElement.setAttribute("data-theme", pref === "system" ? "" : pref);
  }
}

export function readThemePref(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}
