import { metaRequest, PlatformRejectionError } from "@pubrick/integrations";
import {
  META_MAX_DISCOVERED_PAGES,
  META_GRAPH_API_VERSION,
  type MetaApplicationCredentials,
  type MetaConnectionProvider,
  metaApplicationCredentialsSchema,
} from "@pubrick/shared";
import { z } from "zod";
import {
  MetaOAuthClient,
  MetaOAuthClientError,
  type MetaOAuthCodeResult,
} from "./meta-oauth-client";

const VERSION = META_GRAPH_API_VERSION;
const accountId = z.string().regex(/^[1-9]\d{0,30}$/);
const token = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
const name = z.string().trim().min(1).max(300);
const scopes = z.array(z.string().min(1).max(200)).max(100);
const unixTime = z.number().int().nonnegative().max(8_640_000_000_000);
const extendedTokenSchema = z.object({
  access_token: token,
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const userDebugSchema = z.object({
  data: z.object({
    type: z.enum(["USER", "APP"]),
    is_valid: z.boolean(),
    user_id: accountId,
    scopes,
    expires_at: unixTime,
    data_access_expires_at: unixTime.optional(),
  }),
});
const facebookDebugSchema = z.object({
  data: userDebugSchema.shape.data.extend({ app_id: accountId }),
});
const facebookScopes = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"] as const;
const instagramScopes = ["instagram_business_basic", "instagram_business_content_publish"] as const;
const threadsScopes = ["threads_basic", "threads_content_publish"] as const;
const facebookPermissionsSchema = z.object({
  data: z
    .array(
      z.object({
        permission: z.string().min(1).max(200),
        status: z.enum(["granted", "declined", "expired"]),
      }),
    )
    .max(100),
  // Permission sets must be complete; an unexpected page is not an inferred grant.
  paging: z.object({ next: z.string().optional() }).optional(),
});
const pageSchema = z.object({
  id: accountId,
  name,
  access_token: token,
  tasks: z.array(z.string().min(1).max(100)).max(50),
});
const pagesSchema = z.object({
  data: z.array(pageSchema).max(META_MAX_DISCOVERED_PAGES),
  paging: z
    .object({
      cursors: z.object({ after: z.string().min(1).max(2048).optional() }).optional(),
      next: z.string().min(1).max(8192).optional(),
    })
    .optional(),
});
const instagramIdentitySchema = z.object({
  id: accountId,
  user_id: accountId,
  username: name,
  account_type: z.enum(["BUSINESS", "MEDIA_CREATOR"]),
});
const nativeQuotaSchema = z.object({
  data: z
    .array(
      z.object({
        quota_usage: z.number().int().nonnegative(),
        config: z.object({
          quota_total: z.number().int().positive(),
          quota_duration: z.number().int().positive(),
        }),
      }),
    )
    .length(1),
});

export interface MetaAccountConnection {
  /** Encrypt the whole bag; this result is never a browser DTO. */
  credentials: Record<string, string>;
  account: string;
  target: string;
  /** Trusted server lineage; keep outside user-editable credentials. */
  applicationId: string;
}
export interface MetaPageDiscovery {
  /** Transient encrypted state until the user explicitly chooses exactly one Page. */
  pages: MetaAccountConnection[];
}

function lifetime(startedAt: number, seconds: number): string {
  const value = startedAt + seconds * 1000;
  if (!Number.isSafeInteger(value) || value > 8_640_000_000_000_000 || value <= Date.now())
    throw new MetaOAuthClientError("unavailable");
  return new Date(value).toISOString();
}
function requireScopes(actual: readonly string[], required: readonly string[]) {
  if (required.some((scope) => !actual.includes(scope))) throw new MetaOAuthClientError("provider");
}
function requireName(value: string, secrets: readonly string[]): string {
  if (secrets.some((secret) => secret && value.includes(secret)))
    throw new MetaOAuthClientError("unavailable");
  return value;
}
function inspectExpiry(expires: number, accessExpires: number | undefined, zeroPermitted = false) {
  if ((!zeroPermitted && expires === 0) || (expires > 0 && expires <= Date.now() / 1000))
    throw new MetaOAuthClientError("provider");
  if (accessExpires !== undefined && accessExpires > 0 && accessExpires <= Date.now() / 1000)
    throw new MetaOAuthClientError("provider");
}

/** Provider identity/lifecycle contracts over Pubrick's single guarded Meta transport. */
export class MetaAccountClient {
  private readonly application: MetaApplicationCredentials;
  constructor(
    private readonly provider: MetaConnectionProvider,
    application: MetaApplicationCredentials,
  ) {
    // Reuse the OAuth foundation's strict server application validation.
    new MetaOAuthClient(provider, application);
    this.application = metaApplicationCredentialsSchema.parse(application);
  }

  private async extend(
    code: MetaOAuthCodeResult,
  ): Promise<{ accessToken: string; expiresAt: string }> {
    const startedAt = Date.now();
    const origin =
      this.provider === "threads"
        ? "https://graph.threads.com"
        : this.provider === "instagram_native"
          ? "https://graph.instagram.com"
          : "https://graph.facebook.com";
    const params =
      this.provider === "facebook_page"
        ? new URLSearchParams({
            grant_type: "fb_exchange_token",
            client_id: this.application.clientId,
            client_secret: this.application.clientSecret,
            fb_exchange_token: code.accessToken,
          })
        : new URLSearchParams({
            grant_type: this.provider === "threads" ? "th_exchange_token" : "ig_exchange_token",
            client_secret: this.application.clientSecret,
            access_token: code.accessToken,
          });
    const response = extendedTokenSchema.parse(
      await metaRequest(
        origin,
        this.provider === "facebook_page" ? `${VERSION}/oauth/access_token` : "access_token",
        code.accessToken,
        "read",
        params,
      ),
    );
    if (response.token_type !== undefined && response.token_type.toLowerCase() !== "bearer")
      throw new MetaOAuthClientError("unavailable");
    return {
      accessToken: response.access_token,
      expiresAt: lifetime(startedAt, response.expires_in),
    };
  }

  async connect(code: MetaOAuthCodeResult): Promise<MetaAccountConnection | MetaPageDiscovery> {
    try {
      token.parse(code.accessToken);
      if (this.provider === "instagram_native") {
        requireScopes(code.scopes.split(/\s+/), instagramScopes);
        accountId.parse(code.subject);
      }
      const long = await this.extend(code);
      const result =
        this.provider === "threads"
          ? await this.threads(long)
          : this.provider === "instagram_native"
            ? await this.instagram(code, long)
            : await this.facebook(long);
      const connections = "pages" in result ? result.pages : [result];
      const secrets = [
        code.accessToken,
        this.application.clientSecret,
        ...connections.flatMap((connection) => [
          connection.credentials.accessToken ?? "",
          connection.credentials.userAccessToken ?? "",
        ]),
      ];
      for (const connection of connections) {
        const expiry = Date.parse(connection.credentials.expiresAt ?? "");
        // Identity/grant/discovery reads must not turn a token that expired while
        // awaiting the provider into a connected channel or a Page-choice label.
        if (!Number.isFinite(expiry) || expiry <= Date.now())
          throw new MetaOAuthClientError("unavailable");
        requireName(connection.account, secrets);
      }
      return result;
    } catch (error) {
      if (error instanceof MetaOAuthClientError) throw error;
      if (error instanceof PlatformRejectionError) throw new MetaOAuthClientError("provider");
      // Never retain transport, parser or provider errors: their inputs can contain secrets.
      throw new MetaOAuthClientError("unavailable");
    }
  }

  private async threads(long: {
    accessToken: string;
    expiresAt: string;
  }): Promise<MetaAccountConnection> {
    const proof = userDebugSchema.parse(
      await metaRequest(
        "https://graph.threads.com",
        "debug_token",
        `TH|${this.application.clientId}|${this.application.clientSecret}`,
        "read",
        new URLSearchParams({ input_token: long.accessToken }),
      ),
    ).data;
    if (!proof.is_valid || proof.type !== "USER") throw new MetaOAuthClientError("provider");
    requireScopes(proof.scopes, threadsScopes);
    inspectExpiry(proof.expires_at, proof.data_access_expires_at);
    const identity = z
      .object({ id: accountId, username: name })
      .parse(
        await metaRequest(
          "https://graph.threads.com",
          "me",
          long.accessToken,
          "read",
          new URLSearchParams({ fields: "id,username" }),
        ),
      );
    if (identity.id !== proof.user_id) throw new MetaOAuthClientError("provider");
    return {
      account: requireName(identity.username, [long.accessToken, this.application.clientSecret]),
      target: `threads:${identity.id}`,
      applicationId: this.application.clientId,
      credentials: {
        accessToken: long.accessToken,
        accountId: identity.id,
        scopes: proof.scopes.join(" "),
        expiresAt: new Date(
          Math.min(
            Date.parse(long.expiresAt),
            proof.expires_at * 1000,
            ...(proof.data_access_expires_at ? [proof.data_access_expires_at * 1000] : []),
          ),
        ).toISOString(),
      },
    };
  }

  private async instagram(
    code: MetaOAuthCodeResult,
    long: { accessToken: string; expiresAt: string },
  ): Promise<MetaAccountConnection> {
    // These grants came from the actual native code response, never the requested scope.
    requireScopes(code.scopes.split(/\s+/), instagramScopes);
    const identity = instagramIdentitySchema.parse(
      await metaRequest(
        "https://graph.instagram.com",
        `${VERSION}/me`,
        long.accessToken,
        "read",
        new URLSearchParams({ fields: "id,user_id,username,account_type" }),
      ),
    );
    if (!code.subject || code.subject !== identity.id) throw new MetaOAuthClientError("provider");
    // The native publishing-limit reference requires both publishing grants. It
    // proves a current scoped capability; it is not an invented token inspector.
    nativeQuotaSchema.parse(
      await metaRequest(
        "https://graph.instagram.com",
        `${VERSION}/${identity.user_id}/content_publishing_limit`,
        long.accessToken,
        "read",
        new URLSearchParams({ fields: "quota_usage,config" }),
      ),
    );
    return {
      account: requireName(identity.username, [long.accessToken, this.application.clientSecret]),
      target: `instagram:${identity.user_id}`,
      applicationId: this.application.clientId,
      credentials: {
        accessToken: long.accessToken,
        accountId: identity.user_id,
        scopes: code.scopes,
        expiresAt: long.expiresAt,
      },
    };
  }

  private async facebook(long: {
    accessToken: string;
    expiresAt: string;
  }): Promise<MetaPageDiscovery> {
    const proof = facebookDebugSchema.parse(
      await metaRequest(
        "https://graph.facebook.com",
        `${VERSION}/debug_token`,
        `${this.application.clientId}|${this.application.clientSecret}`,
        "read",
        new URLSearchParams({ input_token: long.accessToken }),
      ),
    ).data;
    if (!proof.is_valid || proof.type !== "USER") throw new MetaOAuthClientError("provider");
    if (proof.app_id !== this.application.clientId) throw new MetaOAuthClientError("provider");
    requireScopes(proof.scopes, facebookScopes);
    inspectExpiry(proof.expires_at, proof.data_access_expires_at, true);
    const permissions = facebookPermissionsSchema.parse(
      await metaRequest(
        "https://graph.facebook.com",
        `${VERSION}/me/permissions`,
        long.accessToken,
        "read",
        new URLSearchParams(),
      ),
    );
    if (permissions.paging?.next) throw new MetaOAuthClientError("unavailable");
    for (const scope of facebookScopes) {
      const grants = permissions.data.filter((permission) => permission.permission === scope);
      if (grants.length !== 1 || grants[0]?.status !== "granted")
        throw new MetaOAuthClientError("provider");
    }
    const expiresAt = new Date(
      Math.min(
        Date.parse(long.expiresAt),
        ...(proof.expires_at ? [proof.expires_at * 1000] : []),
        ...(proof.data_access_expires_at ? [proof.data_access_expires_at * 1000] : []),
      ),
    ).toISOString();
    const pages: MetaAccountConnection[] = [];
    const discoveredTokens: string[] = [];
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    // Refuse incomplete discovery rather than silently auto-selecting a first Page.
    for (let index = 0; index < 3; index++) {
      const response = pagesSchema.parse(
        await metaRequest(
          "https://graph.facebook.com",
          `${VERSION}/me/accounts`,
          long.accessToken,
          "read",
          new URLSearchParams({
            fields: "id,name,access_token,tasks",
            limit: String(META_MAX_DISCOVERED_PAGES),
            ...(cursor ? { after: cursor } : {}),
          }),
        ),
      );
      for (const page of response.data) {
        discoveredTokens.push(page.access_token);
        if (ids.has(page.id)) throw new MetaOAuthClientError("unavailable");
        ids.add(page.id);
        if (ids.size > META_MAX_DISCOVERED_PAGES) throw new MetaOAuthClientError("unavailable");
        if (!page.tasks.includes("CREATE_CONTENT")) continue;
        pages.push({
          account: requireName(page.name, [
            long.accessToken,
            page.access_token,
            this.application.clientSecret,
          ]),
          target: `facebook-page:${page.id}`,
          applicationId: this.application.clientId,
          credentials: {
            accessToken: page.access_token,
            userAccessToken: long.accessToken,
            pageId: page.id,
            scopes: proof.scopes.join(" "),
            expiresAt,
          },
        });
      }
      if (!response.paging?.next) {
        if (!pages.length) throw new MetaOAuthClientError("provider");
        for (const page of pages) requireName(page.account, discoveredTokens);
        return { pages };
      }
      const next = new URL(response.paging.next);
      cursor = response.paging.cursors?.after;
      if (
        next.origin !== "https://graph.facebook.com" ||
        next.username ||
        next.password ||
        next.hash ||
        next.pathname !== `/${VERSION}/me/accounts` ||
        !cursor ||
        cursors.has(cursor)
      )
        throw new MetaOAuthClientError("unavailable");
      cursors.add(cursor);
    }
    throw new MetaOAuthClientError("unavailable");
  }
}
