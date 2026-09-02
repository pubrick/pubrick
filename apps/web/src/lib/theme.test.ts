import { beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * Storage can be unavailable (private mode, storage disabled by policy). The
 * DOM half never throws, so it is applied outside the `try` — the old shape
 * wrapped both halves in one `try` and recovered in a `catch` that could not
 * tell which half had failed, setting `data-theme=""` for the system setting
 * where the correct act is to REMOVE the attribute. An empty attribute happens
 * to fall back correctly against today's `[data-theme="dark"]` selectors and
 * would stop doing so the day anyone writes `[data-theme]` or
 * `:not([data-theme])` — a fix working by luck rather than by rule.
 */
describe("theme when localStorage is unavailable", () => {
  function breakStorage(): void {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
  }

  it("removes the attribute for the system setting — never sets it to an empty string", () => {
    applyTheme("dark");
    breakStorage();

    applyTheme("system");

    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("still applies an explicit theme for this page", () => {
    breakStorage();

    applyTheme("dark");

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
