import { ORIGIN_MISMATCH_CODE } from "@pubrick/shared";
import { describe, expect, it, vi } from "vitest";
import { authErrorMessage, browserOrigin } from "./auth-error";

const t = vi.fn(
  (key: string, values?: Record<string, string | number>) =>
    `${key}:${JSON.stringify(values ?? {})}`,
);

describe("authErrorMessage", () => {
  it("translates the origin mismatch, naming both origins", () => {
    expect(
      authErrorMessage(
        { code: ORIGIN_MISMATCH_CODE, expectedOrigin: "http://localhost:3000", message: "english" },
        "http://localhost:3080",
        t,
      ),
    ).toBe(
      `originMismatch:${JSON.stringify({
        opened: "http://localhost:3080",
        configured: "http://localhost:3000",
      })}`,
    );
  });

  // An api older than this build sends the code without the field. Half a
  // sentence ("…but PUBLIC_ORIGIN is ") is worse than the English one.
  it("falls back to the server's sentence when the configured origin did not travel", () => {
    expect(
      authErrorMessage({ code: ORIGIN_MISMATCH_CODE, message: "english" }, "http://x.example", t),
    ).toBe("english");
  });

  it("falls back when the browser origin is unknown", () => {
    expect(
      authErrorMessage(
        { code: ORIGIN_MISMATCH_CODE, expectedOrigin: "http://localhost:3000", message: "english" },
        "",
        t,
      ),
    ).toBe("english");
  });

  // better-auth's own vocabulary keeps its English sentence, exactly as before.
  it("leaves an upstream code's sentence alone", () => {
    expect(
      authErrorMessage(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid credentials" },
        "x",
        t,
      ),
    ).toBe("Invalid credentials");
  });

  it("uses the generic key when the refusal carried no sentence at all", () => {
    expect(authErrorMessage({}, "http://x.example", t)).toBe("genericError:{}");
  });
});

describe("browserOrigin", () => {
  it("reads the origin from the window rather than from the refusal", () => {
    expect(browserOrigin()).toBe(window.location.origin);
  });
});
