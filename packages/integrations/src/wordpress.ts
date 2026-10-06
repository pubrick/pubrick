import { isIP } from "node:net";
import { MAX_BODY_LENGTH } from "@pubrick/shared";
import {
  GuardedFetchErrorCode,
  guardedFetch,
  isGuardedFetchError,
  isSafeIpAddress,
  readBodyAsJson,
} from "guarded-fetch";
import { escape as escapeHtml } from "html-escaper";
import { z } from "zod";
import {
  AcceptedPublicationError,
  PermanentPublishError,
  PlatformRejectionError,
  type Publisher,
  type PublisherOptions,
  type PublishInput,
  type PublishResult,
  TransientPublishError,
  UnknownOutcomePublishError,
  type VerifyResult,
} from "./types.js";

export const WORDPRESS_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256_000;
const credentialsSchema = z.object({
  siteUrl: z.string().url().max(2048),
  username: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.trim().length > 0 && !/[:\r\n\0]/.test(value)),
  applicationPassword: z.string().min(1).max(256),
});
type WordPressCredentials = z.infer<typeof credentialsSchema>;
const userSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  username: z.string().min(1),
  capabilities: z.record(z.string(), z.boolean()),
});
const receiptSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.unknown().optional(),
  link: z.unknown().optional(),
});
const rejectionSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  data: z.object({ status: z.number().int().min(400).max(599) }),
});
type Phase = "verify" | "publish";

/** Preserve an installation's subdirectory and pin every authenticated request to it. */
function siteRoot(credentials: WordPressCredentials, options?: PublisherOptions): URL {
  let url: URL;
  try {
    url = new URL(credentials.siteUrl);
  } catch {
    throw new PermanentPublishError("WordPress site URL is invalid");
  }
  const hostname = url.hostname.toLowerCase();
  const literal = hostname.replace(/^\[/, "").replace(/\]$/, "");
  const labels = hostname.split(".");
  const publicHost = isIP(literal)
    ? isSafeIpAddress(literal)
    : labels.length >= 2 &&
      labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) &&
      !["localhost", "local", "internal", "test", "example", "invalid"].includes(
        labels[labels.length - 1] ?? "",
      );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !publicHost
  ) {
    throw new PermanentPublishError(
      "WordPress site must be a public HTTPS URL without credentials or query parameters",
    );
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  if (url.href.length > 2048)
    throw new PermanentPublishError("WordPress canonical site URL must be at most 2048 characters");
  if (options?.baseUrl) {
    let override: URL;
    try {
      override = new URL(options.baseUrl);
    } catch {
      throw new PermanentPublishError("WordPress API override must match the connected site");
    }
    if (!override.pathname.endsWith("/")) override.pathname += "/";
    if (override.href !== url.href)
      throw new PermanentPublishError("WordPress API override must match the connected site");
  }
  return url;
}

function checkedCredentials(credentials: WordPressCredentials): WordPressCredentials {
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success || !parsed.data.applicationPassword.replace(/\s/g, ""))
    throw new PermanentPublishError("WordPress username and application password are required");
  return parsed.data;
}

function authorization(credentials: WordPressCredentials): string {
  // WordPress displays generated application passwords in groups separated by spaces.
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.applicationPassword.replace(/\s/g, "")}`, "utf8").toString("base64")}`;
}

const BEFORE_SEND_CODES = new Set<string>([
  GuardedFetchErrorCode.INVALID_URL,
  GuardedFetchErrorCode.PROTOCOL_NOT_ALLOWED,
  GuardedFetchErrorCode.HOST_NOT_ALLOWED,
  GuardedFetchErrorCode.HOSTNAME_UNSAFE,
]);
const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);
function connectFailed(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    // A current timeout/socket code must not inherit an earlier connection refusal.
    // Only an otherwise unclassified cause chain ending in a connect failure is safe.
    const code = String((current as { code?: unknown }).code ?? "");
    if (current instanceof AggregateError) return false;
    if (CONNECT_PHASE_CODES.has(code)) return true;
    if (code && code !== GuardedFetchErrorCode.NETWORK_ERROR) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function request(
  root: URL,
  path: string,
  credentials: WordPressCredentials,
  phase: Phase,
  body: string | undefined,
  options?: PublisherOptions,
): Promise<{ raw: unknown; status: number }> {
  const deadlineAt = Date.now() + WORDPRESS_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await guardedFetch(new URL(path, root), {
      method: phase === "verify" ? "GET" : "POST",
      headers: {
        Authorization: authorization(credentials),
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body,
      httpsOnly: true,
      allowedHosts: [root.hostname],
      followRedirects: false,
      timeoutMs: WORDPRESS_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
      ...(options?.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
  } catch (error) {
    if (isGuardedFetchError(error) && BEFORE_SEND_CODES.has(error.code))
      throw new PermanentPublishError("WordPress site is not a safe public destination");
    if (phase === "verify" || connectFailed(error))
      throw new TransientPublishError("WordPress could not be reached before publishing");
    throw new UnknownOutcomePublishError("WordPress post outcome is unknown");
  }

  if (response.status >= 300 && response.status < 400) {
    // Cancellation is best-effort; a hanging redirect body must not extend the deadline.
    void response.body?.cancel().catch(() => undefined);
    if (phase === "verify")
      throw new PermanentPublishError(
        "WordPress redirected the API request. Use the site's canonical HTTPS URL",
        response.status,
      );
    throw new UnknownOutcomePublishError(
      "WordPress redirected the create request; inspect the site before retrying",
      response.status,
    );
  }
  let raw: unknown;
  try {
    raw = await readBodyAsJson(response, {
      maxResponseBytes: MAX_RESPONSE_BYTES,
      deadlineAt,
      opaqueErrors: true,
    });
  } catch {
    if (phase === "publish")
      throw new UnknownOutcomePublishError(
        "WordPress returned an unreadable create response",
        response.status,
      );
    if (response.status >= 400 && response.status < 500 && response.status !== 429)
      throw new PermanentPublishError("WordPress could not verify the account", response.status);
    throw new TransientPublishError(
      "WordPress account verification did not complete",
      response.status,
    );
  }
  if (response.ok) return { raw, status: response.status };
  const envelope = rejectionSchema.safeParse(raw);
  const providerRefused = envelope.success && envelope.data.data.status === response.status;
  // Provider messages may echo a password, Basic header or URL. Never expose them.
  const message = `WordPress request was refused (HTTP ${response.status})`;
  if (phase === "verify") {
    if (response.status === 429 || response.status >= 500)
      throw new TransientPublishError(message, response.status);
    if (response.status >= 400 && response.status < 500)
      throw new PermanentPublishError(message, response.status);
    throw new TransientPublishError(message, response.status);
  }
  if (providerRefused && response.status === 429)
    throw new TransientPublishError(message, response.status);
  if (providerRefused && response.status >= 400 && response.status < 500)
    throw new PlatformRejectionError(message, response.status);
  throw new UnknownOutcomePublishError("WordPress post outcome is unknown", response.status);
}

/** Input remains plain text; no Markdown, user HTML, embeds or provider scheduling. */
function reviewedBody(input: PublishInput): string {
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_BODY_LENGTH)
    throw new PermanentPublishError(`WordPress text must be 1..${MAX_BODY_LENGTH} characters`);
  if (input.title !== undefined && (typeof input.title !== "string" || input.title.length > 300))
    throw new PermanentPublishError("WordPress title must be at most 300 characters");
  const content = input.text
    .replace(/\r\n?/g, "\n")
    .split(/\n(?:[\t ]*\n)+/)
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>\n")}</p>`)
    .join("\n");
  return JSON.stringify({
    status: "publish",
    ...(input.title !== undefined ? { title: escapeHtml(input.title) } : {}),
    content,
  });
}

function echoesCredential(value: string, credentials: WordPressCredentials): boolean {
  return [
    credentials.applicationPassword,
    credentials.applicationPassword.replace(/\s/g, ""),
    authorization(credentials).slice("Basic ".length),
  ].some((secret) => secret && value.includes(secret));
}

function receiptLink(value: unknown, root: URL, credentials: WordPressCredentials): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== root.origin ||
      url.username ||
      url.password ||
      url.hash
    )
      return null;
    const decoded = decodeURIComponent(url.href);
    if (echoesCredential(url.href, credentials) || echoesCredential(decoded, credentials))
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export const wordpressPublisher: Publisher<WordPressCredentials> = {
  platform: "wordpress",
  // Pubrick's current text-product bound, not a claim about WordPress's database capacity.
  maxTextLength: MAX_BODY_LENGTH,
  credentialsSchema,
  credentialTarget(credentials) {
    return siteRoot(checkedCredentials(credentials)).href;
  },

  async verify(rawCredentials, options): Promise<VerifyResult> {
    try {
      const credentials = checkedCredentials(rawCredentials);
      const root = siteRoot(credentials, options);
      const { raw } = await request(
        root,
        "wp-json/wp/v2/users/me?context=edit",
        credentials,
        "verify",
        undefined,
        options,
      );
      const user = userSchema.safeParse(raw);
      if (!user.success || echoesCredential(user.data.username, credentials))
        return {
          ok: false,
          reason: "WordPress did not return usable account permissions",
          indeterminate: true,
        };
      if (user.data.capabilities.publish_posts !== true)
        return { ok: false, reason: "WordPress account does not have publish_posts permission" };
      return { ok: true, account: user.data.username, target: root.href };
    } catch (error) {
      if (error instanceof PermanentPublishError) return { ok: false, reason: error.message };
      if (error instanceof TransientPublishError || error instanceof UnknownOutcomePublishError)
        return { ok: false, reason: error.message, indeterminate: true };
      throw error;
    }
  },

  async publish(rawCredentials, input, options): Promise<PublishResult> {
    if (input.image || input.video)
      throw new PermanentPublishError(
        "WordPress media publishing is unavailable; remove the attached image or video",
      );
    const credentials = checkedCredentials(rawCredentials);
    const root = siteRoot(credentials, options);
    const body = reviewedBody(input);
    const { raw, status } = await request(
      root,
      "wp-json/wp/v2/posts",
      credentials,
      "publish",
      body,
      options,
    );
    const record = receiptSchema.safeParse(raw);
    if (!record.success)
      throw new UnknownOutcomePublishError(
        "WordPress did not return a usable post receipt; inspect the site before retrying",
        status,
      );
    const receipt: PublishResult = {
      externalId: String(record.data.id),
      externalUrl: receiptLink(record.data.link, root, credentials),
    };
    if (record.data.status === "publish") return receipt;
    const knownStatus = [
      "draft",
      "pending",
      "future",
      "private",
      "trash",
      "auto-draft",
      "inherit",
    ].includes(String(record.data.status))
      ? ` (status: ${String(record.data.status)})`
      : "";
    throw new AcceptedPublicationError(
      `WordPress accepted the post but did not confirm publication${knownStatus}; inspect the site before retrying`,
      receipt,
      status,
    );
  },
};
