import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("private workspace export forwarding", () => {
  it("streams the archive using only the session cookie and trusted internal origin", async () => {
    vi.stubEnv("API_INTERNAL_URL", "http://127.0.0.1:3001");
    const bytes = new Uint8Array([31, 139, 8]);
    const fetcher = vi.fn().mockResolvedValue(
      new Response(bytes, {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": 'attachment; filename="pubrick-workspace.tar.gz"',
          "Set-Cookie": "unrelated=secret",
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const response = await GET(
      new Request("https://pubrick.example/api/workspace-data/export", {
        headers: {
          cookie: "session_token=fixture",
          authorization: "do-not-forward",
          host: "untrusted.example",
        },
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:3001/api/workspace-data/export",
      expect.objectContaining({
        headers: { cookie: "session_token=fixture" },
        cache: "no-store",
        redirect: "manual",
      }),
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain("pubrick-workspace.tar.gz");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("retains authorization refusal and sanitizes connection errors", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ message: "Forbidden" }, { status: 403 }))
      .mockRejectedValueOnce(new Error("postgres://private-connection"));
    vi.stubGlobal("fetch", fetcher);
    const request = new Request("https://pubrick.example/api/workspace-data/export");
    expect((await GET(request)).status).toBe(403);
    const unavailable = await GET(request);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("private-connection");
  });
});
