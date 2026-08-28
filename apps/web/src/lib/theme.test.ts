import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, readThemePref, THEME_STORAGE_KEY } from "./theme";

describe("theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("system preference clears the override and the stored value", () => {
    applyTheme("dark");
    applyTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(readThemePref()).toBe("system");
  });

  it("explicit light/dark set the attribute and persist", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readThemePref()).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("readThemePref tolerates garbage in storage", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "purple");
    expect(readThemePref()).toBe("system");
  });
});
