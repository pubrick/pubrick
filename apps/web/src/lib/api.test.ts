import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiVoid, errorMessage } from "./api";

function jsonResponse(status: number, body: unknown, statusText = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

/** What a 204 actually is: no body at all, so `json()` throws rather than resolving. */
function noContentResponse(): Response {
  return {
    ok: true,
    status: 204,
    statusText: "No Content",
    text: async () => "",
    json: async () => {
      throw new SyntaxError("Unexpected end of JSON input");
    },
  } as unknown as Response;
}

describe("api", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("returns the parsed JSON body on success", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, { id: "1", name: "Acme" }));

    await expect(api("/orgs/1")).resolves.toEqual({ id: "1", name: "Acme" });
  });

  it("always sends content-type: application/json", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(200, {}));

    await api("/orgs/1");

    expect(fetch).toHaveBeenCalledWith(
      "/orgs/1",
      expect.objectContaining({
        headers: expect.objectContaining({ "content-type": "application/json" }),
      }),
    );
  });

  it("surfaces the server's message verbatim on a 4xx", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(400, {
        statusCode: 400,
        message: "Name is already taken",
        error: "Bad Request",
      }),
    );

    const error = await api("/orgs").catch((e) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).message).toBe("Name is already taken");
  });

  it("falls back to a generic message on a 5xx", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(500, {}, "Internal Server Error"));

    const error = await api("/orgs").catch((e) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(500);
    expect(errorMessage(error, "Something went wrong")).toBe("Something went wrong");
  });

  it("wraps a network failure in an ApiError with sentinel status 0", async () => {
    const networkError = new TypeError("Failed to fetch");
    vi.mocked(fetch).mockRejectedValue(networkError);

    const error = await api("/orgs").catch((e) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
  });

  it("maps a network failure to the caller's translated generic fallback, not a raw browser message", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await api("/orgs").catch((e) => e as ApiError);

    expect(errorMessage(error, "Something went wrong. Please try again.")).toBe(
      "Something went wrong. Please try again.",
    );
  });

  it("marks a 403 with the 'no active organization' detail as noActiveOrg", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(403, {
        statusCode: 403,
        message: "No active organization",
        error: "Forbidden",
      }),
    );

    const error = await api("/orgs").catch((e) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect((error as ApiError).noActiveOrg).toBe(true);
    expect((error as ApiError).message).toBe(
      "No active organization — create or select one first.",
    );
  });

  it("does not mark an unrelated 403 as noActiveOrg", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(403, { statusCode: 403, message: "You don't have access", error: "Forbidden" }),
    );

    const error = await api("/orgs").catch((e) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).noActiveOrg).toBe(false);
    expect((error as ApiError).message).toBe("You don't have access to this.");
  });
});

describe("apiVoid", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("resolves on a 204 without trying to parse a body", async () => {
    const res = noContentResponse();
    const parse = vi.spyOn(res, "json");
    vi.mocked(fetch).mockResolvedValue(res);

    await expect(apiVoid("/api/content/1/opened", { method: "POST" })).resolves.toBeUndefined();
    expect(parse).not.toHaveBeenCalled();
  });

  it("rejects with the same ApiError contract as api() on a 4xx", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(404, { statusCode: 404, message: "Content not found", error: "Not Found" }),
    );

    const error = await apiVoid("/api/content/1/opened", { method: "POST" }).catch(
      (e) => e as ApiError,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toBe("Content not found");
  });

  it("wraps a network failure as ApiError(0), not a raw TypeError", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));

    const error = await apiVoid("/api/content/1/opened", { method: "POST" }).catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
  });

  it("marks a 403 with no active organization, like api()", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(403, {
        statusCode: 403,
        message: "No active organization",
        error: "Forbidden",
      }),
    );

    const error = await apiVoid("/api/content/1/opened", { method: "POST" }).catch(
      (e) => e as ApiError,
    );

    expect((error as ApiError).noActiveOrg).toBe(true);
  });
});

describe("errorMessage", () => {
  it("shows a 4xx ApiError's own message", () => {
    expect(errorMessage(new ApiError(404, "Not found"), "fallback")).toBe("Not found");
  });

  it("falls back for a 5xx ApiError", () => {
    expect(errorMessage(new ApiError(500, "boom"), "fallback")).toBe("fallback");
  });

  it("falls back for a non-ApiError", () => {
    expect(errorMessage(new Error("boom"), "fallback")).toBe("fallback");
  });
});
