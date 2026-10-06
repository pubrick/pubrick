import {
  GuardedFetchErrorCode,
  guardedFetch,
  isGuardedFetchError,
  readBodyAsJson,
  readBodyAsText,
} from "guarded-fetch";
import { z } from "zod";
import {
  AcceptedPublicationError,
  PermanentPublishError,
  PlatformRejectionError,
  type Publisher,
  type PublisherOptions,
  type PublishResult,
  TransientPublishError,
  UnknownOutcomePublishError,
  type VerifyResult,
} from "./types.js";

export const LINKEDIN_REQUEST_TIMEOUT_MS = 30_000;
export const LINKEDIN_API_VERSION = "202609";
const MAX_RESPONSE_BYTES = 256_000;
const MAX_TEXT_LENGTH = 3000;
const API_ORIGIN = "https://api.linkedin.com";
const INTROSPECT_URL = "https://www.linkedin.com/oauth/v2/introspectToken";
const USERINFO_URL = `${API_ORIGIN}/v2/userinfo`;
const POSTS_URL = `${API_ORIGIN}/rest/posts`;
const PERSON_URN = /^urn:li:person:[A-Za-z0-9_-]{1,200}$/;
const POST_URN = /^urn:li:(?:share|ugcPost):[1-9]\d{0,30}$/;
const credentialsSchema = z.object({
  accessToken: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x21-\x7e]+$/),
  authorUrn: z.string().regex(PERSON_URN),
  // OAuth lifecycle metadata remains scalar in the encrypted credential bag.
  // Neither field is proof of a current grant: only the provider's inspector is.
  scopes: z.string().max(2048).optional(),
  expiresAt: z.string().max(100).optional(),
});
type LinkedInCredentials = z.infer<typeof credentialsSchema>;
const applicationSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => value.trim().length > 0),
});
type LinkedInApplication = z.infer<typeof applicationSchema>;
const introspectionSchema = z.object({
  active: z.boolean(),
  client_id: z.string().min(1).optional(),
  status: z.enum(["active", "revoked", "expired"]).optional(),
  auth_type: z.enum(["3L", "2L", "Enterprise_User"]).optional(),
  expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  scope: z.string().optional(),
});
const identitySchema = z.object({
  sub: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  name: z.string().min(1).max(300).optional(),
});
const rejectionSchema = z.object({
  status: z.number().int().min(400).max(599),
  serviceErrorCode: z.number().int(),
  message: z.string().min(1),
});
type Phase = "preflight" | "publish";
type Proof = { expiresAt: number; account: string };

function credentialsAndApplication(
  credentials: LinkedInCredentials,
  options?: PublisherOptions,
): { credentials: LinkedInCredentials; application: LinkedInApplication } {
  if (
    typeof credentials.authorUrn === "string" &&
    credentials.authorUrn.startsWith("urn:li:organization:")
  )
    throw new PermanentPublishError("LinkedIn organization publishing is not available yet");
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success)
    throw new PermanentPublishError("LinkedIn needs an access token and a personal author URN");
  const application = applicationSchema.safeParse(options?.linkedin);
  if (!application.success)
    throw new PermanentPublishError(
      "LinkedIn verification requires the server application's client ID and secret",
    );
  if (options?.baseUrl && options.baseUrl !== API_ORIGIN && options.baseUrl !== `${API_ORIGIN}/`)
    throw new PermanentPublishError("LinkedIn API requests must use the official endpoint");
  return { credentials: parsed.data, application: application.data };
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
    const code = String((current as { code?: unknown }).code ?? "");
    if (current instanceof AggregateError) return false;
    if (CONNECT_PHASE_CODES.has(code)) return true;
    // Do not let an earlier connection refusal override a current timeout/socket loss.
    if (code && code !== GuardedFetchErrorCode.NETWORK_ERROR) return false;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function request(
  url: string,
  phase: Phase,
  headers: Record<string, string>,
  body: string | URLSearchParams | undefined,
  options?: PublisherOptions,
): Promise<{ response: Response; deadlineAt: number }> {
  const deadlineAt = Date.now() + LINKEDIN_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await guardedFetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { Accept: "application/json", ...headers },
      body,
      httpsOnly: true,
      allowedHosts: [new URL(url).hostname],
      followRedirects: false,
      timeoutMs: LINKEDIN_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
      ...(options?.fetchImpl ? { fetch: options.fetchImpl } : {}),
    });
  } catch (error) {
    if (isGuardedFetchError(error) && BEFORE_SEND_CODES.has(error.code))
      throw new PermanentPublishError(
        "LinkedIn could not be reached through a safe public endpoint",
      );
    if (phase === "preflight" || connectFailed(error))
      throw new TransientPublishError(
        "LinkedIn verification or connection did not complete before publishing",
      );
    throw new UnknownOutcomePublishError("LinkedIn post outcome is unknown");
  }
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => undefined);
    if (phase === "preflight")
      throw new TransientPublishError(
        "LinkedIn redirected verification; publishing was not attempted",
        response.status,
      );
    throw new UnknownOutcomePublishError(
      "LinkedIn redirected the create request; inspect the destination before retrying",
      response.status,
    );
  }
  return { response, deadlineAt };
}

async function verificationBody(response: Response, deadlineAt: number): Promise<unknown> {
  if (!response.ok) {
    // No create request has been attempted. A failed read cannot turn a verifier into delivery.
    void response.body?.cancel().catch(() => undefined);
    if (response.status >= 400 && response.status < 500 && response.status !== 429)
      throw new PermanentPublishError(
        `LinkedIn could not verify the token with this application (HTTP ${response.status})`,
        response.status,
      );
    throw new TransientPublishError(
      `LinkedIn verification is temporarily unavailable (HTTP ${response.status})`,
      response.status,
    );
  }
  try {
    return await readBodyAsJson(response, {
      maxResponseBytes: MAX_RESPONSE_BYTES,
      deadlineAt,
      opaqueErrors: true,
    });
  } catch {
    throw new TransientPublishError(
      "LinkedIn returned unusable verification data",
      response.status,
    );
  }
}

function echoesSecret(
  value: string,
  credentials: LinkedInCredentials,
  application: LinkedInApplication,
): boolean {
  return value.includes(credentials.accessToken) || value.includes(application.clientSecret);
}

async function publishingProof(
  credentials: LinkedInCredentials,
  application: LinkedInApplication,
  options?: PublisherOptions,
): Promise<Proof> {
  // LinkedIn's proprietary comma scopes/expires_at/auth_type are not RFC7662's exp fields.
  // Validate provider semantics here; OAuth state/code exchange belongs to the server's OAuth library.
  const inspected = await request(
    INTROSPECT_URL,
    "preflight",
    { "Content-Type": "application/x-www-form-urlencoded" },
    new URLSearchParams({
      client_id: application.clientId,
      client_secret: application.clientSecret,
      token: credentials.accessToken,
    }),
    options,
  );
  const token = introspectionSchema.safeParse(
    await verificationBody(inspected.response, inspected.deadlineAt),
  );
  if (!token.success)
    throw new TransientPublishError("LinkedIn did not provide usable token permissions");
  if (!token.data.active || token.data.status === "expired" || token.data.status === "revoked")
    throw new PermanentPublishError(
      "LinkedIn access token is inactive, expired, or belongs to another application",
    );
  if (token.data.client_id !== undefined && token.data.client_id !== application.clientId)
    throw new PermanentPublishError("LinkedIn token belongs to another application");
  if (token.data.auth_type !== undefined && token.data.auth_type !== "3L")
    throw new PermanentPublishError("LinkedIn personal publishing requires a member OAuth token");
  if (
    token.data.client_id === undefined ||
    token.data.auth_type === undefined ||
    token.data.expires_at === undefined ||
    token.data.scope === undefined
  )
    throw new TransientPublishError(
      "LinkedIn did not confirm the application's member publishing grant and expiry",
    );
  if (token.data.expires_at <= Date.now() / 1000)
    throw new PermanentPublishError("LinkedIn access token has expired; reconnect the account");
  const scopes = new Set(
    token.data.scope
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  if (!scopes.has("w_member_social"))
    throw new PermanentPublishError(
      "LinkedIn token does not grant w_member_social publishing permission",
    );
  if (!scopes.has("openid") || !scopes.has("profile"))
    throw new PermanentPublishError(
      "LinkedIn needs openid and profile permissions to confirm the personal author",
    );
  const identified = await request(
    USERINFO_URL,
    "preflight",
    { Authorization: `Bearer ${credentials.accessToken}` },
    undefined,
    options,
  );
  const identity = identitySchema.safeParse(
    await verificationBody(identified.response, identified.deadlineAt),
  );
  if (!identity.success)
    throw new TransientPublishError("LinkedIn did not provide usable member identity data");
  if (`urn:li:person:${identity.data.sub}` !== credentials.authorUrn)
    throw new PermanentPublishError(
      "LinkedIn token does not belong to the connected personal author",
    );
  if (token.data.expires_at <= Date.now() / 1000)
    throw new PermanentPublishError(
      "LinkedIn access token expired during verification; reconnect the account",
    );
  return {
    expiresAt: token.data.expires_at,
    account:
      identity.data.name && !echoesSecret(identity.data.name, credentials, application)
        ? identity.data.name
        : credentials.authorUrn,
  };
}

/** Escape the provider's documented little-text reserved alphabet once before JSON serialization. */
function plainCommentary(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (character) => `\\${character}`);
}

function postReceipt(
  response: Response,
  credentials: LinkedInCredentials,
  application: LinkedInApplication,
): PublishResult | null {
  const id = response.headers.get("x-restli-id");
  if (!id || !POST_URN.test(id) || echoesSecret(id, credentials, application)) return null;
  return { externalId: id, externalUrl: `https://www.linkedin.com/feed/update/${id}/` };
}

async function publicationResult(
  response: Response,
  deadlineAt: number,
  credentials: LinkedInCredentials,
  application: LinkedInApplication,
): Promise<PublishResult> {
  if (response.ok) {
    const receipt = postReceipt(response, credentials, application);
    if (!receipt) {
      void response.body?.cancel().catch(() => undefined);
      throw new UnknownOutcomePublishError(
        "LinkedIn did not return a usable x-restli-id receipt; inspect the destination before retrying",
        response.status,
      );
    }
    if (response.status !== 201) {
      void response.body?.cancel().catch(() => undefined);
      throw new AcceptedPublicationError(
        "LinkedIn accepted a post without confirming creation; inspect the destination before retrying",
        receipt,
        response.status,
      );
    }
    let body: string;
    try {
      body = await readBodyAsText(response, {
        maxResponseBytes: MAX_RESPONSE_BYTES,
        deadlineAt,
        opaqueErrors: true,
      });
    } catch {
      throw new AcceptedPublicationError(
        "LinkedIn returned a post ID but publication could not be confirmed; inspect the destination before retrying",
        receipt,
        response.status,
      );
    }
    // Empty bodies with a 201 and x-restli-id are the documented text-create receipt.
    if (!body.trim()) return receipt;
    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new AcceptedPublicationError(
        "LinkedIn returned a post ID with an unreadable publication response; inspect the destination before retrying",
        receipt,
        response.status,
      );
    }
    const reported = z.object({ lifecycleState: z.string() }).safeParse(raw);
    if (reported.success && reported.data.lifecycleState === "PUBLISHED") return receipt;
    const state =
      reported.success &&
      ["DRAFT", "PUBLISH_REQUESTED", "PUBLISH_FAILED"].includes(reported.data.lifecycleState)
        ? ` (${reported.data.lifecycleState})`
        : "";
    throw new AcceptedPublicationError(
      `LinkedIn accepted the post but did not confirm publication${state}; inspect the destination before retrying`,
      receipt,
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
    throw new UnknownOutcomePublishError(
      "LinkedIn returned an unreadable create response",
      response.status,
    );
  }
  const refusal = rejectionSchema.safeParse(raw);
  const providerRefused = refusal.success && refusal.data.status === response.status;
  // Never return a provider message: it may echo access tokens or application secrets.
  const message = `LinkedIn refused the create request (HTTP ${response.status})`;
  if (providerRefused && response.status === 429)
    throw new TransientPublishError(message, response.status);
  if (providerRefused && response.status >= 400 && response.status < 500)
    throw new PlatformRejectionError(message, response.status);
  throw new UnknownOutcomePublishError("LinkedIn post outcome is unknown", response.status);
}

export const linkedinPublisher: Publisher<LinkedInCredentials> = {
  platform: "linkedin",
  maxTextLength: MAX_TEXT_LENGTH,
  credentialsSchema,
  credentialTarget: (credentials) => credentials.authorUrn,

  async verify(rawCredentials, options): Promise<VerifyResult> {
    try {
      const { credentials, application } = credentialsAndApplication(rawCredentials, options);
      const proof = await publishingProof(credentials, application, options);
      return { ok: true, account: proof.account, target: credentials.authorUrn };
    } catch (error) {
      if (error instanceof PermanentPublishError) return { ok: false, reason: error.message };
      if (error instanceof TransientPublishError)
        return { ok: false, reason: error.message, indeterminate: true };
      throw error;
    }
  },

  async publish(rawCredentials, input, options): Promise<PublishResult> {
    if (input.image || input.video)
      throw new PermanentPublishError(
        "LinkedIn media publishing is unavailable; remove the attached image or video",
      );
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_TEXT_LENGTH)
      throw new PermanentPublishError(`LinkedIn text must be 1..${MAX_TEXT_LENGTH} characters`);
    const { credentials, application } = credentialsAndApplication(rawCredentials, options);
    const proof = await publishingProof(credentials, application, options);
    if (proof.expiresAt <= Date.now() / 1000)
      throw new PermanentPublishError("LinkedIn access token has expired; reconnect the account");
    await options?.beforeLinkedInCreate?.();
    if (proof.expiresAt <= Date.now() / 1000)
      throw new PermanentPublishError("LinkedIn access token has expired; reconnect the account");
    const created = await request(
      POSTS_URL,
      "publish",
      {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      JSON.stringify({
        author: credentials.authorUrn,
        commentary: plainCommentary(input.text),
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
      options,
    );
    return publicationResult(created.response, created.deadlineAt, credentials, application);
  },
};
