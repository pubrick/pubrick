import { ORIGIN_MISMATCH_CODE } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { originMismatchPlugin } from "./auth-origin.plugin";

const PUBLIC_ORIGIN = "http://localhost:3000";

/** The plugin hook, called the way better-auth's router calls it. */
async function onRequest(
  headers: Record<string, string>,
  configuredOrigin = PUBLIC_ORIGIN,
): Promise<Response | undefined> {
  const plugin = originMismatchPlugin(configuredOrigin);
  const result = await plugin.onRequest?.(
    new Request("http://api:3001/api/auth/sign-in/email", { method: "POST", headers }),
    // The hook reads nothing off the auth context.
    {} as never,
  );
  return result && "response" in result ? result.response : undefined;
}

describe("originMismatchPlugin", () => {
  it("refuses an auth request from another port, naming both origins", async () => {
    const response = await onRequest({ origin: "http://localhost:3080" });
    expect(response?.status).toBe(403);
    const body = (await response?.json()) as Record<string, string>;
    expect(body.code).toBe(ORIGIN_MISMATCH_CODE);
    expect(body.expectedOrigin).toBe(PUBLIC_ORIGIN);
    expect(body.message).toContain("http://localhost:3080");
    expect(body.message).toContain(PUBLIC_ORIGIN);
    expect(body.message).toContain("PUBLIC_ORIGIN");
  });

  it("lets the configured origin through, however it is spelt", async () => {
    expect(await onRequest({ origin: "http://localhost:3000/" })).toBeUndefined();
  });

  /**
   * The deployment that must NOT be refused: TLS terminates on a name the api
   * never hears, so `Host` is the compose service and `X-Forwarded-Host` is the
   * public name — while the browser's own `Origin` IS the public name. A check
   * reading either of the first two refuses this perfectly good install; reading
   * `Origin` lets it through, which is the whole reason for that choice.
   */
  it("lets a correctly proxied request through, whatever Host says", async () => {
    expect(
      await onRequest(
        {
          origin: "https://pubrick.example",
          "x-forwarded-host": "pubrick.example",
          "x-forwarded-proto": "https",
        },
        "https://pubrick.example",
      ),
    ).toBeUndefined();
  });

  // curl, the MCP server, a same-origin GET: no evidence either way. better-auth's
  // own check is still behind this one and answers those.
  it("passes a request with no Origin header through instead of refusing it", async () => {
    expect(await onRequest({})).toBeUndefined();
  });

  it("passes an unparseable Origin through rather than guessing", async () => {
    expect(await onRequest({ origin: "null" })).toBeUndefined();
  });

  it("cannot refuse anything when the configured origin is itself unusable", async () => {
    expect(await onRequest({ origin: "http://localhost:3080" }, "localhost:3000")).toBeUndefined();
  });
});
