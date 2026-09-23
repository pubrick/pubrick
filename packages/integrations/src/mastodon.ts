import { isIP } from "node:net";
import { guardedFetch, isPermanentGuardedFetchError, readBodyAsJson } from "guarded-fetch";
import { z } from "zod";
import {
  PermanentPublishError,
  PlatformRejectionError,
  type Publisher,
  type PublisherOptions,
  type PublishResult,
  TransientPublishError,
  UnknownOutcomePublishError,
  type VerifyResult,
} from "./types.js";

export const MASTODON_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256_000;
const DEFAULT_MAX_CHARACTERS = 500;
const credentialsSchema = z.object({
  instanceUrl: z.string().url(),
  accessToken: z.string().min(1),
  visibility: z.enum(["public", "unlisted"]).optional(),
});
type MastodonCredentials = z.infer<typeof credentialsSchema>;
const accountSchema = z.object({ id: z.string().min(1), username: z.string().min(1) });
const instanceSchema = z.object({
  configuration: z.object({
    statuses: z.object({ max_characters: z.number().int().positive().max(100_000) }),
  }),
});
const statusSchema = z.object({ id: z.string().min(1), url: z.string().nullish() });
const errorSchema = z.object({ error: z.string().min(1) });
type Phase = "prepare" | "publish";

/** Only a bare HTTPS public hostname is a valid Mastodon instance origin. */
function instanceOrigin(credentials: MastodonCredentials, options?: PublisherOptions): URL {
  let url: URL;
  try {
    url = new URL(credentials.instanceUrl);
  } catch {
    throw new PermanentPublishError("Mastodon instance URL is invalid");
  }
  const hostname = url.hostname.toLowerCase();
  const labels = hostname.split(".");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    isIP(hostname) !== 0 ||
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
    ["localhost", "local", "internal", "test", "example", "invalid"].includes(
      labels[labels.length - 1] ?? "",
    )
  ) {
    throw new PermanentPublishError("Mastodon instance must be a public HTTPS host");
  }
  if (options?.baseUrl && options.baseUrl !== url.origin) {
    throw new PermanentPublishError("Mastodon API override must match the connected instance");
  }
  return url;
}

const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);
function connectFailed(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if (CONNECT_PHASE_CODES.has(String((current as { code?: unknown }).code ?? ""))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function request(
  origin: URL,
  path: string,
  credentials: MastodonCredentials,
  phase: Phase,
  method: "GET" | "POST",
  body?: URLSearchParams,
  options?: PublisherOptions,
): Promise<unknown> {
  const url = `${origin.origin}${path}`;
  let response: Response;
  try {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(body ? { body } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(MASTODON_REQUEST_TIMEOUT_MS),
    };
    response = options?.fetchImpl
      ? await options.fetchImpl(url, init)
      : await guardedFetch(url, {
          method,
          headers: init.headers,
          body,
          httpsOnly: true,
          allowedHosts: [origin.hostname],
          followRedirects: false,
          timeoutMs: MASTODON_REQUEST_TIMEOUT_MS,
          opaqueErrors: true,
        });
  } catch (error) {
    if (isPermanentGuardedFetchError(error)) {
      if (phase === "publish") {
        throw new UnknownOutcomePublishError("Mastodon post outcome is unknown");
      }
      throw new PermanentPublishError("Mastodon instance is not a safe public destination");
    }
    if (phase === "prepare" || connectFailed(error)) {
      throw new TransientPublishError("Mastodon could not be reached before publishing");
    }
    throw new UnknownOutcomePublishError("Mastodon post outcome is unknown");
  }

  let raw: unknown;
  try {
    raw = await readBodyAsJson(response, { maxResponseBytes: MAX_RESPONSE_BYTES });
  } catch {
    if (response.ok && phase === "publish") return undefined;
    const message = `Mastodon returned an unreadable response (HTTP ${response.status})`;
    if (phase === "prepare") {
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new PermanentPublishError(message, response.status);
      }
      throw new TransientPublishError(message, response.status);
    }
    throw new UnknownOutcomePublishError(message, response.status);
  }

  if (response.ok) return raw;
  const parsed = errorSchema.safeParse(raw);
  const message = parsed.success
    ? `Mastodon: ${parsed.data.error.split(credentials.accessToken).join("***")}`
    : `Mastodon HTTP ${response.status}`;
  if (phase === "prepare") {
    if (response.status === 429 || response.status >= 500) {
      throw new TransientPublishError(message, response.status);
    }
    if (response.status >= 400 && response.status < 500) {
      throw new PermanentPublishError(message, response.status);
    }
    throw new TransientPublishError(message, response.status);
  }
  if (parsed.success && response.status === 429)
    throw new TransientPublishError(message, response.status);
  if (parsed.success && response.status >= 400 && response.status < 500) {
    throw new PlatformRejectionError(message, response.status);
  }
  throw new UnknownOutcomePublishError(message, response.status);
}

function graphemeLength(value: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length;
}

export const mastodonPublisher: Publisher<MastodonCredentials> = {
  platform: "mastodon",
  maxTextLength: DEFAULT_MAX_CHARACTERS,
  credentialsSchema,

  async verify(credentials, options): Promise<VerifyResult> {
    try {
      const origin = instanceOrigin(credentials, options);
      const account = accountSchema.safeParse(
        await request(
          origin,
          "/api/v1/accounts/verify_credentials",
          credentials,
          "prepare",
          "GET",
          undefined,
          options,
        ),
      );
      if (!account.success)
        return { ok: false, reason: "Mastodon returned unusable account details" };
      return {
        ok: true,
        account: `@${account.data.username}@${origin.hostname}`,
        target: origin.hostname,
      };
    } catch (error) {
      if (
        error instanceof PermanentPublishError ||
        error instanceof TransientPublishError ||
        error instanceof UnknownOutcomePublishError
      ) {
        return { ok: false, reason: error.message };
      }
      throw error;
    }
  },

  async publish(credentials, input, options): Promise<PublishResult> {
    const origin = instanceOrigin(credentials, options);
    if (input.image) {
      throw new PermanentPublishError("Mastodon cover publishing is unavailable; remove the cover");
    }
    const length = graphemeLength(input.text);
    if (length < 1 || length > DEFAULT_MAX_CHARACTERS) {
      throw new PermanentPublishError(
        `Mastodon text must be 1..${DEFAULT_MAX_CHARACTERS} characters, got ${length}`,
      );
    }
    const instance = instanceSchema.safeParse(
      await request(origin, "/api/v2/instance", credentials, "prepare", "GET", undefined, options),
    );
    if (!instance.success) {
      throw new TransientPublishError("Mastodon did not provide its text length limit");
    }
    if (length > instance.data.configuration.statuses.max_characters) {
      throw new PermanentPublishError(
        `Mastodon instance allows ${instance.data.configuration.statuses.max_characters} characters; got ${length}`,
      );
    }
    const raw = await request(
      origin,
      "/api/v1/statuses",
      credentials,
      "publish",
      "POST",
      new URLSearchParams({
        status: input.text,
        visibility: credentials.visibility ?? "public",
      }),
      options,
    );
    // A successful HTTP response has already posted the status. An incomplete
    // receipt cannot be retried without risking a duplicate.
    const parsed = statusSchema.safeParse(raw);
    if (!parsed.success) return { externalId: null, externalUrl: null };
    let externalUrl: string | null = null;
    if (parsed.data.url) {
      try {
        const statusUrl = new URL(parsed.data.url);
        if (
          statusUrl.protocol === "https:" &&
          statusUrl.origin === origin.origin &&
          !statusUrl.username &&
          !statusUrl.password
        ) {
          externalUrl = statusUrl.href;
        }
      } catch {
        // Keep the status ID; a malformed public link does not undo the post.
      }
    }
    return { externalId: parsed.data.id, externalUrl };
  },
};
