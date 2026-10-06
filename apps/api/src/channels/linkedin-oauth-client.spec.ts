import { GuardedFetchError, GuardedFetchErrorCode, guardedFetch } from "guarded-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LINKEDIN_OAUTH_REQUEST_TIMEOUT_MS,
  LinkedInOAuthClient,
  LinkedInOAuthClientError,
  validateLinkedInOAuthConfiguration,
} from "./linkedin-oauth-client";

// OAuth protocol validation and bounded body readers stay real. No provider requests are made.
vi.mock("guarded-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("guarded-fetch")>()),
  guardedFetch: vi.fn(),
}));

const mockGuardedFetch = vi.mocked(guardedFetch);
const now = new Date("2026-10-06T12:00:00Z").getTime();
const configuration = { clientId: "fixture-client-id", clientSecret: "fixture-application-secret" };
const redirectUri = "https://app.pubrick.org/api/channels/linkedin/callback";
const state = "s".repeat(43);
const nonce = "n".repeat(43);
const code = "fixture-authorization-code";
const accessToken = "fixture-member-access-token";
const refreshToken = "fixture-member-refresh-token";
const subject = "fixture_member_42";
const client = () => new LinkedInOAuthClient(configuration);
const callback = () => new URLSearchParams({ state, code });
const exchange = (parameters = callback()) =>
  client().exchange({ expectedState: state, expectedNonce: nonce, parameters, redirectUri });

// Synthetic provider JWT fixture. This tests library claim validation over the trusted
// mocked TLS response; it does not claim or exercise application-level signature verification.
function idToken(changes: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "RS256" }),
    encode({
      iss: "https://www.linkedin.com",
      aud: configuration.clientId,
      sub: subject,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      nonce,
      ...changes,
    }),
    Buffer.from("synthetic-signature").toString("base64url"),
  ].join(".");
}
const tokens = (changes: Record<string, unknown> = {}) => ({
  access_token: accessToken,
  expires_in: 3600,
  scope: "openid profile w_member_social",
  token_type: "Bearer",
  id_token: idToken(),
  ...changes,
});
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function queueConnection(
  tokenResponse: unknown = tokens(),
  member: unknown = { sub: subject, name: "Fixture Writer" },
) {
  mockGuardedFetch
    .mockResolvedValueOnce(answer(tokenResponse))
    .mockResolvedValueOnce(answer(member));
}
function assertSafeError(error: unknown, kind: string) {
  expect(error).toBeInstanceOf(LinkedInOAuthClientError);
  expect(error).toMatchObject({ kind });
  const printed = error instanceof Error ? error.message : JSON.stringify(error);
  for (const secret of [configuration.clientSecret, accessToken, refreshToken, code, state, nonce])
    expect(printed).not.toContain(secret);
  expect(error).not.toHaveProperty("cause");
}

beforeEach(() => {
  mockGuardedFetch.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LinkedIn confidential web authorization request", () => {
  it("generates independent random state and nonce with fixed scopes and endpoints, without exposing the client secret", () => {
    const first = client().begin(redirectUri);
    const second = client().begin(redirectUri);
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.state).not.toBe(first.nonce);
    expect(second.state).not.toBe(first.state);
    expect(second.nonce).not.toBe(first.nonce);
    const url = new URL(first.authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: configuration.clientId,
      redirect_uri: redirectUri,
      scope: "openid profile w_member_social",
      state: first.state,
      nonce: first.nonce,
    });
    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
    expect(first).not.toHaveProperty("verifier");
    expect(JSON.stringify(first)).not.toContain(configuration.clientSecret);
    expect(mockGuardedFetch).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { clientId: "", clientSecret: configuration.clientSecret },
    { clientId: "injected\nheader", clientSecret: configuration.clientSecret },
    { clientId: configuration.clientId, clientSecret: " \t " },
    { ...configuration, tokenEndpoint: "https://unsafe.example" },
  ])("refuses invalid or endpoint-overriding server configuration before HTTP: %j", (value) => {
    const error = (() => {
      try {
        return validateLinkedInOAuthConfiguration(value);
      } catch (caught) {
        return caught;
      }
    })();
    assertSafeError(error, "configuration");
    expect(mockGuardedFetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://app.pubrick.org/callback",
    "/api/channels/linkedin/callback",
    "https://user:secret@app.pubrick.org/callback",
    "https://app.pubrick.org/callback?organization=1",
    "https://app.pubrick.org/callback#connection",
    "https://APP.pubrick.org/callback",
    " https://app.pubrick.org/callback",
  ])(
    "refuses a noncanonical callback URL before authorization or code exchange: %s",
    async (url) => {
      expect(() => client().begin(url)).toThrow(LinkedInOAuthClientError);
      const error = await client()
        .exchange({
          expectedState: state,
          expectedNonce: nonce,
          parameters: callback(),
          redirectUri: url,
        })
        .catch((caught: unknown) => caught);
      assertSafeError(error, "configuration");
      expect(mockGuardedFetch).not.toHaveBeenCalled();
    },
  );
});

describe("LinkedIn code, nonce and identity validation", () => {
  it("uses the real OAuth library to exchange once and returns scalar metadata for the provider-confirmed personal author", async () => {
    queueConnection();
    await expect(exchange()).resolves.toEqual({
      credentials: {
        accessToken,
        authorUrn: `urn:li:person:${subject}`,
        scopes: "openid profile w_member_social",
        expiresAt: "2026-10-06T13:00:00.000Z",
      },
      account: "Fixture Writer",
    });
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    const [tokenUrl, request] = mockGuardedFetch.mock.calls[0] ?? [];
    expect(String(tokenUrl)).toBe("https://www.linkedin.com/oauth/v2/accessToken");
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
    });
    expect(request).toMatchObject({
      method: "POST",
      httpsOnly: true,
      allowedHosts: ["www.linkedin.com"],
      followRedirects: false,
      timeoutMs: LINKEDIN_OAUTH_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
    });
    expect(new Headers(request?.headers).get("Content-Type")).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(String(tokenUrl)).not.toContain(configuration.clientSecret);
    expect(String(request?.body)).not.toContain("code_verifier");
    const [identityUrl, identified] = mockGuardedFetch.mock.calls[1] ?? [];
    expect(String(identityUrl)).toBe("https://api.linkedin.com/v2/userinfo");
    expect(identified).toMatchObject({
      method: "GET",
      httpsOnly: true,
      allowedHosts: ["api.linkedin.com"],
      followRedirects: false,
      timeoutMs: LINKEDIN_OAUTH_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
    });
    expect(new Headers(identified?.headers).get("Authorization")).toBe(`Bearer ${accessToken}`);
    expect(JSON.stringify(identified)).not.toContain(configuration.clientSecret);
    expect(JSON.stringify(identified)).not.toContain(code);
    for (const [, guarded] of mockGuardedFetch.mock.calls)
      expect(guarded).not.toHaveProperty("skipSsrfCheckForAllowedHosts");
  });

  it.each([
    new URLSearchParams({ state: "different-state", code }),
    new URLSearchParams({ code }),
    new URLSearchParams({ state }),
    new URLSearchParams([
      ["state", state],
      ["state", state],
      ["code", code],
    ]),
    new URLSearchParams([
      ["state", state],
      ["code", code],
      ["code", code],
    ]),
    new URLSearchParams({
      state,
      error: "user_cancelled_authorize",
      error_description: configuration.clientSecret,
    }),
    new URLSearchParams({ state, code, error: "access_denied" }),
    new URLSearchParams({ state, code, iss: "https://unsafe.example" }),
  ])(
    "refuses an invalid callback through library validation before any token request: %s",
    async (parameters) => {
      const error = await exchange(parameters).catch((caught: unknown) => caught);
      assertSafeError(error, "callback");
      expect(mockGuardedFetch).not.toHaveBeenCalled();
    },
  );

  it.each(["", "weak", "s".repeat(129)])(
    "refuses an unusable expected state before HTTP: %s",
    async (expectedState) => {
      const error = await client()
        .exchange({ expectedState, expectedNonce: nonce, parameters: callback(), redirectUri })
        .catch((caught: unknown) => caught);
      assertSafeError(error, "callback");
      expect(mockGuardedFetch).not.toHaveBeenCalled();
    },
  );

  it("requires a saved independent nonce before HTTP", async () => {
    const error = await client()
      .exchange({ expectedState: state, expectedNonce: "", parameters: callback(), redirectUri })
      .catch((caught: unknown) => caught);
    assertSafeError(error, "callback");
    expect(mockGuardedFetch).not.toHaveBeenCalled();
  });

  it.each([
    { nonce: "different-nonce" },
    { nonce: undefined },
    { aud: "different-application" },
    { iss: "https://unsafe.example" },
    { exp: Math.floor(now / 1000) - 60 },
    { sub: undefined },
  ])("refuses invalid ID token claims before reading userinfo: %j", async (claims) => {
    mockGuardedFetch.mockResolvedValueOnce(answer(tokens({ id_token: idToken(claims) })));
    const error = await exchange().catch((caught: unknown) => caught);
    assertSafeError(error, "unavailable");
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
  });

  it.each([undefined, "not-a-jwt"])(
    "requires the ID token promised by the requested openid scope: %s",
    async (id_token) => {
      mockGuardedFetch.mockResolvedValueOnce(answer(tokens({ id_token })));
      const error = await exchange().catch((caught: unknown) => caught);
      assertSafeError(error, "unavailable");
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    },
  );

  it("requires userinfo to match the library-validated ID token subject", async () => {
    queueConnection(tokens(), { sub: "another_member", name: "Other Writer" });
    const error = await exchange().catch((caught: unknown) => caught);
    assertSafeError(error, "unavailable");
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
  });

  it("normalizes only an absent token_type on a successful fixed LinkedIn token response", async () => {
    queueConnection(tokens({ token_type: undefined }));
    await expect(exchange()).resolves.toMatchObject({
      credentials: { accessToken, authorUrn: `urn:li:person:${subject}` },
    });
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, "", "MAC", "DPoP"])(
    "refuses an explicitly incompatible token_type instead of overriding it: %s",
    async (token_type) => {
      mockGuardedFetch.mockResolvedValueOnce(answer(tokens({ token_type })));
      const error = await exchange().catch((caught: unknown) => caught);
      assertSafeError(error, "unavailable");
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    },
  );

  it("does not fill missing granted scopes from the requested scopes", async () => {
    queueConnection(tokens({ scope: undefined }));
    await expect(exchange()).resolves.toMatchObject({ credentials: { scopes: "" } });
  });

  it("retains an optional refresh token and its provider-supplied expiry as scalar strings", async () => {
    queueConnection(tokens({ refresh_token: refreshToken, refresh_token_expires_in: 86400 }));
    const result = await exchange();
    expect(result.credentials).toEqual({
      accessToken,
      authorUrn: `urn:li:person:${subject}`,
      scopes: "openid profile w_member_social",
      expiresAt: "2026-10-06T13:00:00.000Z",
      refreshToken,
      refreshExpiresAt: "2026-10-07T12:00:00.000Z",
    });
    expect(Object.values(result.credentials).every((value) => typeof value === "string")).toBe(
      true,
    );
  });

  it("does not invent refresh availability or an unreported refresh expiry", async () => {
    queueConnection();
    const unrefreshable = await exchange();
    expect(unrefreshable.credentials).not.toHaveProperty("refreshToken");
    expect(unrefreshable.credentials).not.toHaveProperty("refreshExpiresAt");
    queueConnection(tokens({ refresh_token: refreshToken }));
    const refreshable = await exchange();
    expect(refreshable.credentials.refreshToken).toBe(refreshToken);
    expect(refreshable.credentials).not.toHaveProperty("refreshExpiresAt");
  });

  it.each([undefined, 0, -1, 0.5, Number.MAX_SAFE_INTEGER])(
    "refuses an unusable access token expiry before userinfo: %s",
    async (expires_in) => {
      mockGuardedFetch.mockResolvedValueOnce(answer(tokens({ expires_in })));
      const error = await exchange().catch((caught: unknown) => caught);
      assertSafeError(error, "unavailable");
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    },
  );

  it("anchors expiry before the token request and refuses a token that expires while reading identity", async () => {
    mockGuardedFetch.mockResolvedValueOnce(answer(tokens({ expires_in: 1 })));
    mockGuardedFetch.mockImplementationOnce(async () => {
      vi.setSystemTime(now + 2000);
      return answer({ sub: subject });
    });
    const error = await exchange().catch((caught: unknown) => caught);
    assertSafeError(error, "unavailable");
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
  });

  it.each([accessToken, refreshToken, configuration.clientSecret, code, state, nonce])(
    "never exposes an echoed secret in the account display name",
    async (name) => {
      queueConnection(tokens({ refresh_token: refreshToken }), {
        sub: subject,
        name: `Writer ${name}`,
      });
      await expect(exchange()).resolves.toMatchObject({ account: `urn:li:person:${subject}` });
    },
  );
});

describe("LinkedIn bounded OAuth transport", () => {
  it("keeps injected transport behind the guard without endpoint overrides", async () => {
    queueConnection();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await new LinkedInOAuthClient(configuration, { fetchImpl }).exchange({
      expectedState: state,
      expectedNonce: nonce,
      parameters: callback(),
      redirectUri,
    });
    for (const [, request] of mockGuardedFetch.mock.calls) expect(request?.fetch).toBe(fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["token", "identity"] as const)(
    "never follows a %s redirect or waits for hanging body cancellation",
    async (phase) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      if (phase === "identity") mockGuardedFetch.mockResolvedValueOnce(answer(tokens()));
      mockGuardedFetch.mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { location: "https://unsafe.example" },
        }),
      );
      const error = await exchange().catch((caught: unknown) => caught);
      assertSafeError(error, "unavailable");
      expect(cancel).toHaveBeenCalled();
      expect(mockGuardedFetch).toHaveBeenCalledTimes(phase === "token" ? 1 : 2);
      expect(mockGuardedFetch.mock.calls.at(-1)?.[1]?.followRedirects).toBe(false);
    },
  );

  it("sanitizes both OAuth error envelopes and authentication challenges", async () => {
    for (const response of [
      answer({ error: "invalid_client", error_description: configuration.clientSecret }, 400),
      new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer error="invalid_token", error_description="${accessToken}"`,
        },
      }),
    ]) {
      mockGuardedFetch.mockReset().mockResolvedValueOnce(response);
      const error = await exchange().catch((caught: unknown) => caught);
      assertSafeError(error, "provider");
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    }
  });

  it("refuses an error-envelope token response before processing identity, without absent-type normalization hiding it", async () => {
    mockGuardedFetch.mockResolvedValueOnce(
      answer({ error: "invalid_grant", error_description: code }, 200),
    );
    const error = await exchange().catch((caught: unknown) => caught);
    assertSafeError(error, "unavailable");
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
  });

  it("bounds malformed, excessive and lost token bodies and never retries a consumed code", async () => {
    for (const response of [
      new Response("not JSON", { headers: { "Content-Type": "application/json" } }),
      answer(tokens({ padding: "x".repeat(256_001) })),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(code));
          },
        }),
      ),
      new Response(null, { status: 204 }),
    ]) {
      mockGuardedFetch.mockReset().mockResolvedValueOnce(response);
      const error = await exchange().catch((caught: unknown) => caught);
      assertSafeError(error, "unavailable");
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    }
  });

  it("keeps a stalled token body inside the whole request deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const cancel = vi.fn();
    mockGuardedFetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = exchange().catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(LINKEDIN_OAUTH_REQUEST_TIMEOUT_MS + 1);
    assertSafeError(await pending, "unavailable");
    expect(cancel).toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
  });

  it("keeps an identity body within its own bounded request and never returns partially verified credentials", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const cancel = vi.fn();
    mockGuardedFetch
      .mockResolvedValueOnce(answer(tokens()))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
    const pending = exchange().catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(LINKEDIN_OAUTH_REQUEST_TIMEOUT_MS + 1);
    const error = await pending;
    assertSafeError(error, "unavailable");
    expect(error).not.toHaveProperty("credentials");
    expect(cancel).toHaveBeenCalled();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Error(configuration.clientSecret),
    new GuardedFetchError(GuardedFetchErrorCode.TIMEOUT, code),
    new GuardedFetchError(GuardedFetchErrorCode.HOSTNAME_UNSAFE, accessToken),
  ])(
    "sanitizes network and address-guard failures without automatically retrying",
    async (failure) => {
      mockGuardedFetch.mockRejectedValueOnce(failure);
      const error = await exchange().catch((caught: unknown) => caught);
      assertSafeError(error, "unavailable");
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    },
  );
});
