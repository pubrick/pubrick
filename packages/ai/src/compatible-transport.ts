import { APICallError } from "@ai-sdk/provider";
import { compatibleBaseURLSchema, PermanentError, TransientError } from "@pubrick/shared";
import {
  assertUrlIsSafeToFetch,
  GuardedFetchError,
  guardedFetch,
  readBodyAsText,
} from "guarded-fetch";
import { withRunFailure } from "./classify.js";
import { ProviderPreflightError } from "./provider-preflight.js";

export const COMPATIBLE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function validateCompatibleEndpoint(baseURL: string): Promise<void> {
  if (!compatibleBaseURLSchema.safeParse(baseURL).success)
    throw new ProviderPreflightError("Invalid compatible API endpoint");
  try {
    await assertUrlIsSafeToFetch(baseURL, { httpsOnly: true, opaqueErrors: true });
  } catch {
    throw new ProviderPreflightError("Compatible API endpoint must resolve to public addresses");
  }
}

/** Nonstreaming Chat Completions, with checked DNS both before and during connect. */
export function compatibleFetch(baseURL: string): typeof fetch {
  const base = compatibleBaseURLSchema.safeParse(baseURL);
  if (!base.success) throw new ProviderPreflightError("Invalid compatible API endpoint");
  const endpoint = `${base.data.replace(/\/$/, "")}/chat/completions`;
  return async (input, init) => {
    const destination = input instanceof Request ? input.url : String(input);
    if (destination !== endpoint || init?.method !== "POST")
      throw new ProviderPreflightError("Compatible API request is outside its configured endpoint");
    const deadlineAt = Date.now() + 120_000;
    let response: Response;
    try {
      // Keep guarded-fetch's default dispatcher: it pins a public DNS answer at
      // socket creation. Replacing it with an ordinary dispatcher reopens rebinding.
      response = await guardedFetch(endpoint, {
        ...init,
        signal: init?.signal ?? undefined,
        httpsOnly: true,
        followRedirects: false,
        opaqueErrors: true,
        timeoutMs: 120_000,
        sanitizeHeaders: true,
      });
    } catch (error) {
      if (
        error instanceof GuardedFetchError &&
        ["hostname_unsafe", "invalid_url", "protocol_not_allowed", "host_not_allowed"].includes(
          error.code,
        )
      )
        throw new ProviderPreflightError("Compatible API destination was refused before dispatch");
      if (init?.signal?.aborted) throw init.signal.reason ?? error;
      // A connection may have reached the upstream. Keep an actual call with
      // unknown cost; native SDK retry policy still applies to transport outages.
      throw new APICallError({
        message: "Compatible API transport failed",
        url: endpoint,
        requestBodyValues: undefined,
        isRetryable: true,
        cause: error,
      });
    }
    // guarded-fetch detaches its header-phase abort listener after returning.
    // Keep the caller's abort wired to streaming body consumption as well.
    const readable = response.body?.pipeThrough(new TransformStream(), {
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    const bodyResponse = new Response(readable ?? null);
    let body: string;
    try {
      body = await readBodyAsText(bodyResponse, {
        maxResponseBytes: COMPATIBLE_MAX_RESPONSE_BYTES,
        deadlineAt,
        opaqueErrors: true,
      });
    } catch (error) {
      if (init?.signal?.aborted) throw init.signal.reason ?? error;
      if (error instanceof GuardedFetchError && error.code === "response_too_large")
        throw withRunFailure(
          new PermanentError("Compatible API response exceeded the 4 MiB limit"),
          "no_structured_output",
        );
      if (error instanceof GuardedFetchError && error.code === "timeout")
        throw withRunFailure(
          new TransientError("Compatible API response did not finish before its deadline"),
          "timed_out",
        );
      throw new APICallError({
        message: "Compatible API response transport failed",
        url: endpoint,
        requestBodyValues: undefined,
        isRetryable: true,
        cause: error,
      });
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
