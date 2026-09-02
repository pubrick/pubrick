import { PermanentError, RUN_FAILURES, type RunFailure, TransientError } from "@pubrick/shared";
import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyAiError, redactSecrets, runFailureOf, withRunFailure } from "./classify.js";

function apiError(statusCode: number, responseHeaders?: Record<string, string>) {
  return new APICallError({
    message: `status ${statusCode}`,
    url: "https://example.invalid/v1/messages",
    requestBodyValues: {},
    statusCode,
    responseHeaders,
  });
}

describe("classifyAiError", () => {
  it("treats a 429 as transient", () => {
    const classified = classifyAiError(apiError(429));
    expect(classified).toBeInstanceOf(TransientError);
  });

  it("treats a 401 as permanent and keeps the status code", () => {
    const classified = classifyAiError(apiError(401));
    expect(classified).toBeInstanceOf(PermanentError);
    expect((classified as PermanentError).code).toBe(401);
  });

  it("unwraps a RetryError to the last error it saw", () => {
    const classified = classifyAiError(
      new RetryError({
        message: "failed after 3 attempts",
        reason: "maxRetriesExceeded",
        errors: [apiError(500), apiError(500)],
      }),
    );
    expect(classified).toBeInstanceOf(TransientError);
    expect(classified.message).toBe("status 500");
  });

  it("treats anything that is not an APICallError as permanent", () => {
    const classified = classifyAiError(new TypeError("cannot read properties of undefined"));
    expect(classified).toBeInstanceOf(PermanentError);
    expect(classified.message).toBe("cannot read properties of undefined");
  });

  it("classifies on the SDK's own isRetryable, not on our reading of the status", () => {
    // A provider may declare a normally-permanent status retryable. The SDK's
    // predicate is the authority; a status list of ours would drift from it.
    const overridden = new APICallError({
      message: "provider says try again",
      url: "https://example.invalid",
      requestBodyValues: {},
      statusCode: 400,
      isRetryable: true,
    });
    expect(classifyAiError(overridden)).toBeInstanceOf(TransientError);
  });

  it("reads the retry-after hint from the lowercase header", () => {
    const classified = classifyAiError(apiError(429, { "retry-after": "12" }));
    expect((classified as TransientError).retryAfterSeconds).toBe(12);
  });

  it("reads retry-after-ms and rounds up to whole seconds", () => {
    const classified = classifyAiError(apiError(429, { "retry-after-ms": "1500" }));
    expect((classified as TransientError).retryAfterSeconds).toBe(2);
  });

  it("treats an empty retry-after header as no hint, not as zero seconds", () => {
    // `Number("")` is 0, which would be read as "retry immediately" — a hot loop
    // against the provider that has just asked us to slow down.
    expect(
      (classifyAiError(apiError(429, { "retry-after": "" })) as TransientError).retryAfterSeconds,
    ).toBeUndefined();
    expect(
      (classifyAiError(apiError(429, { "retry-after": "   " })) as TransientError)
        .retryAfterSeconds,
    ).toBeUndefined();
    expect(
      (classifyAiError(apiError(429, { "retry-after-ms": "" })) as TransientError)
        .retryAfterSeconds,
    ).toBeUndefined();
  });

  it("reads an HTTP-date retry-after", () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    const seconds = (classifyAiError(apiError(429, { "retry-after": at })) as TransientError)
      .retryAfterSeconds;
    expect(seconds).toBeGreaterThan(25);
    expect(seconds).toBeLessThanOrEqual(30);
  });

  it("leaves an already-classified error alone", () => {
    const permanent = new PermanentError("already decided");
    expect(classifyAiError(permanent)).toBe(permanent);
    const transient = new TransientError("also decided", 5);
    expect(classifyAiError(transient)).toBe(transient);
  });

  describe("a cancelled call", () => {
    // An AbortError is not an APICallError, so without its own branch it fell
    // through to a bare permanent error and the user was shown the DOM's own
    // sentence, "This operation was aborted" — true, and about nothing they
    // recognise as having done.
    const CANCELLED = "the model call was cancelled before it finished";

    it("gets its own sentence, not the DOM's", () => {
      const controller = new AbortController();
      controller.abort();

      const classified = classifyAiError(controller.signal.reason);

      expect(classified).toBeInstanceOf(PermanentError);
      expect(classified.message).toBe(CANCELLED);
      expect(classified.message).not.toContain("This operation was aborted");
    });

    it("is permanent, because nobody is waiting for the answer any more", () => {
      // Not transient: a retry would spend money on a result the caller has
      // already withdrawn its request for.
      const controller = new AbortController();
      controller.abort();
      expect(classifyAiError(controller.signal.reason)).not.toBeInstanceOf(TransientError);
    });

    it("recognises the abort the SDK raises from inside its own retry backoff", () => {
      // Measured: aborting while `retryWithExponentialBackoff` is sleeping
      // rejects with `DOMException("Delay was aborted", "AbortError")` — another
      // message, another construction site, the same cancellation.
      expect(classifyAiError(new DOMException("Delay was aborted", "AbortError")).message).toBe(
        CANCELLED,
      );
    });

    it("recognises an AbortError that is a plain Error rather than a DOMException", () => {
      // Runtimes differ on which class they use; the name is what they agree on.
      const error = new Error("The user aborted a request.");
      error.name = "AbortError";
      expect(classifyAiError(error).message).toBe(CANCELLED);
    });

    it("does not mistake an ordinary error that merely mentions aborting", () => {
      // The branch keys on `name`, never on the message text, or a provider
      // whose 500 body happened to say "aborted" would be reported as a
      // cancellation the user never asked for.
      const classified = classifyAiError(new Error("upstream aborted the connection"));
      expect(classified.message).toBe("upstream aborted the connection");
    });
  });

  it("handles a thrown non-error", () => {
    expect(classifyAiError("just a string")).toBeInstanceOf(PermanentError);
    expect(classifyAiError("just a string").message).toBe("just a string");
  });

  /**
   * The code is the whole point of this function now: it is what the worker
   * stores in `pipeline_runs.error` and what the API hands a browser. Before
   * these existed the provider's own message went there verbatim — the sentence
   * that quotes the submitted key back ("Incorrect API key provided: sk-…") —
   * and it was also untranslatable in a product that ships four languages.
   */
  describe("the closed code it tags", () => {
    it("calls a 401 an invalid key", () => {
      expect(runFailureOf(classifyAiError(apiError(401)))).toBe("invalid_key");
    });

    it("calls a 403 an invalid key too", () => {
      expect(runFailureOf(classifyAiError(apiError(403)))).toBe("invalid_key");
    });

    it("calls a 404 an unknown model", () => {
      expect(runFailureOf(classifyAiError(apiError(404)))).toBe("model_not_found");
    });

    it("calls any other status a refusal", () => {
      expect(runFailureOf(classifyAiError(apiError(400)))).toBe("provider_refused");
    });

    it("calls a retryable error rate limited", () => {
      expect(runFailureOf(classifyAiError(apiError(429)))).toBe("rate_limited");
    });

    it("calls a cancelled call cancelled", () => {
      const controller = new AbortController();
      controller.abort();
      expect(runFailureOf(classifyAiError(controller.signal.reason))).toBe("cancelled");
    });

    it("calls anything it cannot attribute to the provider internal", () => {
      expect(runFailureOf(classifyAiError(new TypeError("undefined is not a function")))).toBe(
        "internal",
      );
      expect(runFailureOf(classifyAiError("just a string"))).toBe("internal");
    });

    it("keeps the tag an upstream throw site already chose", () => {
      // `generateStructured` knows it ran out of repair attempts; this function
      // could only guess. Re-tagging here would overwrite knowledge with a
      // guess.
      const upstream = withRunFailure(new PermanentError("twice"), "no_structured_output");
      expect(runFailureOf(classifyAiError(upstream))).toBe("no_structured_output");
    });

    it("reports no tag for an error nobody classified, so a caller must decide", () => {
      expect(runFailureOf(new Error("unclassified"))).toBeUndefined();
      expect(runFailureOf(undefined)).toBeUndefined();
    });

    it("refuses a tag that is not one of the codes", () => {
      // The property is just a property: an error can arrive from a duplicate
      // copy of this package, or from a build that knew a code this one does
      // not. A value that is not in the set must read as "no tag" rather than
      // reach a `Record<RunFailure, …>` lookup in the web app.
      const forged = Object.assign(new Error("forged"), {
        runFailure: "Incorrect API key provided: sk-live-abc",
      });
      expect(runFailureOf(forged)).toBeUndefined();
    });

    it("only ever tags with a member of the published set", () => {
      const tags: Array<RunFailure | undefined> = [
        runFailureOf(classifyAiError(apiError(401))),
        runFailureOf(classifyAiError(apiError(404))),
        runFailureOf(classifyAiError(apiError(429))),
        runFailureOf(classifyAiError(apiError(500))),
        runFailureOf(classifyAiError(new Error("boom"))),
      ];
      for (const tag of tags) {
        expect(RUN_FAILURES).toContain(tag);
      }
    });
  });

  /**
   * The message survives, because an operator needs it — but only into a log,
   * and only with the credentials taken out of it. Each pattern has its own
   * test: a redaction nothing pins is the same hole in a new place.
   */
  describe("redactSecrets", () => {
    it("removes the literal secret the caller has in scope", () => {
      // A shape no pattern below would catch, so this test can only pass
      // because the literal-string pass exists.
      const key = "9f3c-quiet-looking-credential-42";
      expect(redactSecrets(`rejected the key ${key} at 09:00`, key)).toBe(
        "rejected the key *** at 09:00",
      );
    });

    it("removes every occurrence of it, not just the first", () => {
      const key = "9f3c-quiet-looking-credential-42";
      expect(redactSecrets(`${key} and again ${key}`, key)).not.toContain(key);
    });

    it("removes a key carried in a URL's query, which is how Google's errors quote it", () => {
      const message =
        "quota exceeded for https://generativelanguage.googleapis.com/v1beta/models:generateContent?key=AIzaSyTOTALLYREALLOOKING&alt=sse";
      const redacted = redactSecrets(message);
      expect(redacted).not.toContain("AIzaSyTOTALLYREALLOOKING");
      expect(redacted).toContain("?key=***");
      // Only the value: the rest of the URL is what makes the log useful.
      expect(redacted).toContain("generativelanguage.googleapis.com");
      expect(redacted).toContain("&alt=sse");
    });

    it("removes a bearer token", () => {
      expect(redactSecrets("Authorization: Bearer or-v1-9c8b7a6d5e4f3210")).toBe(
        "Authorization: Bearer ***",
      );
    });

    it("removes an OpenAI-shaped key quoted back in the prose", () => {
      expect(redactSecrets("Incorrect API key provided: sk-live-51ABCdefGHIjkl.")).toBe(
        "Incorrect API key provided: sk-***.",
      );
    });

    it("removes a Google-shaped key quoted back in the prose", () => {
      expect(redactSecrets("API key not valid: AIzaSyA1b2C3d4E5f6G7h8I9")).toBe(
        "API key not valid: AIza***",
      );
    });

    it("leaves an ordinary sentence alone, so a log stays worth reading", () => {
      const message = "The model is overloaded. Please try again later.";
      expect(redactSecrets(message, "some-key")).toBe(message);
    });

    it("does not treat an empty secret as a match, which would redact everything", () => {
      // `"abc".split("")` is every character: an empty or blank stored key would
      // otherwise turn the whole message into a row of asterisks.
      expect(redactSecrets("provider said no", "")).toBe("provider said no");
      expect(redactSecrets("provider said no", "   ")).toBe("provider said no");
    });

    it("redacts the message classifyAiError puts on the error it returns", () => {
      const leaky = new APICallError({
        message: "Incorrect API key provided: sk-live-51ABCdefGHIjkl",
        url: "https://example.invalid/v1",
        requestBodyValues: {},
        statusCode: 401,
      });
      expect(classifyAiError(leaky).message).not.toContain("sk-live-51ABCdefGHIjkl");
    });

    it("redacts the message on the transient arm too", () => {
      const leaky = new APICallError({
        message: "rate limited for key sk-live-51ABCdefGHIjkl",
        url: "https://example.invalid/v1",
        requestBodyValues: {},
        statusCode: 429,
      });
      expect(classifyAiError(leaky).message).not.toContain("sk-live-51ABCdefGHIjkl");
    });
  });
});
