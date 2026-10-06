import {
  GuardedFetchErrorCode,
  guardedFetch,
  isGuardedFetchError,
  readBodyAsJson,
} from "guarded-fetch";
import { z } from "zod";
import { type StagedPublisherOptions, UnknownPreparationError } from "./staged-types.js";
import {
  PermanentPublishError,
  PlatformRejectionError,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "./types.js";

export const META_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256_000;
const OFFICIAL_ORIGINS = new Set([
  "https://graph.threads.com",
  "https://graph.instagram.com",
  "https://graph.facebook.com",
]);
type Phase = "read" | "prepare" | "finalize";
const beforeSendCodes = new Set<string>([
  GuardedFetchErrorCode.INVALID_URL,
  GuardedFetchErrorCode.PROTOCOL_NOT_ALLOWED,
  GuardedFetchErrorCode.HOST_NOT_ALLOWED,
  GuardedFetchErrorCode.HOSTNAME_UNSAFE,
]);
const graphErrorSchema = z.object({
  error: z.object({
    code: z.number().int(),
    type: z.string().min(1),
    message: z.string().min(1),
    is_transient: z.boolean().optional(),
  }),
});
// Only explicit provider refusal codes prove that a POST was not accepted.
const knownRefusalCodes = new Set([10, 100, 190, 200, 368]);
const knownRateCodes = new Set([4, 17, 32, 613]);

function lost(phase: Phase): never {
  if (phase === "read")
    throw new TransientPublishError("Meta verification or readiness could not be read");
  if (phase === "prepare")
    throw new UnknownPreparationError(
      "Meta preparation receipt was lost; inspect or explicitly recover preparation",
    );
  throw new UnknownOutcomePublishError(
    "Meta final publication outcome is unknown; inspect the destination before sending again",
  );
}

/** Provider protocol transport, using the existing maintained SSRF/deadline/body guards. */
export async function metaRequest(
  origin:
    | "https://graph.threads.com"
    | "https://graph.instagram.com"
    | "https://graph.facebook.com",
  path: string,
  accessToken: string,
  phase: Phase,
  params: URLSearchParams,
  options?: StagedPublisherOptions,
): Promise<unknown> {
  if (!OFFICIAL_ORIGINS.has(origin))
    throw new PermanentPublishError("Meta requires a fixed official API endpoint");
  let url: URL;
  try {
    url = new URL(path, `${origin}/`);
  } catch {
    throw new PermanentPublishError("Meta requires a fixed official API endpoint");
  }
  if (url.origin !== origin || url.username || url.password || url.hash)
    throw new PermanentPublishError("Meta requires a fixed official API endpoint");
  const read = phase === "read";
  // The current native Instagram guide explicitly supports JSON POST bodies.
  const jsonBody = !read && origin === "https://graph.instagram.com";
  if (read) url.search = params.toString();
  const deadlineAt = Date.now() + META_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await guardedFetch(url.toString(), {
      method: read ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...(read
          ? {}
          : {
              "Content-Type": jsonBody ? "application/json" : "application/x-www-form-urlencoded",
            }),
      },
      body: read ? undefined : jsonBody ? JSON.stringify(Object.fromEntries(params)) : params,
      httpsOnly: true,
      allowedHosts: [url.hostname],
      followRedirects: false,
      timeoutMs: META_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
      ...(options?.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
  } catch (error) {
    if (isGuardedFetchError(error) && beforeSendCodes.has(error.code))
      throw new PermanentPublishError("Meta could not be reached through a safe public endpoint");
    // Do not infer a pre-send failure from opaque nested socket/connect causes.
    return lost(phase);
  }
  let body: unknown;
  try {
    body = await readBodyAsJson(response, {
      maxResponseBytes: MAX_RESPONSE_BYTES,
      deadlineAt,
      opaqueErrors: true,
    });
  } catch {
    return lost(phase);
  }
  if (response.ok) return body;
  const envelope = graphErrorSchema.safeParse(body);
  if (envelope.success && response.status >= 400 && response.status < 500) {
    if (knownRateCodes.has(envelope.data.error.code))
      throw new TransientPublishError(
        "Meta refused the request because its rate limit was reached",
        response.status,
      );
    if (knownRefusalCodes.has(envelope.data.error.code))
      throw new PlatformRejectionError(
        "Meta refused the credentials, permissions, or reviewed input",
        response.status,
      );
  }
  if (read) {
    if (
      envelope.success &&
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429
    )
      throw new PermanentPublishError(
        "Meta could not verify this saved connection",
        response.status,
      );
    throw new TransientPublishError(
      "Meta verification or readiness is temporarily unavailable",
      response.status,
    );
  }
  // HTML gateways, redirects, unspecified errors and 5xx do not prove refusal.
  return lost(phase);
}
