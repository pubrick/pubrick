import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleProxyProbe } from "./google-proxy.probe";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GoogleProxyProbe", () => {
  it("accepts an HTTP response from Google's fixed endpoint without an API key or generation", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 403 }));

    expect(await new GoogleProxyProbe().run("http://alice:private@proxy.example:8080")).toEqual({
      ok: true,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(JSON.stringify({ url, method: init?.method })).not.toContain("private");
  });

  it("returns a closed failure code instead of an error containing proxy credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("failed at http://alice:private@proxy.example:8080"),
    );
    expect(await new GoogleProxyProbe().run("http://alice:private@proxy.example:8080")).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("bounds a stalled proxy request", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const pending = new GoogleProxyProbe().run("http://proxy.example:8080");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });
});
