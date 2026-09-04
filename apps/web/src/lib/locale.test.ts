import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALE_COOKIE } from "@/i18n/locale-cookie";
import { routing } from "@/i18n/routing";
import { localeOptions, localeSwitchHref, rememberLocale } from "./locale";

/**
 * Captures what is written to `document.cookie` rather than reading it back.
 *
 * jsdom's getter returns `name=value` pairs only — every attribute is dropped —
 * so a test that asserts on `document.cookie` can prove the locale was stored
 * and cannot see whether it was stored for a year or until the tab closes.
 * That distinction IS the returning-visitor question, so it has to be
 * observable.
 */
function captureCookieWrites(): string[] {
  const writes: string[] = [];
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => writes.join("; "),
    set: (value: string) => {
      writes.push(value);
    },
  });
  return writes;
}

afterEach(() => {
  // Drops the instance property, restoring Document.prototype's own accessor.
  delete (document as Partial<Document>).cookie;
  vi.resetModules();
});

describe("localeOptions", () => {
  it("offers one option per routing locale, in routing order", () => {
    expect(localeOptions().map((option) => option.value)).toEqual(["en", "es", "ru", "pt"]);
  });

  it("names every language in its own language", () => {
    expect(localeOptions()).toEqual([
      { value: "en", label: "English" },
      { value: "es", label: "Español" },
      { value: "ru", label: "Русский" },
      { value: "pt", label: "Português" },
    ]);
  });

  /**
   * The switcher is not allowed to keep its own list. A fifth locale is added
   * in exactly one place — the routing configuration — and has to appear,
   * under its own name, with nothing else edited.
   */
  it("picks up a locale added to the routing configuration, named in that language", async () => {
    vi.resetModules();
    vi.doMock("@/i18n/routing", () => ({
      routing: { locales: ["en", "es", "ru", "pt", "de"], defaultLocale: "en" },
    }));

    const { localeOptions: withFifth } = await import("./locale");

    expect(withFifth()).toContainEqual({ value: "de", label: "Deutsch" });
    expect(withFifth()).toHaveLength(5);
    vi.doUnmock("@/i18n/routing");
  });
});

describe("localeSwitchHref", () => {
  it("swaps the locale segment and keeps the rest of the path", () => {
    expect(localeSwitchHref("/en/content/abc", "", "ru")).toBe("/ru/content/abc");
  });

  it("keeps the query string exactly", () => {
    expect(localeSwitchHref("/en/content", "?status=review&brand=b1", "es")).toBe(
      "/es/content?status=review&brand=b1",
    );
  });

  it("adds no question mark when there is no query", () => {
    expect(localeSwitchHref("/en/content", "", "es")).toBe("/es/content");
    expect(localeSwitchHref("/en/content", "?", "es")).toBe("/es/content");
  });

  it("rewrites only the FIRST segment, not a later one that reads like a locale", () => {
    expect(localeSwitchHref("/en/brands/ru", "", "pt")).toBe("/pt/brands/ru");
  });

  it("handles the locale root", () => {
    expect(localeSwitchHref("/en", "", "ru")).toBe("/ru");
  });

  it("prefixes a path that has no locale segment yet", () => {
    expect(localeSwitchHref("/content", "", "ru")).toBe("/ru/content");
    expect(localeSwitchHref("/", "", "ru")).toBe("/ru");
  });
});

describe("rememberLocale", () => {
  it("stores the choice under the name next-intl reads on the way in", () => {
    const writes = captureCookieWrites();

    rememberLocale("ru");

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(`${LOCALE_COOKIE.name}=ru`);
    expect(LOCALE_COOKIE.name).toBe("NEXT_LOCALE");
  });

  /**
   * next-intl's own cookie carries no `max-age`, which makes it a SESSION
   * cookie: the choice would survive a reload and die with the browser window.
   * A returning visitor is the whole point of storing it, so the lifetime is
   * pinned here.
   */
  it("stores it for a year, not for the session", () => {
    const writes = captureCookieWrites();

    rememberLocale("ru");

    expect(writes[0]).toContain("max-age=31536000");
    expect(LOCALE_COOKIE.maxAge).toBe(31536000);
  });

  it("scopes the cookie to the whole site, so it is read on any path", () => {
    const writes = captureCookieWrites();

    rememberLocale("es");

    expect(writes[0]).toContain("path=/");
    expect(writes[0]).toContain("samesite=lax");
  });

  it("survives a browser that refuses cookies instead of taking the switch down with it", () => {
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "",
      set: () => {
        throw new Error("cookies are disabled");
      },
    });

    expect(() => rememberLocale("ru")).not.toThrow();
  });
});

/**
 * The cookie has two writers — this module on a soft navigation, and
 * next-intl's middleware on a document request — and they have to agree. Drop
 * `localeCookie` from the routing config and the middleware silently goes back
 * to its default, which carries no `max-age`: a reader who follows a link into
 * another locale would have their year-long choice quietly downgraded to a
 * session.
 */
describe("the routing configuration", () => {
  it("hands the middleware the same cookie policy the switcher writes", () => {
    expect(routing.localeCookie).toEqual(LOCALE_COOKIE);
  });
});
