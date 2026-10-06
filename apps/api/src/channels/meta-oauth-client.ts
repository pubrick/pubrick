import {
  META_CONNECTION_PROVIDERS,
  META_GRAPH_API_VERSION,
  type MetaApplicationCredentials,
  type MetaConnectionProvider,
  metaApplicationCredentialsSchema,
  metaEnvironmentSchema,
} from "@pubrick/shared";
import { guardedFetch, readBodyAsText } from "guarded-fetch";
import * as oauth from "oauth4webapi";
import { z } from "zod";

export const META_OAUTH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 256_000;
const tokenValue = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const accountId = z.string().regex(/^[1-9]\d{0,30}$/);
const rawExpiry = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const graphRefusal = z.object({
  error: z.object({ code: z.number().int(), is_transient: z.boolean().optional() }),
});
const graphRefusalCodes = new Set([10, 100, 190, 200, 368]);
const instagramCodeResponse = z.object({
  data: z
    .array(
      z.object({
        access_token: tokenValue,
        user_id: accountId,
        permissions: z.string().min(1).max(2048),
      }),
    )
    .length(1),
});

export interface MetaOAuthCodeResult {
  /** Internal only: neither this token nor callback parameters may reach a browser response. */
  accessToken: string;
  /** Actual exchange metadata, never a copy of the requested permissions. */
  scopes: string;
  /** Instagram's app-scoped code-exchange subject; professional account is discovered separately. */
  subject?: string;
  expiresAt?: string;
}
export type MetaOAuthFailure = "configuration" | "callback" | "provider" | "unavailable";
const messages: Record<MetaOAuthFailure, string> = {
  configuration: "Meta authorization requires a configured server application and HTTPS callback",
  callback: "Meta authorization did not match the connection request; start again",
  provider: "Meta did not complete authorization with this application; start again",
  unavailable: "Meta authorization could not be checked; start a new connection request",
};
export class MetaOAuthClientError extends Error {
  constructor(readonly kind: MetaOAuthFailure) {
    // A provider response, URL, cause or error description can contain a token or application secret.
    super(messages[kind]);
  }
}

function canonicalCallback(value: string): string {
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
      throw new Error("invalid callback");
    return value;
  } catch {
    throw new MetaOAuthClientError("configuration");
  }
}

/** Provider-specific wire contracts behind the maintained OAuth callback/token validator. */
export class MetaOAuthClient {
  private readonly server: oauth.AuthorizationServer;
  private readonly client: oauth.Client;
  private readonly application: MetaApplicationCredentials;
  private readonly requestedScopes: string;

  constructor(
    private readonly provider: MetaConnectionProvider,
    application: MetaApplicationCredentials,
    graphVersion = META_GRAPH_API_VERSION,
  ) {
    const parsed = metaApplicationCredentialsSchema.safeParse(application);
    const version = metaEnvironmentSchema.shape.META_GRAPH_API_VERSION.safeParse(graphVersion);
    if (
      !parsed.success ||
      !version.success ||
      !z.enum(META_CONNECTION_PROVIDERS).safeParse(provider).success
    )
      throw new MetaOAuthClientError("configuration");
    this.application = parsed.data;
    this.client = { client_id: parsed.data.clientId };
    if (provider === "threads") {
      this.server = {
        issuer: "https://www.threads.com",
        authorization_endpoint: "https://www.threads.com/oauth/authorize",
        token_endpoint: "https://graph.threads.com/oauth/access_token",
      };
      this.requestedScopes = "threads_basic,threads_content_publish";
    } else if (provider === "instagram_native") {
      this.server = {
        issuer: "https://www.instagram.com",
        authorization_endpoint: "https://www.instagram.com/oauth/authorize",
        token_endpoint: "https://api.instagram.com/oauth/access_token",
      };
      this.requestedScopes = "instagram_business_basic,instagram_business_content_publish";
    } else {
      this.server = {
        issuer: "https://www.facebook.com",
        authorization_endpoint: `https://www.facebook.com/${version.data}/dialog/oauth`,
        token_endpoint: `https://graph.facebook.com/${version.data}/oauth/access_token`,
      };
      this.requestedScopes = "pages_manage_posts,pages_read_engagement,pages_show_list";
    }
  }

  begin(redirectUri: string): { state: string; authorizationUrl: string } {
    const state = oauth.generateRandomState();
    const url = new URL(this.server.authorization_endpoint as string);
    url.search = new URLSearchParams({
      client_id: this.application.clientId,
      redirect_uri: canonicalCallback(redirectUri),
      response_type: "code",
      scope: this.requestedScopes,
      state,
    }).toString();
    return { state, authorizationUrl: url.href };
  }

  async exchange(input: {
    parameters: URLSearchParams;
    expectedState: string;
    redirectUri: string;
  }): Promise<MetaOAuthCodeResult> {
    const redirectUri = canonicalCallback(input.redirectUri);
    let parameters: URLSearchParams;
    try {
      if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.expectedState)) throw new Error("invalid state");
      parameters = oauth.validateAuthResponse(
        this.server,
        this.client,
        input.parameters,
        input.expectedState,
      );
    } catch {
      throw new MetaOAuthClientError("callback");
    }
    let instagramSubject: string | undefined;
    const requestedAt = Date.now();
    const boundedFetch: typeof fetch = async (inputUrl, init) => {
      const endpoint = String(inputUrl instanceof Request ? inputUrl.url : inputUrl);
      if (endpoint !== this.server.token_endpoint) throw new MetaOAuthClientError("configuration");
      let url = endpoint;
      let options = init;
      if (this.provider === "facebook_page") {
        // Facebook documents GET for the confidential code exchange. The library owns
        // callback/code validation; this small adapter changes only the documented wire method.
        if (!(init?.body instanceof URLSearchParams) && typeof init?.body !== "string")
          throw new MetaOAuthClientError("configuration");
        const fields = new URLSearchParams(init.body);
        fields.delete("grant_type");
        const target = new URL(endpoint);
        target.search = fields.toString();
        url = target.href;
        options = { ...init, method: "GET", body: undefined };
      }
      const deadlineAt = requestedAt + META_OAUTH_TIMEOUT_MS;
      try {
        if (Date.now() >= deadlineAt) throw new MetaOAuthClientError("unavailable");
        const response = await guardedFetch(url, {
          ...options,
          signal: options?.signal ?? undefined,
          httpsOnly: true,
          allowedHosts: [new URL(endpoint).hostname],
          followRedirects: false,
          timeoutMs: deadlineAt - Date.now(),
          opaqueErrors: true,
        });
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          throw new MetaOAuthClientError("unavailable");
        }
        let text = await readBodyAsText(response, {
          maxResponseBytes: MAX_RESPONSE_BYTES,
          deadlineAt,
          opaqueErrors: true,
        });
        if ([400, 401, 403].includes(response.status)) {
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            // An unparseable intermediary response proves no specific provider refusal.
          }
          const refusal = graphRefusal.safeParse(body);
          if (
            refusal.success &&
            refusal.data.error.is_transient !== true &&
            graphRefusalCodes.has(refusal.data.error.code)
          )
            throw new MetaOAuthClientError("provider");
        }
        if (response.ok) {
          const body: unknown = JSON.parse(text);
          // oauth4webapi tolerates numeric strings via parseFloat; provider-issued
          // lifecycle evidence must be an actual positive integer before that coercion.
          if (
            body &&
            typeof body === "object" &&
            Object.hasOwn(body, "expires_in") &&
            !rawExpiry.safeParse((body as Record<string, unknown>).expires_in).success
          )
            throw new MetaOAuthClientError("unavailable");
          if (this.provider === "instagram_native") {
            // Instagram documents one data[] result, comma-separated grants and bearer
            // API auth. No invented OIDC token, native debug_token or expiry is added.
            const result = instagramCodeResponse.parse(body).data[0];
            if (!result) throw new MetaOAuthClientError("unavailable");
            instagramSubject = result.user_id;
            text = JSON.stringify({
              access_token: result.access_token,
              token_type: "Bearer",
              scope: result.permissions
                .split(",")
                .map((value) => value.trim())
                .join(" "),
            });
          } else if (
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            !Object.hasOwn(body, "token_type")
          ) {
            text = JSON.stringify({ ...body, token_type: "Bearer" });
          }
        }
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        return new Response(response.status === 204 || response.status === 205 ? null : text, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } catch (error) {
        if (error instanceof MetaOAuthClientError) throw error;
        throw new MetaOAuthClientError("unavailable");
      }
    };
    try {
      let response: Response;
      try {
        // The maintained library checks code cardinality before the transport can run.
        response = await oauth.authorizationCodeGrantRequest(
          this.server,
          this.client,
          oauth.ClientSecretPost(this.application.clientSecret),
          parameters,
          redirectUri,
          oauth.nopkce,
          { [oauth.customFetch]: boundedFetch },
        );
      } catch (error) {
        if (error instanceof MetaOAuthClientError) throw error;
        throw new MetaOAuthClientError("callback");
      }
      const result = await oauth.processAuthorizationCodeResponse(
        this.server,
        this.client,
        response,
      );
      const accessToken = tokenValue.parse(result.access_token);
      if (result.token_type !== "bearer" || (result.scope?.length ?? 0) > 2048)
        throw new MetaOAuthClientError("unavailable");
      let expiresAt: string | undefined;
      if (result.expires_in !== undefined) {
        if (
          !Number.isSafeInteger(result.expires_in) ||
          result.expires_in <= 0 ||
          !Number.isSafeInteger(requestedAt + result.expires_in * 1000)
        )
          throw new MetaOAuthClientError("unavailable");
        expiresAt = new Date(requestedAt + result.expires_in * 1000).toISOString();
        if (Date.parse(expiresAt) <= Date.now()) throw new MetaOAuthClientError("unavailable");
      }
      return {
        accessToken,
        scopes: result.scope ?? "",
        ...(instagramSubject ? { subject: instagramSubject } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      };
    } catch (error) {
      if (error instanceof MetaOAuthClientError) throw error;
      if (
        error instanceof oauth.ResponseBodyError ||
        error instanceof oauth.WWWAuthenticateChallengeError
      )
        throw new MetaOAuthClientError("provider");
      throw new MetaOAuthClientError("unavailable");
    }
  }
}
