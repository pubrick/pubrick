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

  it("leaves an already-classified error alone", () => {
    const permanent = new PermanentError("already decided");
    expect(classifyAiError(permanent)).toBe(permanent);
    const transient = new TransientError("also decided", 5);
    expect(classifyAiError(transient)).toBe(transient);
  });

  it("handles a thrown non-error", () => {
    expect(classifyAiError("just a string")).toBeInstanceOf(PermanentError);
    expect(classifyAiError("just a string").message).toBe("just a string");
  });
});
