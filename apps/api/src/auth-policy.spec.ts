import { describe, expect, it } from "vitest";
import {
  assertNoPublishedSecrets,
  findPublishedSecrets,
  ipAddressHeadersFor,
  PUBLISHED_DEVELOPMENT_SECRETS,
  parseSignupMode,
  parseTrustedProxies,
  resolveSignupPosture,
  SIGNUP_MODES,
} from "./auth-policy";

describe("parseSignupMode", () => {
  it("reads each supported mode", () => {
    expect(parseSignupMode("open")).toBe("open");
    expect(parseSignupMode("invite")).toBe("invite");
    expect(parseSignupMode("closed")).toBe("closed");
    expect(parseSignupMode("auto")).toBe("auto");
  });

  it("treats unset, empty and whitespace as auto", () => {
    expect(parseSignupMode(undefined)).toBe("auto");
    expect(parseSignupMode(null)).toBe("auto");
    expect(parseSignupMode("")).toBe("auto");
    expect(parseSignupMode("   ")).toBe("auto");
  });

  it("trims a stray newline rather than rejecting it", () => {
    expect(parseSignupMode(" invite\n")).toBe("invite");
  });

  // The alternative — falling back to a default on an unrecognised value — is how a
  // typo leaves an instance more open than the operator asked for.
  it.each(["invite-only", "OPEN", "closed;", "yes"])("rejects %o", (value) => {
    expect(() => parseSignupMode(value)).toThrow(/Invalid SIGNUP_MODE/);
  });
});

describe("resolveSignupPosture", () => {
  it("returns an explicit mode unchanged, whatever the instance looks like", () => {
    for (const mode of ["open", "invite", "closed"] as const) {
      expect(resolveSignupPosture(mode, false)).toBe(mode);
      expect(resolveSignupPosture(mode, true)).toBe(mode);
    }
  });

  it("auto opens only while the instance has no account", () => {
    expect(resolveSignupPosture("auto", false)).toBe("open");
  });

  it("auto is invite-only once an account exists", () => {
    expect(resolveSignupPosture("auto", true)).toBe("invite");
  });

  it("never resolves to anything outside the three postures", () => {
    for (const mode of SIGNUP_MODES) {
      for (const hasUsers of [false, true]) {
        expect(["open", "invite", "closed"]).toContain(resolveSignupPosture(mode, hasUsers));
      }
    }
  });
});

describe("parseTrustedProxies", () => {
  it("splits, trims and drops empties", () => {
    expect(parseTrustedProxies(" 127.0.0.1 , 10.0.0.0/24 ,, ")).toEqual([
      "127.0.0.1",
      "10.0.0.0/24",
    ]);
  });

  it("is empty for unset, empty and comma-only values", () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies("")).toEqual([]);
    expect(parseTrustedProxies(" , ")).toEqual([]);
  });
});

describe("ipAddressHeadersFor", () => {
  // The point of the whole setting: with nobody declared, no forwarded header is
  // believed, so a caller cannot pick its own rate-limit bucket by typing one.
  it("reads no header at all when no proxy is declared", () => {
    expect(ipAddressHeadersFor([])).toEqual([]);
  });

  it("reads x-forwarded-for once a proxy is declared", () => {
    expect(ipAddressHeadersFor(["127.0.0.1"])).toEqual(["x-forwarded-for"]);
  });
});

describe("published development secrets", () => {
  it("names every secret set to a published value", () => {
    expect(
      findPublishedSecrets({
        BETTER_AUTH_SECRET: "dev-only-secret-change-me",
        APP_ENCRYPTION_KEY: "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=",
      }),
    ).toEqual(["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY"]);
  });

  it("names nothing for freshly generated values", () => {
    expect(
      findPublishedSecrets({
        BETTER_AUTH_SECRET: "Zx9qP1s2t3u4v5w6x7y8z9A0B1C2D3E4F5G6H7I8J9K=",
        APP_ENCRYPTION_KEY: "Lm0n1o2p3q4r5s6t7u8v9w0x1y2z3A4B5C6D7E8F9G0=",
      }),
    ).toEqual([]);
  });

  it("ignores an unset value rather than matching undefined against the list", () => {
    expect(findPublishedSecrets({ BETTER_AUTH_SECRET: undefined })).toEqual([]);
  });

  it.each(PUBLISHED_DEVELOPMENT_SECRETS)("refuses %o in production", (value) => {
    expect(() => assertNoPublishedSecrets({ BETTER_AUTH_SECRET: value }, "production")).toThrow(
      /Refusing to start: BETTER_AUTH_SECRET/,
    );
  });

  it("names both secrets when both are published", () => {
    expect(() =>
      assertNoPublishedSecrets(
        {
          BETTER_AUTH_SECRET: "dev-only-secret-change-me",
          APP_ENCRYPTION_KEY: "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=",
        },
        "production",
      ),
    ).toThrow(/BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY are set to a value published/);
  });

  it("allows a real value in production", () => {
    expect(() =>
      assertNoPublishedSecrets({ BETTER_AUTH_SECRET: "a-real-generated-secret" }, "production"),
    ).not.toThrow();
  });

  // Dev and the test suite legitimately run on known values; only the shipped images
  // say production, and they are the ones that must not.
  it.each([undefined, "development", "test"])("does not fire under NODE_ENV=%o", (nodeEnv) => {
    expect(() =>
      assertNoPublishedSecrets({ BETTER_AUTH_SECRET: "dev-only-secret-change-me" }, nodeEnv),
    ).not.toThrow();
  });
});
