import { GuardedFetchError, GuardedFetchErrorCode, guardedFetch } from "guarded-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINKEDIN_REQUEST_TIMEOUT_MS, linkedinPublisher } from "./linkedin.js";
import {
  AcceptedPublicationError,
  PermanentPublishError,
  PlatformRejectionError,
  type PublisherOptions,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "./types.js";

// The network boundary is mocked; the bounded body readers and error classes stay real.
vi.mock("guarded-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("guarded-fetch")>()),
  guardedFetch: vi.fn(),
}));

const mockGuardedFetch = vi.mocked(guardedFetch);
const credentials = {
  accessToken: "fixture-member-access-token",
  authorUrn: "urn:li:person:member_42",
  scopes: "openid,profile,w_member_social",
  expiresAt: "2099-01-01T00:00:00Z",
};
const application = { clientId: "fixture-application-id", clientSecret: "fixture-client-secret" };
const options: PublisherOptions = { linkedin: application };
const activeToken = () => ({
  active: true,
  client_id: application.clientId,
  status: "active",
  auth_type: "3L",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  scope: "openid, profile, w_member_social",
});
const identity = { sub: "member_42", name: "Fixture Writer" };
const postId = "urn:li:share:123456789";
const receipt = {
  externalId: postId,
  externalUrl: `https://www.linkedin.com/feed/update/${postId}/`,
};
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const created = (body: string | null = null, status = 201, id: string = postId) =>
  new Response(body, { status, headers: { "x-restli-id": id } });
const refusal = (status: number) => ({
  status,
  serviceErrorCode: 100,
  message: `Untrusted remote prose ${credentials.accessToken} ${application.clientSecret}`,
});
function queueProof(token: unknown = activeToken(), member: unknown = identity) {
  mockGuardedFetch.mockResolvedValueOnce(answer(token)).mockResolvedValueOnce(answer(member));
}
const publish = (text = "Reviewed text", overrides: PublisherOptions = options) =>
  linkedinPublisher.publish(credentials, { text }, overrides);
function assertNoSecrets(value: unknown) {
  const printable = value instanceof Error ? value.message : JSON.stringify(value);
  expect(printable).not.toContain(credentials.accessToken);
  expect(printable).not.toContain(application.clientSecret);
}

beforeEach(() => {
  mockGuardedFetch.mockReset();
});

describe("LinkedIn provider-confirmed personal publishing grant", () => {
  it("verifies current publishing scopes, application and OIDC subject without creating a post", async () => {
    queueProof();
    await expect(linkedinPublisher.verify(credentials, options)).resolves.toEqual({
      ok: true,
      account: identity.name,
      target: credentials.authorUrn,
    });
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    const [inspectorUrl, inspector] = mockGuardedFetch.mock.calls[0] ?? [];
    expect(String(inspectorUrl)).toBe("https://www.linkedin.com/oauth/v2/introspectToken");
    expect(inspector).toEqual({
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: application.clientId,
        client_secret: application.clientSecret,
        token: credentials.accessToken,
      }),
      httpsOnly: true,
      allowedHosts: ["www.linkedin.com"],
      followRedirects: false,
      timeoutMs: LINKEDIN_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
    });
    const [identityUrl, identified] = mockGuardedFetch.mock.calls[1] ?? [];
    expect(String(identityUrl)).toBe("https://api.linkedin.com/v2/userinfo");
    expect(identified).toEqual({
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${credentials.accessToken}` },
      body: undefined,
      httpsOnly: true,
      allowedHosts: ["api.linkedin.com"],
      followRedirects: false,
      timeoutMs: LINKEDIN_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
    });
    expect(JSON.stringify(identified)).not.toContain(application.clientSecret);
  });

  it.each([
    { active: false },
    { status: "revoked" },
    { status: "expired" },
    { client_id: "different-application" },
    { auth_type: "2L" },
    { auth_type: "Enterprise_User" },
    { expires_at: 1 },
    { scope: "openid,profile" },
    { scope: "w_member_social,profile" },
    { scope: "w_member_social,openid" },
    { scope: "openid profile w_member_social" },
  ])(
    "refuses the provider's grant failure before any identity or create request: %j",
    async (change) => {
      mockGuardedFetch.mockResolvedValueOnce(answer({ ...activeToken(), ...change }));
      const result = await linkedinPublisher.verify(credentials, options);
      expect(result).toMatchObject({ ok: false });
      expect(result).not.toHaveProperty("indeterminate");
      assertNoSecrets(result);
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    },
  );

  it.each(["client_id", "auth_type", "expires_at", "scope"] as const)(
    "keeps a missing %s proof indeterminate even when the saved bag claims a publishing grant",
    async (field) => {
      const token: Record<string, unknown> = activeToken();
      delete token[field];
      mockGuardedFetch.mockResolvedValueOnce(answer(token));
      await expect(linkedinPublisher.verify(credentials, options)).resolves.toMatchObject({
        ok: false,
        indeterminate: true,
      });
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    },
  );

  it("never substitutes hand-edited channel scopes for the inspector's publishing grant", async () => {
    mockGuardedFetch.mockResolvedValueOnce(answer({ ...activeToken(), scope: "openid,profile" }));
    await expect(publish()).rejects.toBeInstanceOf(PermanentPublishError);
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
    expect(mockGuardedFetch.mock.calls.some(([url]) => String(url).endsWith("/rest/posts"))).toBe(
      false,
    );
  });

  it("uses current provider expiry instead of stale scalar OAuth metadata", async () => {
    queueProof();
    await expect(
      linkedinPublisher.verify({ ...credentials, scopes: "", expiresAt: "2000-01-01" }, options),
    ).resolves.toMatchObject({ ok: true, target: credentials.authorUrn });
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
  });

  it("refuses an identity that does not match the immutable personal author before create", async () => {
    queueProof(activeToken(), { ...identity, sub: "someone_else" });
    await expect(publish()).rejects.toBeInstanceOf(PermanentPublishError);
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    expect(mockGuardedFetch.mock.calls.some(([url]) => String(url).endsWith("/rest/posts"))).toBe(
      false,
    );
  });

  it.each([{}, { sub: 42 }, { sub: "urn:li:person:member_42" }])(
    "does not mark an unusable OIDC identity healthy: %j",
    async (member) => {
      queueProof(activeToken(), member);
      await expect(linkedinPublisher.verify(credentials, options)).resolves.toMatchObject({
        ok: false,
        indeterminate: true,
      });
      expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([undefined, credentials.accessToken, application.clientSecret])(
    "uses the nonsecret author target when an account name is absent or echoes a secret",
    async (name) => {
      queueProof(activeToken(), { sub: identity.sub, ...(name === undefined ? {} : { name }) });
      const result = await linkedinPublisher.verify(credentials, options);
      expect(result).toEqual({
        ok: true,
        account: credentials.authorUrn,
        target: credentials.authorUrn,
      });
      assertNoSecrets(result);
    },
  );

  it("rechecks expiry after identity verification and never creates with an expired grant", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
      mockGuardedFetch.mockResolvedValueOnce(
        answer({ ...activeToken(), expires_at: Date.now() / 1000 + 1 }),
      );
      mockGuardedFetch.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date("2026-10-06T12:00:02Z"));
        return answer(identity);
      });
      await expect(publish()).rejects.toBeInstanceOf(PermanentPublishError);
      expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([400, 401, 403, 429, 500, 503])(
    "separates app/token refusal from temporary inspector HTTP %s without leaking remote prose",
    async (status) => {
      mockGuardedFetch.mockResolvedValueOnce(answer(refusal(status), status));
      const result = await linkedinPublisher.verify(credentials, options);
      expect(result).toMatchObject({ ok: false });
      expect("indeterminate" in result).toBe(status === 429 || status >= 500);
      assertNoSecrets(result);
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    },
  );

  it("classifies a userinfo outage as known not posted and does not create", async () => {
    mockGuardedFetch
      .mockResolvedValueOnce(answer(activeToken()))
      .mockResolvedValueOnce(answer(refusal(503), 503));
    await expect(publish()).rejects.toBeInstanceOf(TransientPublishError);
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
  });

  it("bounds successful verification response reads and never accepts malformed proof", async () => {
    for (const response of [
      answer({ ...activeToken(), expires_at: "2099" }),
      answer({ ...activeToken(), padding: "x".repeat(256_001) }),
      new Response("not JSON"),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(application.clientSecret));
          },
        }),
      ),
    ]) {
      mockGuardedFetch.mockReset().mockResolvedValueOnce(response);
      const result = await linkedinPublisher.verify(credentials, options);
      expect(result).toMatchObject({ ok: false, indeterminate: true });
      assertNoSecrets(result);
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    }
  });

  it("bounds a stalled verification body without attempting a create request", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      mockGuardedFetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
      const pending = publish().catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(LINKEDIN_REQUEST_TIMEOUT_MS + 1);
      expect(await pending).toBeInstanceOf(TransientPublishError);
      expect(cancel).toHaveBeenCalled();
      expect(mockGuardedFetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LinkedIn reviewed plain text create request", () => {
  it("rechecks the current connection immediately after proof and before creating", async () => {
    queueProof();
    const beforeLinkedInCreate = vi
      .fn()
      .mockRejectedValue(new PermanentPublishError("Connection changed"));
    await expect(
      publish("Reviewed text", { ...options, beforeLinkedInCreate }),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(beforeLinkedInCreate).toHaveBeenCalledOnce();
    expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    expect(mockGuardedFetch.mock.calls.every(([url]) => !String(url).endsWith("/rest/posts"))).toBe(
      true,
    );
  });
  it("does not create if the token expires while waiting for the final connection check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const now = Date.now();
      queueProof();
      await expect(
        publish("Reviewed text", {
          ...options,
          beforeLinkedInCreate: async () => {
            vi.setSystemTime(now + 3_600_001);
          },
        }),
      ).rejects.toBeInstanceOf(PermanentPublishError);
      expect(mockGuardedFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preflights again and creates once through the current Posts API with the exact reviewed text", async () => {
    queueProof();
    mockGuardedFetch.mockResolvedValueOnce(created());
    await expect(
      linkedinPublisher.publish(
        credentials,
        { text: "First paragraph\n\nSecond paragraph", title: "Do not synthesize this title" },
        options,
      ),
    ).resolves.toEqual(receipt);
    expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
    const [url, request] = mockGuardedFetch.mock.calls[2] ?? [];
    expect(String(url)).toBe("https://api.linkedin.com/rest/posts");
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": "202609",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      httpsOnly: true,
      allowedHosts: ["api.linkedin.com"],
      followRedirects: false,
      timeoutMs: LINKEDIN_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      author: credentials.authorUrn,
      commentary: "First paragraph\n\nSecond paragraph",
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
    expect(String(request?.body)).not.toContain(application.clientSecret);
    expect(request).not.toHaveProperty("skipSsrfCheckForAllowedHosts");
  });

  it("escapes every little-text reserved character once and preserves Unicode, literal backslashes and line breaks", async () => {
    queueProof();
    mockGuardedFetch.mockResolvedValueOnce(created());
    await publish("|{}@[]()<>#\\*_~ Привет 🌍\nplain & text");
    expect(JSON.parse(String(mockGuardedFetch.mock.calls[2]?.[1]?.body)).commentary).toBe(
      "\\|\\{\\}\\@\\[\\]\\(\\)\\<\\>\\#\\\\\\*\\_\\~ Привет 🌍\nplain & text",
    );
  });

  it("keeps injected transport inside the endpoint guard for all three requests", async () => {
    queueProof();
    mockGuardedFetch.mockResolvedValueOnce(created());
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await publish("Text", { ...options, fetchImpl, baseUrl: "https://api.linkedin.com/" });
    for (const [, request] of mockGuardedFetch.mock.calls) {
      expect(request?.fetch).toBe(fetchImpl);
      expect(request?.followRedirects).toBe(false);
      expect(request).not.toHaveProperty("skipSsrfCheckForAllowedHosts");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["urn:li:share:123456789", "urn:li:ugcPost:123456789"])(
    "accepts the documented empty 201 response with a real %s receipt",
    async (id) => {
      queueProof();
      mockGuardedFetch.mockResolvedValueOnce(created(null, 201, id));
      await expect(publish()).resolves.toEqual({
        externalId: id,
        externalUrl: `https://www.linkedin.com/feed/update/${id}/`,
      });
      expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
    },
  );

  it("accepts an explicit PUBLISHED response while ignoring any untrusted URL in its body", async () => {
    queueProof();
    mockGuardedFetch.mockResolvedValueOnce(
      created(
        JSON.stringify({
          lifecycleState: "PUBLISHED",
          url: `https://unsafe.example/${application.clientSecret}`,
        }),
      ),
    );
    const result = await publish();
    expect(result).toEqual(receipt);
    assertNoSecrets(result);
  });

  it.each(["DRAFT", "PUBLISH_REQUESTED", "PUBLISH_FAILED"])(
    "retains an accepted %s record without claiming publication or retrying create",
    async (state) => {
      queueProof();
      mockGuardedFetch.mockResolvedValueOnce(created(JSON.stringify({ lifecycleState: state })));
      const error = await publish().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AcceptedPublicationError);
      expect((error as AcceptedPublicationError).receipt).toEqual(receipt);
      expect((error as Error).message).toContain(state);
      assertNoSecrets(error);
      expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    "not JSON",
    "{}",
    JSON.stringify({ lifecycleState: credentials.accessToken }),
    JSON.stringify({ lifecycleState: 123 }),
  ])(
    "retains the authoritative header receipt when a nonempty body is ambiguous: %s",
    async (body) => {
      queueProof();
      mockGuardedFetch.mockResolvedValueOnce(created(body));
      const error = await publish().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AcceptedPublicationError);
      expect((error as AcceptedPublicationError).receipt).toEqual(receipt);
      assertNoSecrets(error);
      expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([200, 202, 204])(
    "does not claim creation from an undocumented HTTP %s even with an ID",
    async (status) => {
      queueProof();
      mockGuardedFetch.mockResolvedValueOnce(created(null, status));
      const error = await publish().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AcceptedPublicationError);
      expect((error as AcceptedPublicationError).receipt).toEqual(receipt);
      expect((error as AcceptedPublicationError).status).toBe(status);
      expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    "",
    "123",
    "urn:li:share:0",
    "urn:li:share:-1",
    "urn:li:share:1.5",
    "urn:li:person:member_42",
    "https://www.linkedin.com/post/123",
  ])("keeps an unusable create receipt unknown and never retries: %s", async (id) => {
    queueProof();
    mockGuardedFetch.mockResolvedValueOnce(created(null, 201, id));
    const error = await publish().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnknownOutcomePublishError);
    expect(error).not.toBeInstanceOf(AcceptedPublicationError);
    expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
  });

  it("retains the accepted ID after a body socket loss or an oversized response", async () => {
    for (const body of [
      new ReadableStream({
        start(controller) {
          controller.error(new Error(credentials.accessToken));
        },
      }),
      JSON.stringify({ lifecycleState: "PUBLISHED", padding: "x".repeat(256_001) }),
    ]) {
      mockGuardedFetch.mockReset();
      queueProof();
      mockGuardedFetch.mockResolvedValueOnce(
        new Response(body, { status: 201, headers: { "x-restli-id": postId } }),
      );
      const error = await publish().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AcceptedPublicationError);
      expect((error as AcceptedPublicationError).receipt).toEqual(receipt);
      assertNoSecrets(error);
      expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
    }
  });

  it("keeps body reads inside the create deadline and preserves an already received ID on timeout", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      queueProof();
      mockGuardedFetch.mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status: 201,
          headers: { "x-restli-id": postId },
        }),
      );
      const pending = publish().catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(LINKEDIN_REQUEST_TIMEOUT_MS + 1);
      const error = await pending;
      expect(error).toBeInstanceOf(AcceptedPublicationError);
      expect((error as AcceptedPublicationError).receipt).toEqual(receipt);
      expect(cancel).toHaveBeenCalled();
      expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LinkedIn transport outcome and preflight fences", () => {
  it.each([
    undefined,
    {},
    { clientId: application.clientId, clientSecret: "" },
    { clientId: "", clientSecret: application.clientSecret },
  ])(
    "refuses missing or invalid server application credentials before HTTP: %j",
    async (linkedin) => {
      const configured = { linkedin } as PublisherOptions;
      await expect(linkedinPublisher.verify(credentials, configured)).resolves.toMatchObject({
        ok: false,
      });
      await expect(publish("Text", configured)).rejects.toBeInstanceOf(PermanentPublishError);
      expect(mockGuardedFetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://api.linkedin.com",
    "https://api.linkedin.com.evil.example",
    "https://localhost",
    "https://api.linkedin.com/rest/posts",
  ])(
    "refuses an endpoint override before the access token or client secret can leave: %s",
    async (baseUrl) => {
      await expect(publish("Text", { ...options, baseUrl })).rejects.toBeInstanceOf(
        PermanentPublishError,
      );
      expect(mockGuardedFetch).not.toHaveBeenCalled();
    },
  );

  it("explicitly refuses organizations, malformed credentials, unsupported media and invalid text before HTTP", async () => {
    for (const change of [
      { authorUrn: "urn:li:organization:123" },
      { authorUrn: "member_42" },
      { accessToken: "" },
      { accessToken: "injected\nheader" },
    ])
      await expect(
        linkedinPublisher.publish({ ...credentials, ...change }, { text: "Text" }, options),
      ).rejects.toBeInstanceOf(PermanentPublishError);
    for (const media of [
      { image: { bytes: Uint8Array.of(255), mimeType: "image/jpeg" as const } },
      { video: { bytes: Uint8Array.of(255), mimeType: "video/mp4" as const } },
    ])
      await expect(
        linkedinPublisher.publish(credentials, { text: "Text", ...media }, options),
      ).rejects.toBeInstanceOf(PermanentPublishError);
    for (const text of ["", " \t\n ", "x".repeat(linkedinPublisher.maxTextLength + 1)])
      await expect(publish(text)).rejects.toBeInstanceOf(PermanentPublishError);
    expect(mockGuardedFetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, PlatformRejectionError],
    [403, PlatformRejectionError],
    [422, PlatformRejectionError],
    [429, TransientPublishError],
    [500, UnknownOutcomePublishError],
    [503, UnknownOutcomePublishError],
  ] as const)(
    "classifies the official refusal envelope HTTP %s without reflecting secrets",
    async (status, expected) => {
      queueProof();
      mockGuardedFetch.mockResolvedValueOnce(answer(refusal(status), status));
      const error = await publish().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(expected);
      assertNoSecrets(error);
      expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([403, 429, 502])(
    "does not safely retry a gateway HTTP %s without LinkedIn's envelope",
    async (status) => {
      queueProof();
      mockGuardedFetch.mockResolvedValueOnce(new Response("gateway", { status }));
      await expect(publish()).rejects.toBeInstanceOf(UnknownOutcomePublishError);
      expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
    },
  );

  it("does not trust a provider envelope with a mismatched status", async () => {
    queueProof();
    mockGuardedFetch.mockResolvedValueOnce(answer(refusal(403), 429));
    await expect(publish()).rejects.toBeInstanceOf(UnknownOutcomePublishError);
    expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
  });

  it.each(["inspector", "identity", "create"] as const)(
    "never forwards credentials across a %s redirect or waits forever for cancellation",
    async (phase) => {
      const cancel = vi.fn(() => new Promise<void>(() => undefined));
      if (phase === "identity") mockGuardedFetch.mockResolvedValueOnce(answer(activeToken()));
      if (phase === "create") queueProof();
      mockGuardedFetch.mockResolvedValueOnce(
        new Response(new ReadableStream({ cancel }), {
          status: 303,
          headers: { location: "https://evil.example/" },
        }),
      );
      await expect(publish()).rejects.toBeInstanceOf(
        phase === "create" ? UnknownOutcomePublishError : TransientPublishError,
      );
      expect(cancel).toHaveBeenCalled();
      expect(mockGuardedFetch).toHaveBeenCalledTimes(
        phase === "inspector" ? 1 : phase === "identity" ? 2 : 3,
      );
      expect(mockGuardedFetch.mock.calls.at(-1)?.[1]?.followRedirects).toBe(false);
    },
  );

  it("keeps a preflight timeout retryable because no create request was attempted", async () => {
    mockGuardedFetch.mockRejectedValueOnce(
      new GuardedFetchError(GuardedFetchErrorCode.TIMEOUT, credentials.accessToken),
    );
    const error = await publish().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransientPublishError);
    assertNoSecrets(error);
    expect(mockGuardedFetch).toHaveBeenCalledOnce();
  });

  it("distinguishes a proven create connection refusal from potentially delivered timeout or socket errors", async () => {
    const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const failures = [
      [new Error(credentials.accessToken), UnknownOutcomePublishError],
      [new GuardedFetchError(GuardedFetchErrorCode.TIMEOUT, "timeout"), UnknownOutcomePublishError],
      [
        new GuardedFetchError(GuardedFetchErrorCode.TIMEOUT, "timeout", { cause: refused }),
        UnknownOutcomePublishError,
      ],
      [
        new GuardedFetchError(GuardedFetchErrorCode.NETWORK_ERROR, "socket", {
          cause: Object.assign(new Error("socket"), { code: "ECONNRESET", cause: refused }),
        }),
        UnknownOutcomePublishError,
      ],
      [
        new GuardedFetchError(GuardedFetchErrorCode.NETWORK_ERROR, "ambiguous", {
          cause: new AggregateError([refused]),
        }),
        UnknownOutcomePublishError,
      ],
      [
        new GuardedFetchError(GuardedFetchErrorCode.NETWORK_ERROR, "connect", { cause: refused }),
        TransientPublishError,
      ],
    ] as const;
    for (const [failure, expected] of failures) {
      mockGuardedFetch.mockReset();
      queueProof();
      mockGuardedFetch.mockRejectedValueOnce(failure);
      const error = await publish().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(expected);
      assertNoSecrets(error);
      expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
    }
  });

  it("preserves unsafe-address rejection as a known refusal before create can leave", async () => {
    queueProof();
    mockGuardedFetch.mockRejectedValueOnce(
      new GuardedFetchError(GuardedFetchErrorCode.HOSTNAME_UNSAFE, application.clientSecret),
    );
    const error = await publish().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermanentPublishError);
    assertNoSecrets(error);
    expect(mockGuardedFetch).toHaveBeenCalledTimes(3);
  });
});
