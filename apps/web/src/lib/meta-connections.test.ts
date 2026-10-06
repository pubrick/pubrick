import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMetaConnectionProvider,
  metaAuthorizationUrl,
  openMetaAuthorization,
  readMetaConfiguration,
} from "./meta-connections";

const providers = ["threads", "instagram_native", "facebook_page"] as const;
const urls = {
  threads: "https://www.threads.com/oauth/authorize?state=fixture",
  instagram_native: "https://www.instagram.com/oauth/authorize?state=fixture",
  facebook_page: "https://www.facebook.com/v26.0/dialog/oauth?state=fixture",
};
afterEach(() => vi.unstubAllGlobals());
describe("Meta browser connection boundary", () => {
  it.each(providers)("allows only the selected %s authorization page", (provider) => {
    expect(metaAuthorizationUrl(provider, { provider, authorizationUrl: urls[provider] })).toBe(
      urls[provider],
    );
    expect(isMetaConnectionProvider(provider)).toBe(true);
  });
  it.each([
    "https://attacker.example.com/oauth/authorize",
    "https://www.threads.com.attacker.example.com/oauth/authorize",
    "https://user:password@www.threads.com/oauth/authorize",
    "https://www.threads.com/oauth/authorize#secret",
    "https://www.threads.com/other",
  ])("refuses an unsafe authorization response %s", (authorizationUrl) => {
    expect(() =>
      metaAuthorizationUrl("threads", { provider: "threads", authorizationUrl }),
    ).toThrow();
  });
  it("refuses another provider and navigates only after validation", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    expect(() =>
      openMetaAuthorization("threads", {
        provider: "instagram_native",
        authorizationUrl: urls.instagram_native,
      }),
    ).toThrow();
    expect(assign).not.toHaveBeenCalled();
    openMetaAuthorization("threads", { provider: "threads", authorizationUrl: urls.threads });
    expect(assign).toHaveBeenCalledExactlyOnceWith(urls.threads);
  });
  it("reads actual configuration without inventing availability", () => {
    expect(
      readMetaConfiguration({
        providers: providers.map((provider) => ({ provider, available: provider === "threads" })),
      }),
    ).toEqual({ threads: true, instagram_native: false, facebook_page: false });
    expect(isMetaConnectionProvider("instagram")).toBe(false);
  });
  it.each([
    {},
    { providers: [] },
    {
      providers: [
        { provider: "threads", available: true },
        { provider: "threads", available: true },
        { provider: "facebook_page", available: false },
      ],
    },
    { providers: providers.map((provider) => ({ provider, available: "true" })) },
  ])("rejects malformed or incomplete configuration", (value) => {
    expect(() => readMetaConfiguration(value)).toThrow();
  });
});
