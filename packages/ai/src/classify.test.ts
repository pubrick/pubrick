import { PermanentError, TransientError } from "@pubrick/shared";
import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyAiError } from "./classify.js";

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
});
