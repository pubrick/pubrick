import { guardedFetch, readBodyAsText } from "guarded-fetch";
import * as oauth from "oauth4webapi";
import { z } from "zod";

export const LINKEDIN_OAUTH_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256_000;
const AUTHORIZATION_ENDPOINT = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_ENDPOINT = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_ENDPOINT = "https://api.linkedin.com/v2/userinfo";
const REQUESTED_SCOPES = "openid profile w_member_social";
const server: oauth.AuthorizationServer = {
  issuer: "https://www.linkedin.com",
  authorization_endpoint: AUTHORIZATION_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
  userinfo_endpoint: USERINFO_ENDPOINT,
  id_token_signing_alg_values_supported: ["RS256"],
};
const configurationSchema = z.strictObject({
  clientId: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[\x21-\x7e]+$/),
  clientSecret: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => value.trim().length > 0),
});
export type LinkedInOAuthConfiguration = z.infer<typeof configurationSchema>;
export interface LinkedInOAuthClientOptions {
  /** An injected transport still runs behind guarded-fetch; endpoints cannot be overridden. */
  fetchImpl?: typeof fetch;
}
export interface LinkedInOAuthAuthorization {
  authorizationUrl: string;
  /** Persist once with the organization, brand, acting user, destination and expiry before redirecting. */
  state: string;
  /** Persist beside state; the returned ID token must echo this independent OIDC nonce. */
  nonce: string;
}
export interface LinkedInOAuthExchange {
  expectedState: string;
  expectedNonce: string;
  /** Preserve all callback parameters, including duplicates, for the library's protocol validation. */
  parameters: URLSearchParams;
  /** The exact server-configured HTTPS callback used by begin(). */
  redirectUri: string;
}
export interface LinkedInOAuthCredentials extends Record<string, string> {
  accessToken: string;
  authorUrn: string;
  scopes: string;
  expiresAt: string;
}
export interface LinkedInOAuthConnection {
  /** Internal server result: encrypt the whole bag; never return it to a browser. */
  credentials: LinkedInOAuthCredentials;
  account: string;
}
type FailureKind = "configuration" | "callback" | "provider" | "unavailable";
const FAILURE_MESSAGES: Record<FailureKind, string> = {
  configuration:
    "LinkedIn OAuth needs a configured server application and a canonical HTTPS callback",
  callback: "LinkedIn authorization did not match the connection request; start again",
  provider:
    "LinkedIn could not complete authorization with this application; reconnect the account",
  unavailable: "LinkedIn authorization could not be verified; start a new connection request",
};
export class LinkedInOAuthClientError extends Error {
  constructor(readonly kind: FailureKind) {
    // Do not retain an OAuth error, response, parameters or cause: they can contain secrets.
    super(FAILURE_MESSAGES[kind]);
  }
}

export function validateLinkedInOAuthConfiguration(value: unknown): LinkedInOAuthConfiguration {
  const parsed = configurationSchema.safeParse(value);
  if (!parsed.success) throw new LinkedInOAuthClientError("configuration");
  return parsed.data;
}

function callbackUri(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== value
    )
      throw new Error("noncanonical callback");
    return value;
  } catch {
    throw new LinkedInOAuthClientError("configuration");
  }
}

function stateValue(value: string): string {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw new LinkedInOAuthClientError("callback");
  return value;
}

/** LinkedIn's documented response can omit token_type, but its APIs explicitly use Bearer. */
function normalizeLinkedInTokenResponse(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      !Object.hasOwn(body, "token_type")
    )
      return JSON.stringify({ ...body, token_type: "Bearer" });
  } catch {
    // The maintained OAuth response validator rejects malformed JSON below.
  }
  return text;
}

function expiration(requestedAt: number, seconds: unknown): string {
  if (
    typeof seconds !== "number" ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    !Number.isSafeInteger(requestedAt + seconds * 1000)
  )
    throw new LinkedInOAuthClientError("unavailable");
  const date = new Date(requestedAt + seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw new LinkedInOAuthClientError("unavailable");
  return date.toISOString();
}

const tokenValue = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const memberSchema = z.object({
  sub: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  name: z.string().min(1).max(300).optional(),
});

/**
 * Confidential web flow. LinkedIn documents PKCE only for separately enabled native
 * loopback apps at /oauth/native-pkce/authorization, not this server callback flow.
 * The caller owns the durable, expiring, one-use state and destination binding.
 */
export class LinkedInOAuthClient {
  private readonly configuration: LinkedInOAuthConfiguration;
  private readonly client: oauth.Client;

  constructor(
    configuration: LinkedInOAuthConfiguration,
    private readonly options: LinkedInOAuthClientOptions = {},
  ) {
    this.configuration = validateLinkedInOAuthConfiguration(configuration);
    this.client = { client_id: this.configuration.clientId };
  }

  begin(redirectUri: string): LinkedInOAuthAuthorization {
    const state = oauth.generateRandomState();
    const nonce = oauth.generateRandomNonce();
    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.configuration.clientId,
      redirect_uri: callbackUri(redirectUri),
      scope: REQUESTED_SCOPES,
      state,
      nonce,
    }).toString();
    return { authorizationUrl: url.href, state, nonce };
  }

  private readonly boundedFetch: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== TOKEN_ENDPOINT && url !== USERINFO_ENDPOINT)
      throw new LinkedInOAuthClientError("configuration");
    const deadlineAt = Date.now() + LINKEDIN_OAUTH_REQUEST_TIMEOUT_MS;
    let response: Response;
    let text: string;
    try {
      response = await guardedFetch(url, {
        ...init,
        signal: init?.signal ?? undefined,
        httpsOnly: true,
        allowedHosts: [new URL(url).hostname],
        followRedirects: false,
        timeoutMs: LINKEDIN_OAUTH_REQUEST_TIMEOUT_MS,
        opaqueErrors: true,
        ...(this.options.fetchImpl ? { fetch: this.options.fetchImpl } : {}),
      });
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw new LinkedInOAuthClientError("unavailable");
      }
      text = await readBodyAsText(response, {
        maxResponseBytes: MAX_RESPONSE_BYTES,
        deadlineAt,
        opaqueErrors: true,
      });
    } catch {
      throw new LinkedInOAuthClientError("unavailable");
    }
    // Buffer once under the transport budget; the library parses this bounded body.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(
      response.status === 204 || response.status === 205
        ? null
        : url === TOKEN_ENDPOINT && response.status === 200
          ? normalizeLinkedInTokenResponse(text)
          : text,
      { status: response.status, statusText: response.statusText, headers },
    );
  };

  async exchange(input: LinkedInOAuthExchange): Promise<LinkedInOAuthConnection> {
    const redirectUri = callbackUri(input.redirectUri);
    let parameters: URLSearchParams;
    try {
      stateValue(input.expectedNonce);
      parameters = oauth.validateAuthResponse(
        server,
        this.client,
        input.parameters,
        stateValue(input.expectedState),
      );
    } catch {
      throw new LinkedInOAuthClientError("callback");
    }
    const requestedAt = Date.now();
    try {
      let response: Response;
      try {
        // The library checks code cardinality/presence here before invoking the transport.
        response = await oauth.authorizationCodeGrantRequest(
          server,
          this.client,
          oauth.ClientSecretPost(this.configuration.clientSecret),
          parameters,
          redirectUri,
          oauth.nopkce,
          { [oauth.customFetch]: this.boundedFetch },
        );
      } catch (error) {
        if (error instanceof LinkedInOAuthClientError) throw error;
        throw new LinkedInOAuthClientError("callback");
      }
      // OIDC code-flow tokens arrive directly from the fixed TLS token endpoint. The
      // library validates claims and nonce; issuer authentication relies on TLS,
      // not a separate application-level JWT signature check (OIDC Core 3.1.3.7).
      const tokens = await oauth.processAuthorizationCodeResponse(server, this.client, response, {
        requireIdToken: true,
        expectedNonce: input.expectedNonce,
      });
      if (tokens.token_type !== "bearer") throw new LinkedInOAuthClientError("unavailable");
      const claims = oauth.getValidatedIdTokenClaims(tokens);
      if (!claims) throw new LinkedInOAuthClientError("unavailable");
      const parsedToken = tokenValue.safeParse(tokens.access_token);
      if (!parsedToken.success) throw new LinkedInOAuthClientError("unavailable");
      if (tokens.scope !== undefined && tokens.scope.length > 2048)
        throw new LinkedInOAuthClientError("unavailable");
      const expiresAt = expiration(requestedAt, tokens.expires_in);
      const credentials: LinkedInOAuthCredentials = {
        accessToken: parsedToken.data,
        authorUrn: "",
        // Never infer grants from the requested scopes; missing metadata is explicitly empty.
        scopes: tokens.scope ?? "",
        expiresAt,
      };
      if (tokens.refresh_token !== undefined) {
        const refreshToken = tokenValue.safeParse(tokens.refresh_token);
        if (!refreshToken.success) throw new LinkedInOAuthClientError("unavailable");
        credentials.refreshToken = refreshToken.data;
        if (tokens.refresh_token_expires_in !== undefined)
          credentials.refreshExpiresAt = expiration(requestedAt, tokens.refresh_token_expires_in);
      }
      const identityResponse = await oauth.userInfoRequest(
        server,
        this.client,
        credentials.accessToken,
        {
          [oauth.customFetch]: this.boundedFetch,
        },
      );
      const identity = await oauth.processUserInfoResponse(
        server,
        this.client,
        claims.sub,
        identityResponse,
      );
      const member = memberSchema.safeParse(identity);
      if (!member.success) throw new LinkedInOAuthClientError("unavailable");
      const secrets = [
        credentials.accessToken,
        credentials.refreshToken,
        this.configuration.clientSecret,
        parameters.get("code"),
        input.expectedState,
        input.expectedNonce,
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
      if (
        secrets.some(
          (secret) => member.data.sub.includes(secret) || credentials.scopes.includes(secret),
        )
      )
        throw new LinkedInOAuthClientError("unavailable");
      if (Date.parse(expiresAt) <= Date.now()) throw new LinkedInOAuthClientError("unavailable");
      credentials.authorUrn = `urn:li:person:${member.data.sub}`;
      return {
        credentials,
        account:
          member.data.name && !secrets.some((secret) => member.data.name?.includes(secret))
            ? member.data.name
            : credentials.authorUrn,
      };
    } catch (error) {
      if (error instanceof LinkedInOAuthClientError) throw error;
      if (
        error instanceof oauth.ResponseBodyError ||
        error instanceof oauth.WWWAuthenticateChallengeError
      )
        throw new LinkedInOAuthClientError("provider");
      throw new LinkedInOAuthClientError("unavailable");
    }
  }
}
