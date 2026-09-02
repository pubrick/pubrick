export type ThemePref = "system" | "light" | "dark";
export const THEME_STORAGE_KEY = "pubrick-theme";

/**
 * The DOM first, storage second — and each in its own step.
 *
 * Only `localStorage` can throw here (private mode, storage disabled), and the
 * old shape wrapped BOTH in one `try`, so a storage failure was recovered from
 * by re-running the attribute half in a `catch` that could not tell which half
 * had failed. Its recovery for the system setting was
 * `setAttribute("data-theme", "")` — an EMPTY attribute where the correct act
 * is to remove it. `globals.css` overrides the theme under
 * `[data-theme="dark"]` / `[data-theme="light"]`, so `data-theme=""` matches
 * neither and the page does fall back to the system preference: right answer,
 * wrong mechanism, and one selector away (`[data-theme]`, or a
 * `:not([data-theme])` guard on the light block) from silently pinning every
 * private-mode visitor to one theme. Applying the attribute outside the `try`
 * removes the second code path instead of correcting it.
 */
export function applyTheme(pref: ThemePref): void {
  if (pref === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", pref);
  }
  try {
    if (pref === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, pref);
    }
  } catch {
    // Storage can be unavailable (private mode). The attribute above is already
    // applied, so the choice holds for this page; it just won't survive a reload.
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
