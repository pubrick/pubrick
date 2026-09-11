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
    });
  });

  it("names both values when the host is the other spelling of loopback", () => {
    expect(checkBrowserOrigin("http://127.0.0.1:3000", "http://localhost:3000")).toEqual({
      kind: "mismatch",
      browserOrigin: "http://127.0.0.1:3000",
      configuredOrigin: "http://localhost:3000",
    });
  });

  it("names both values when the scheme differs", () => {
    expect(checkBrowserOrigin("http://pubrick.example", "https://pubrick.example")).toEqual({
      kind: "mismatch",
      browserOrigin: "http://pubrick.example",
      configuredOrigin: "https://pubrick.example",
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
