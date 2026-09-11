import { describe, expect, it } from "vitest";
import {
  checkBrowserOrigin,
  normalizeOrigin,
  ORIGIN_MISMATCH_CODE,
  originDoctorLines,
  originMismatchBody,
  originMismatchMessage,
} from "./deploy-origin.js";

describe("normalizeOrigin", () => {
  it.each([
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["https://pubrick.example/app?x=1", "https://pubrick.example"],
    ["HTTPS://Pubrick.Example", "https://pubrick.example"],
    // The scheme's default port is the same origin written two ways.
    ["https://pubrick.example:443", "https://pubrick.example"],
    ["http://pubrick.example:80", "http://pubrick.example"],
  ])("normalises %s to %s", (raw, expected) => {
    expect(normalizeOrigin(raw)).toBe(expected);
  });

  it.each(["", "   ", "localhost:3000", "not a url", "/relative", "null"])(
    "refuses %p as an origin",
    (raw) => {
      expect(normalizeOrigin(raw)).toBeNull();
    },
  );

  it("refuses null and undefined", () => {
    expect(normalizeOrigin(null)).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
  });

  // A cookie set for one is never sent to the other, so collapsing them would
  // hide the exact install this module exists to name.
  it("keeps localhost and 127.0.0.1 apart", () => {
    expect(normalizeOrigin("http://localhost:3000")).not.toBe(
      normalizeOrigin("http://127.0.0.1:3000"),
    );
  });
});

describe("checkBrowserOrigin", () => {
  it("matches the configured origin written with a trailing slash", () => {
    expect(checkBrowserOrigin("http://localhost:3000", "http://localhost:3000/")).toEqual({
      kind: "match",
    });
  });

  it("names both values when the ports differ — the first-run trap", () => {
    expect(checkBrowserOrigin("http://localhost:3080", "http://localhost:3000")).toEqual({
      kind: "mismatch",
      browserOrigin: "http://localhost:3080",
      configuredOrigin: "http://localhost:3000",
      acceptedOrigins: ["http://localhost:3000"],
    });
  });

  it("names both values when the host is the other spelling of loopback", () => {
    expect(checkBrowserOrigin("http://127.0.0.1:3000", "http://localhost:3000")).toEqual({
      kind: "mismatch",
      browserOrigin: "http://127.0.0.1:3000",
      configuredOrigin: "http://localhost:3000",
      acceptedOrigins: ["http://localhost:3000"],
    });
  });

  it("names both values when the scheme differs", () => {
    expect(checkBrowserOrigin("http://pubrick.example", "https://pubrick.example")).toEqual({
      kind: "mismatch",
      browserOrigin: "http://pubrick.example",
      configuredOrigin: "https://pubrick.example",
      acceptedOrigins: ["https://pubrick.example"],
    });
  });

  // A correctly proxied deployment: the browser's document origin is the public
  // name, and it arrives unchanged however many hops rewrote Host on the way.
  it("matches a proxied browser whose origin is the public name", () => {
    expect(checkBrowserOrigin("https://pubrick.example", "https://pubrick.example")).toEqual({
      kind: "match",
    });
  });

  it.each([undefined, null, "", "null", "not a url"])(
    "cannot verify %p, and says so rather than refusing",
    (header) => {
      expect(checkBrowserOrigin(header, "http://localhost:3000")).toEqual({ kind: "unverifiable" });
    },
  );

  it("cannot verify anything when the configured origin is itself unparseable", () => {
    expect(checkBrowserOrigin("http://localhost:3080", "localhost:3000")).toEqual({
      kind: "unverifiable",
    });
  });

  // THE ALLOW-LIST IS BETTER-AUTH'S, NOT `PUBLIC_ORIGIN` ALONE. better-auth
  // trusts `new URL(BETTER_AUTH_URL).origin`, every entry of `trustedOrigins`
  // and everything in `BETTER_AUTH_TRUSTED_ORIGINS`; a check that knew only the
  // one value would hard-refuse, ahead of the boundary, requests better-auth
  // itself allows — and tell their operator to change the variable that is not
  // the problem.
  it("accepts an origin that is trusted without being the configured one", () => {
    expect(
      checkBrowserOrigin("https://second.example", "https://web.example", [
        "https://web.example",
        "https://second.example",
      ]),
    ).toEqual({ kind: "match" });
  });

  // The hand-configured install: BETTER_AUTH_URL names one origin, WEB_ORIGIN
  // another. better-auth trusts its own base URL, so the api answers there.
  it("accepts the base URL's origin when it differs from the configured one", () => {
    expect(
      checkBrowserOrigin("http://localhost:34103", "https://web.example", [
        "http://localhost:34103",
        "https://web.example",
      ]),
    ).toEqual({ kind: "match" });
  });

  it("still refuses an origin that is in neither the configured value nor the list", () => {
    expect(
      checkBrowserOrigin("https://evil.example", "https://web.example", [
        "https://web.example",
        "https://second.example",
      ]),
    ).toEqual({
      kind: "mismatch",
      browserOrigin: "https://evil.example",
      configuredOrigin: "https://web.example",
      acceptedOrigins: ["https://web.example", "https://second.example"],
    });
  });

  // An entry this cannot parse is dropped rather than widening or narrowing the
  // set: better-auth matches its patterns literally, and guessing at one here is
  // how the two lists start to disagree again.
  it("ignores list entries that are not absolute origins", () => {
    const verdict = checkBrowserOrigin("https://evil.example", "https://web.example", [
      "*.web.example",
      "",
      "https://web.example/",
    ]);
    expect(verdict).toEqual({
      kind: "mismatch",
      browserOrigin: "https://evil.example",
      configuredOrigin: "https://web.example",
      acceptedOrigins: ["https://web.example"],
    });
  });
});

describe("originMismatchMessage", () => {
  const message = originMismatchMessage("http://localhost:3080", "http://localhost:3000");

  // Naming one value is what the refusal this replaces already did, and it is
  // the half the reader can already see in the address bar.
  it("names the origin that was opened", () => {
    expect(message).toContain("http://localhost:3080");
  });

  it("names the configured origin", () => {
    expect(message).toContain("http://localhost:3000");
  });

  it("names the variable to change", () => {
    expect(message).toContain("PUBLIC_ORIGIN");
  });

  // An instance that accepts more than one origin has an operator who wrote a
  // trusted-origins list, and "PUBLIC_ORIGIN is X" read as the whole allow-list
  // would be a lie to exactly that reader. The variable is still named, because
  // setting it is still the fix in the common case.
  it("does not claim the configured origin is the only one when a list exists", () => {
    const many = originMismatchMessage("https://evil.example", "https://web.example", [
      "https://web.example",
      "https://second.example",
    ]);
    expect(many).toContain("is not one of the origins this instance accepts");
    expect(many).toContain("PUBLIC_ORIGIN: https://web.example");
    expect(many).toContain("https://evil.example");
  });

  // …and it never lists the others: the body answers an unauthenticated caller,
  // and `PUBLIC_ORIGIN` is public by definition in a way an internal origin an
  // operator added by hand is not.
  it("does not disclose the other accepted origins", () => {
    expect(
      originMismatchMessage("https://evil.example", "https://web.example", [
        "https://web.example",
        "https://internal.corp",
      ]),
    ).not.toContain("internal.corp");
  });

  it("keeps the single-origin sentence when the instance accepts one origin", () => {
    expect(
      originMismatchMessage("http://localhost:3080", "http://localhost:3000", [
        "http://localhost:3000",
      ]),
    ).toBe(message);
  });
});

describe("originMismatchBody", () => {
  it("carries the code, the sentence and the configured origin", () => {
    expect(originMismatchBody("http://localhost:3080", "http://localhost:3000")).toEqual({
      statusCode: 403,
      error: "Forbidden",
      message: originMismatchMessage("http://localhost:3080", "http://localhost:3000"),
      code: ORIGIN_MISMATCH_CODE,
      expectedOrigin: "http://localhost:3000",
    });
  });

  it("carries the sentence for an instance that accepts several origins", () => {
    const accepted = ["https://web.example", "https://second.example"];
    expect(
      originMismatchBody("https://evil.example", "https://web.example", accepted).message,
    ).toBe(originMismatchMessage("https://evil.example", "https://web.example", accepted));
  });

  // The web reads this field and interpolates it into the reader's own language;
  // the origin the browser sent is attacker-controlled and never travels back.
  it("sends back the configured origin, never the one the caller claimed", () => {
    expect(originMismatchBody("https://evil.example", "http://localhost:3000").expectedOrigin).toBe(
      "http://localhost:3000",
    );
  });
});

describe("originDoctorLines", () => {
  it("names the accepted origin and the variable that sets it", () => {
    const [line] = originDoctorLines("http://localhost:3000/", "http://localhost:3000");
    expect(line).toContain("http://localhost:3000");
    expect(line).toContain("PUBLIC_ORIGIN");
  });

  it("says nothing further when the base URL agrees", () => {
    expect(originDoctorLines("https://pubrick.example", "https://pubrick.example/")).toHaveLength(
      1,
    );
  });

  it("names both when a hand-configured install has them disagree", () => {
    const lines = originDoctorLines("https://pubrick.example", "http://localhost:3000");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("http://localhost:3000");
    expect(lines[1]).toContain("https://pubrick.example");
  });

  it("says the origin is unusable rather than printing a reassuring line", () => {
    const lines = originDoctorLines("localhost:3000", "localhost:3000");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not an absolute origin");
    expect(lines[0]).not.toContain("accepts sign-ins");
  });
});
