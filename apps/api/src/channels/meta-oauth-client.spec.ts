import { type MetaConnectionProvider } from "@pubrick/shared";
import { guardedFetch } from "guarded-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { META_OAUTH_TIMEOUT_MS, MetaOAuthClient, MetaOAuthClientError } from "./meta-oauth-client";

// The maintained OAuth validators and bounded body reader remain real. No provider I/O.
vi.mock("guarded-fetch", async (original) => ({
  ...(await original<typeof import("guarded-fetch")>()),
  guardedFetch: vi.fn(),
}));
const transport = vi.mocked(guardedFetch);
const application = { clientId: "123456", clientSecret: "fixture-app-secret" };
const callbackUri = "https://pubrick.example/en/connections/meta/threads";
const state = "s".repeat(43);
const code = "fixture-code";
const accessToken = "fixture-access-token";
const now = new Date("2026-10-07T01:00:00Z").getTime();
const client = (provider: MetaConnectionProvider = "threads") =>
  new MetaOAuthClient(provider, application);
const parameters = () => new URLSearchParams({ state, code });
const exchange = (provider: MetaConnectionProvider = "threads", callback = parameters()) =>
  client(provider).exchange({
    parameters: callback,
    expectedState: state,
    redirectUri: callbackUri,
  });
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function safeError(error: unknown, kind: string) {
  expect(error).toBeInstanceOf(MetaOAuthClientError);
  expect(error).toMatchObject({ kind });
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  for (const secret of [application.clientSecret, accessToken, code, state])
    expect(text).not.toContain(secret);
  expect(error).not.toHaveProperty("cause");
}
beforeEach(() => {
  transport.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("Meta confidential code flow", () => {
  it.each([
    ["threads", "https://www.threads.com/oauth/authorize", "threads_basic,threads_content_publish"],
    [
      "instagram_native",
      "https://www.instagram.com/oauth/authorize",
      "instagram_business_basic,instagram_business_content_publish",
    ],
    [
      "facebook_page",
      "https://www.facebook.com/v26.0/dialog/oauth",
      "pages_manage_posts,pages_read_engagement,pages_show_list",
    ],
  ] as const)(
    "uses the distinct %s application and closed publication scope",
    (provider, endpoint, scope) => {
      const first = client(provider).begin(callbackUri);
      const second = client(provider).begin(callbackUri);
      expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(second.state).not.toBe(first.state);
      const url = new URL(first.authorizationUrl);
      expect(`${url.origin}${url.pathname}`).toBe(endpoint);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        client_id: application.clientId,
        redirect_uri: callbackUri,
        response_type: "code",
        scope,
        state: first.state,
      });
      expect(JSON.stringify(first)).not.toContain(application.clientSecret);
      expect(first).not.toHaveProperty("nonce");
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it("uses the standard Threads form exchange without fabricating grants", async () => {
    transport.mockResolvedValue(
      answer({ access_token: accessToken, token_type: "bearer", expires_in: 3600 }),
    );
    expect(await exchange()).toEqual({
      accessToken,
      scopes: "",
      expiresAt: "2026-10-07T02:00:00.000Z",
    });
    const [url, options] = transport.mock.calls[0] ?? [];
    expect(url).toBe("https://graph.threads.com/oauth/access_token");
    expect(options?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(options?.body)))).toEqual({
      client_id: application.clientId,
      client_secret: application.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUri,
    });
    expect(options).toMatchObject({
      followRedirects: false,
      opaqueErrors: true,
      timeoutMs: META_OAUTH_TIMEOUT_MS,
    });
  });
  it("adapts the documented Facebook GET exchange behind the same validator", async () => {
    transport.mockResolvedValue(
      answer({ access_token: accessToken, token_type: "Bearer", expires_in: 3600 }),
    );
    expect(await exchange("facebook_page")).toMatchObject({ accessToken, scopes: "" });
    const [url, options] = transport.mock.calls[0] ?? [];
    const actual = new URL(String(url));
    expect(`${actual.origin}${actual.pathname}`).toBe(
      "https://graph.facebook.com/v26.0/oauth/access_token",
    );
    expect(Object.fromEntries(actual.searchParams)).toEqual({
      client_id: application.clientId,
      client_secret: application.clientSecret,
      code,
      redirect_uri: callbackUri,
    });
    expect(options).toMatchObject({
      method: "GET",
      body: undefined,
      followRedirects: false,
      opaqueErrors: true,
    });
  });
  it("reads Instagram's documented wrapped subject and actual comma-separated grants", async () => {
    transport.mockResolvedValue(
      answer({
        data: [
          {
            access_token: accessToken,
            user_id: "12345",
            permissions: "instagram_business_basic,instagram_business_content_publish",
          },
        ],
      }),
    );
    expect(await exchange("instagram_native")).toEqual({
      accessToken,
      subject: "12345",
      scopes: "instagram_business_basic instagram_business_content_publish",
    });
    expect(transport.mock.calls[0]?.[0]).toBe("https://api.instagram.com/oauth/access_token");
  });
  it.each([
    () => new URLSearchParams({ code }),
    () => new URLSearchParams({ state: "x".repeat(43), code }),
    () =>
      new URLSearchParams([
        ["state", state],
        ["state", state],
        ["code", code],
      ]),
    () => new URLSearchParams({ state }),
    () =>
      new URLSearchParams([
        ["state", state],
        ["code", code],
        ["code", code],
      ]),
    () => new URLSearchParams({ state, error: "access_denied", error_description: accessToken }),
  ])("refuses invalid/denied callbacks before any exchange", async (make) => {
    safeError(await exchange("threads", make()).catch((error: unknown) => error), "callback");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { data: [] },
    {
      data: [
        { access_token: accessToken, user_id: "12345", permissions: "basic" },
        { access_token: accessToken, user_id: "54321", permissions: "basic" },
      ],
    },
    { data: [{ access_token: accessToken, user_id: "0", permissions: "basic" }] },
    { data: [{ access_token: accessToken, user_id: "12345" }] },
  ])("refuses ambiguous Instagram exchange evidence", async (body) => {
    transport.mockResolvedValue(answer(body));
    safeError(await exchange("instagram_native").catch((error: unknown) => error), "unavailable");
  });
  it.each([0, -1, 0.5, "3600junk", "3600", null, true])(
    "refuses unusable raw provider expiry %s",
    async (expires_in) => {
      transport.mockResolvedValue(
        answer({ access_token: accessToken, token_type: "Bearer", expires_in }),
      );
      safeError(await exchange().catch((error: unknown) => error), "unavailable");
    },
  );
  it("refuses authenticated redirects and discards secret response details", async () => {
    transport.mockResolvedValue(
      new Response(accessToken, { status: 302, headers: { location: "https://other.example" } }),
    );
    safeError(await exchange().catch((error: unknown) => error), "unavailable");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("bounds the response body before parsing the token", async () => {
    transport.mockResolvedValue(
      answer({ access_token: accessToken, token_type: "Bearer", extra: "x".repeat(256_000) }),
    );
    safeError(await exchange().catch((error: unknown) => error), "unavailable");
  });
  it("refuses an incompatible token type instead of claiming bearer authorization", async () => {
    transport.mockResolvedValue(
      answer({ access_token: accessToken, token_type: "MAC", expires_in: 3600 }),
    );
    safeError(await exchange().catch((error: unknown) => error), "unavailable");
  });
  it("redacts provider failures without saving their cause", async () => {
    transport.mockResolvedValue(
      answer(
        {
          error: "invalid_grant",
          error_description: `${application.clientSecret} ${accessToken} ${code} ${state}`,
        },
        400,
      ),
    );
    safeError(await exchange().catch((error: unknown) => error), "provider");
  });
  it.each([400, 401, 403])(
    "classifies a known Graph refusal at HTTP %s without details",
    async (status) => {
      transport.mockResolvedValue(
        answer(
          {
            error: {
              code: 190,
              type: "OAuthException",
              message: `${application.clientSecret} ${accessToken} ${code} ${state}`,
            },
          },
          status,
        ),
      );
      safeError(await exchange("facebook_page").catch((error: unknown) => error), "provider");
    },
  );
  it.each([
    [400, 4, false],
    [400, 190, true],
    [500, 190, false],
  ])(
    "keeps rate/transient/server responses indeterminate (%s, %s)",
    async (status, errorCode, transient) => {
      transport.mockResolvedValue(
        answer(
          {
            error: {
              code: errorCode,
              is_transient: transient,
              message: accessToken,
            },
          },
          status,
        ),
      );
      safeError(await exchange("facebook_page").catch((error: unknown) => error), "unavailable");
    },
  );
  it.each(["socket disconnected", "request timed out"])(
    "does not turn an unavailable transport into authorization: %s",
    async (failure) => {
      transport.mockRejectedValue(
        new Error(`${failure}: ${application.clientSecret} ${accessToken}`),
      );
      safeError(await exchange().catch((error: unknown) => error), "unavailable");
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "http://pubrick.example/callback",
    "https://u:p@pubrick.example/callback",
    "https://pubrick.example/callback?next=other",
    "https://pubrick.example/callback#code",
    "https://PUBRICK.example/callback",
  ])("rejects noncanonical callbacks before I/O", async (redirectUri) => {
    expect(() => client().begin(redirectUri)).toThrow(MetaOAuthClientError);
    safeError(
      await client()
        .exchange({ parameters: parameters(), expectedState: state, redirectUri })
        .catch((error: unknown) => error),
      "configuration",
    );
    expect(transport).not.toHaveBeenCalled();
  });
});
