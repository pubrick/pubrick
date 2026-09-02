import {
  API_ERROR_CODES,
  type ApiErrorBody,
  type ApiErrorCode,
  MAX_CONCURRENT_RUNS,
  refusalBody,
} from "@pubrick/shared";
import { createTranslator } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import pt from "../../messages/pt.json";
import ru from "../../messages/ru.json";
import {
  ApiError,
  api,
  apiVoid,
  type ErrorTranslator,
  errorMessage,
  TRANSPORT_ERROR_CODES,
} from "./api";
import { onUnauthorized } from "./unauthorized";

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

  it("reports a 401 to the app, not only to the caller that made the request", async () => {
    // The caller gets a sentence; the APP has to get the fact. A screen that is
    // polling has nobody navigating, so without this the session's death never
    // reaches AppShell's guard and the reader is left on a dead screen. Both
    // wrappers go through `request()`, so the read-receipt POST reports too.
    const seen = vi.fn();
    const stop = onUnauthorized(seen);
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { statusCode: 401 }));

    await expect(api("/content")).rejects.toBeInstanceOf(ApiError);
    await expect(apiVoid("/content/1/opened", { method: "POST" })).rejects.toBeInstanceOf(ApiError);

    expect(seen).toHaveBeenCalledTimes(2);
    stop();
  });

  it("reports nothing to the app for any other failure", async () => {
    // A 403 is a permission and a 5xx is a blip. Reporting either would sign
    // people out over a restarting API.
    const seen = vi.fn();
    const stop = onUnauthorized(seen);

    vi.mocked(fetch).mockResolvedValue(jsonResponse(403, { message: "Forbidden" }));
    await expect(api("/content")).rejects.toBeInstanceOf(ApiError);
    vi.mocked(fetch).mockResolvedValue(jsonResponse(500, { message: "boom" }));
    await expect(api("/content")).rejects.toBeInstanceOf(ApiError);
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api("/content")).rejects.toBeInstanceOf(ApiError);

    expect(seen).not.toHaveBeenCalled();
    stop();
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

/**
 * THE REFUSALS, IN FOUR LANGUAGES.
 *
 * Everything below drives the REAL message files through the REAL next-intl
 * translator. A stub `t` that returns its key would pass every one of these
 * assertions while `es.json` said nothing at all, which is the exact failure
 * this whole change exists to remove — so the translator is built from the
 * shipped JSON and the assertions are on the Spanish and Russian sentences
 * themselves.
 *
 * The response bodies are built by `refusalBody`, the same function the api
 * throws with. A body shape that drifts on the server therefore breaks these
 * tests too, instead of leaving them green over a contract nobody honours.
 */
describe("a coded refusal, end to end from the HTTP body", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  const LOCALES = { en, es, ru, pt } as const;
  type LocaleId = keyof typeof LOCALES;

  const translator = (locale: LocaleId): ErrorTranslator =>
    createTranslator({
      locale,
      messages: LOCALES[locale] as Record<string, unknown>,
      namespace: "Errors",
    }) as unknown as ErrorTranslator;

  /** One real 4xx response, exactly as the api builds it. */
  async function refuse(body: ApiErrorBody): Promise<ApiError> {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(body.statusCode, body));
    return (await api("/api/content/1/approve", { method: "POST" }).catch((e) => e)) as ApiError;
  }

  it("carries the code off the wire, beside the English sentence", async () => {
    const error = await refuse(
      refusalBody(
        409,
        "content_pinned_approved",
        "Approved content cannot be edited; reject it first",
      ),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe("content_pinned_approved");
    // The sentence is NOT removed: it is what a developer reads in a network
    // tab and what an API consumer gets.
    expect(error.message).toBe("Approved content cannot be edited; reject it first");
  });

  it("renders the publish gate's refusal in Spanish", async () => {
    const error = await refuse(
      refusalBody(409, "unread_ai_draft", "No one has read this AI-written draft yet"),
    );

    const shown = errorMessage(error, "fallback", translator("es"));

    expect(shown).toBe(es.Errors.unread_ai_draft);
    expect(shown).not.toBe(error.message);
    expect(shown).not.toMatch(/Errors\./);
  });

  it("renders the publish gate's refusal in Russian", async () => {
    const error = await refuse(
      refusalBody(409, "unread_ai_draft", "No one has read this AI-written draft yet"),
    );

    const shown = errorMessage(error, "fallback", translator("ru"));

    expect(shown).toBe(ru.Errors.unread_ai_draft);
    expect(shown).not.toBe(error.message);
    expect(shown).toMatch(/[а-яё]/i);
  });

  it("renders the run admission cap in Spanish and Russian, with the limit filled in", async () => {
    // The number does not travel on the wire. Both sides import
    // MAX_CONCURRENT_RUNS, so the sentence cannot promise a different rule than
    // the api enforces.
    const error = await refuse(
      refusalBody(409, "run_limit_reached", "This organization already has 3 generation runs"),
    );

    for (const locale of ["es", "ru"] as const) {
      const shown = errorMessage(error, "fallback", translator(locale));
      expect(shown).toContain(String(MAX_CONCURRENT_RUNS));
      expect(shown).not.toMatch(/\{limit\}/);
    }
  });

  it("never shows a wire field name for a body zod refused", async () => {
    // "scheduledAt: scheduledAt must be in the future" is what a developer sees
    // in `message`, and it stays there. What the READER gets names the field the
    // way the screen does.
    const error = await refuse(
      refusalBody(400, "invalid_request", ["scheduledAt: scheduledAt must be in the future"]),
    );

    expect(error.message).toBe("scheduledAt: scheduledAt must be in the future");
    for (const locale of ["en", "es", "ru", "pt"] as const) {
      expect(errorMessage(error, "fallback", translator(locale))).not.toMatch(/scheduledAt/);
    }
  });

  it("translates the session and organization refusals the web writes itself", async () => {
    // These two sentences were never the api's — `request()` writes them — and
    // they were English in all four languages for exactly the same reason.
    vi.mocked(fetch).mockResolvedValue(jsonResponse(401, { statusCode: 401 }));
    const signedOut = (await api("/api/content").catch((e) => e)) as ApiError;
    expect(signedOut.code).toBe("signed_out");
    expect(errorMessage(signedOut, "fallback", translator("ru"))).toBe(ru.Errors.signed_out);

    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(403, { statusCode: 403, message: "No active organization", error: "Forbidden" }),
    );
    const noOrg = (await api("/api/content").catch((e) => e)) as ApiError;
    expect(noOrg.noActiveOrg).toBe(true);
    expect(errorMessage(noOrg, "fallback", translator("es"))).toBe(
      es.Errors.no_active_organization,
    );
  });

  it("says something true about a code it has never heard of", async () => {
    // A released server can be newer than a cached client. The code is unknown,
    // so no key exists to translate — but the api's own English sentence is in
    // the body, it is specific, and (unlike a provider's error text, which is
    // why `runFailureMessage` may NOT do this) it cannot contain a secret.
    // Untranslated-but-true beats a generic apology, and beats a rendered key
    // path or a blank line outright.
    const error = await refuse({
      statusCode: 409,
      error: "Conflict",
      message: "This post is being rewritten by someone else right now",
      code: "content_being_rewritten" as ApiErrorCode,
    });

    const shown = errorMessage(error, "Something went wrong.", translator("es"));

    expect(shown).toBe("This post is being rewritten by someone else right now");
    expect(shown).not.toMatch(/Errors\./);
    expect(shown.trim()).not.toBe("");
  });

  it("falls back to the caller's sentence when an unknown code brings no sentence either", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(409, { statusCode: 409, code: "who_knows" }));
    const error = (await api("/api/content").catch((e) => e)) as ApiError;

    expect(errorMessage(error, "Algo salió mal.", translator("es"))).toBe("Algo salió mal.");
  });

  it("keeps the untranslated contract for a caller that passes no translator", async () => {
    // Three screens are not converted yet (brands, one brand's channels, the run
    // receipt). They must keep showing the api's sentence rather than nothing.
    const error = await refuse(
      refusalBody(409, "content_already_published", "This content has already been published"),
    );

    expect(errorMessage(error, "fallback")).toBe("This content has already been published");
  });

  it("has a real sentence for every code, in every language", () => {
    // The web's map is total over the union by TYPE; this is the other half —
    // that each key it names actually resolves in all four files. A code whose
    // message is missing renders as `Errors.<code>`; one whose message is empty
    // renders as nothing at all. Both are caught here as well as by the parity
    // suite, because this is the file that decides what a reader sees.
    for (const locale of ["en", "es", "ru", "pt"] as const) {
      const t = translator(locale);
      for (const code of [...API_ERROR_CODES, ...TRANSPORT_ERROR_CODES]) {
        const shown = errorMessage(
          new ApiError(409, "server sentence", false, code),
          "fallback",
          t,
        );
        expect(shown, `${locale}/${code}`).not.toBe("server sentence");
        expect(shown, `${locale}/${code}`).not.toBe("fallback");
        expect(shown, `${locale}/${code}`).not.toMatch(/^Errors\./);
        expect(shown.trim(), `${locale}/${code}`).not.toBe("");
      }
    }
  });

  it("translates the same codes into four DIFFERENT sentences, not four copies of English", () => {
    // Parity plus non-blank is satisfied by pasting `en` into `es`. This is the
    // check that says the translations exist.
    for (const locale of ["es", "ru", "pt"] as const) {
      const t = translator(locale);
      const english = translator("en");
      for (const code of [...API_ERROR_CODES, ...TRANSPORT_ERROR_CODES]) {
        const error = new ApiError(409, "server sentence", false, code);
        expect(errorMessage(error, "fallback", t), `${locale}/${code} is still English`).not.toBe(
          errorMessage(error, "fallback", english),
        );
      }
    }
  });
});
