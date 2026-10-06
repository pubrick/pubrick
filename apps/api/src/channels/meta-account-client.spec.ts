import { metaRequest, PlatformRejectionError, TransientPublishError } from "@pubrick/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaAccountClient } from "./meta-account-client";
import { MetaOAuthClientError } from "./meta-oauth-client";

vi.mock("@pubrick/integrations", async (original) => ({
  ...(await original<typeof import("@pubrick/integrations")>()),
  metaRequest: vi.fn(),
}));
const request = vi.mocked(metaRequest);
const application = { clientId: "123456", clientSecret: "synthetic-application-secret" };
const short = { accessToken: "synthetic-short-token", scopes: "" };
const longToken = "synthetic-long-token";
const now = new Date("2026-10-07T01:00:00Z").getTime();
const later = Math.floor(now / 1000) + 3600;
const long = { access_token: longToken, expires_in: 3600, token_type: "bearer" };
const threadsProof = (changes: Record<string, unknown> = {}) => ({
  data: {
    type: "USER",
    is_valid: true,
    user_id: "654321",
    expires_at: later,
    scopes: ["threads_basic", "threads_content_publish"],
    ...changes,
  },
});
const facebookProof = (changes: Record<string, unknown> = {}) => ({
  data: {
    type: "USER",
    is_valid: true,
    user_id: "7777",
    app_id: application.clientId,
    expires_at: later,
    scopes: ["pages_manage_posts", "pages_read_engagement", "pages_show_list"],
    ...changes,
  },
});
const permissions = {
  data: ["pages_manage_posts", "pages_read_engagement", "pages_show_list"].map((permission) => ({
    permission,
    status: "granted",
  })),
};
const page = (id: string, tasks = ["CREATE_CONTENT"]) => ({
  id,
  name: `Journal ${id}`,
  access_token: `synthetic-page-token-${id}`,
  tasks,
});
const instagramCode = {
  ...short,
  subject: "2222",
  scopes: "instagram_business_basic instagram_business_content_publish",
};
const instagramIdentity = {
  id: "2222",
  user_id: "3333",
  username: "studio",
  account_type: "BUSINESS",
};
const quota = { data: [{ quota_usage: 1, config: { quota_total: 50, quota_duration: 86400 } }] };

function safeError(error: unknown, kind = "unavailable") {
  expect(error).toBeInstanceOf(MetaOAuthClientError);
  expect(error).toMatchObject({ kind });
  expect(error).not.toHaveProperty("cause");
  for (const secret of [
    short.accessToken,
    longToken,
    application.clientSecret,
    "synthetic-page-token-111",
  ])
    expect((error as Error).message).not.toContain(secret);
}
beforeEach(() => {
  request.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("Threads connection identity and actual grants", () => {
  it("inspects ordinary user tokens with the documented current application token", async () => {
    request
      .mockResolvedValueOnce(long)
      .mockResolvedValueOnce(threadsProof())
      .mockResolvedValueOnce({ id: "654321", username: "studio" });
    const result = await new MetaAccountClient("threads", application).connect(short);
    expect(result).toEqual({
      account: "studio",
      target: "threads:654321",
      applicationId: application.clientId,
      credentials: {
        accessToken: longToken,
        accountId: "654321",
        expiresAt: "2026-10-07T02:00:00.000Z",
        scopes: "threads_basic threads_content_publish",
      },
    });
    expect(request.mock.calls[1]?.slice(0, 4)).toEqual([
      "https://graph.threads.com",
      "debug_token",
      `TH|${application.clientId}|${application.clientSecret}`,
      "read",
    ]);
    expect(Object.fromEntries(request.mock.calls[0]?.[4] ?? [])).toEqual({
      grant_type: "th_exchange_token",
      client_secret: application.clientSecret,
      access_token: short.accessToken,
    });
    expect(Object.fromEntries(request.mock.calls[1]?.[4] ?? [])).toEqual({
      input_token: longToken,
    });
  });
  it.each([
    { is_valid: false },
    { type: "APP" },
    { expires_at: later - 3601 },
    { data_access_expires_at: later - 3601 },
    { scopes: ["threads_basic"] },
  ])("refuses current invalid or revoked publishing access %j", async (changes) => {
    request.mockResolvedValueOnce(long).mockResolvedValueOnce(threadsProof(changes));
    safeError(
      await new MetaAccountClient("threads", application).connect(short).catch((e) => e),
      "provider",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("never connects a profile that disagrees with the inspected token", async () => {
    request
      .mockResolvedValueOnce(long)
      .mockResolvedValueOnce(threadsProof())
      .mockResolvedValueOnce({ id: "111111", username: "other" });
    safeError(
      await new MetaAccountClient("threads", application).connect(short).catch((e) => e),
      "provider",
    );
  });
});

describe("Instagram native professional connection", () => {
  it("binds the app-scoped subject and professional destination separately", async () => {
    request
      .mockResolvedValueOnce(long)
      .mockResolvedValueOnce(instagramIdentity)
      .mockResolvedValueOnce(quota);
    expect(
      await new MetaAccountClient("instagram_native", application).connect(instagramCode),
    ).toEqual({
      account: "studio",
      target: "instagram:3333",
      applicationId: application.clientId,
      credentials: {
        accessToken: longToken,
        accountId: "3333",
        scopes: instagramCode.scopes,
        expiresAt: "2026-10-07T02:00:00.000Z",
      },
    });
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      "access_token",
      "v26.0/me",
      "v26.0/3333/content_publishing_limit",
    ]);
    expect(Object.fromEntries(request.mock.calls[1]?.[4] ?? [])).toEqual({
      fields: "id,user_id,username,account_type",
    });
    expect(Object.fromEntries(request.mock.calls[2]?.[4] ?? [])).toEqual({
      fields: "quota_usage,config",
    });
  });
  it("does not infer actual native grants from the authorization request", async () => {
    safeError(
      await new MetaAccountClient("instagram_native", application)
        .connect({ ...instagramCode, scopes: "instagram_business_basic" })
        .catch((e) => e),
      "provider",
    );
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { ...instagramIdentity, id: "9999" },
    { ...instagramIdentity, user_id: undefined },
    { ...instagramIdentity, account_type: "PERSONAL" },
  ])("refuses another or unconfirmed professional account %j", async (identity) => {
    request.mockResolvedValueOnce(long).mockResolvedValueOnce(identity);
    await expect(
      new MetaAccountClient("instagram_native", application).connect(instagramCode),
    ).rejects.toBeInstanceOf(MetaOAuthClientError);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("keeps a missing publishing-capability response inconclusive", async () => {
    request
      .mockResolvedValueOnce(long)
      .mockResolvedValueOnce(instagramIdentity)
      .mockResolvedValueOnce({ data: [] });
    safeError(
      await new MetaAccountClient("instagram_native", application)
        .connect(instagramCode)
        .catch((e) => e),
    );
  });
});

describe("Facebook Page discovery for explicit user selection", () => {
  function firstReads(proof = facebookProof(), actualPermissions: unknown = permissions) {
    request
      .mockResolvedValueOnce(long)
      .mockResolvedValueOnce(proof)
      .mockResolvedValueOnce(actualPermissions);
  }
  it("keeps exact Page/User tokens internal and excludes Pages without create tasks", async () => {
    firstReads();
    request.mockResolvedValueOnce({ data: [page("111"), page("222", ["MODERATE"]), page("333")] });
    expect(await new MetaAccountClient("facebook_page", application).connect(short)).toEqual({
      pages: [
        {
          account: "Journal 111",
          target: "facebook-page:111",
          applicationId: application.clientId,
          credentials: {
            accessToken: "synthetic-page-token-111",
            userAccessToken: longToken,
            pageId: "111",
            scopes: "pages_manage_posts pages_read_engagement pages_show_list",
            expiresAt: "2026-10-07T02:00:00.000Z",
          },
        },
        {
          account: "Journal 333",
          target: "facebook-page:333",
          applicationId: application.clientId,
          credentials: {
            accessToken: "synthetic-page-token-333",
            userAccessToken: longToken,
            pageId: "333",
            scopes: "pages_manage_posts pages_read_engagement pages_show_list",
            expiresAt: "2026-10-07T02:00:00.000Z",
          },
        },
      ],
    });
    expect(request.mock.calls[1]?.[2]).toBe(`${application.clientId}|${application.clientSecret}`);
    expect(Object.fromEntries(request.mock.calls[3]?.[4] ?? [])).toEqual({
      fields: "id,name,access_token,tasks",
      limit: "50",
    });
  });
  it("refuses tokens issued by a different application", async () => {
    firstReads(facebookProof({ app_id: "9999" }));
    safeError(
      await new MetaAccountClient("facebook_page", application).connect(short).catch((e) => e),
      "provider",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([
    { data: permissions.data.map((grant) => ({ ...grant, status: "declined" })) },
    { data: [permissions.data[0], ...permissions.data] },
    { data: permissions.data.slice(1) },
  ])("refuses declined, ambiguous or missing current grants", async (actualPermissions) => {
    firstReads(facebookProof(), actualPermissions);
    safeError(
      await new MetaAccountClient("facebook_page", application).connect(short).catch((e) => e),
      "provider",
    );
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("uses fixed accounts reads with provider cursors rather than fetching a returned URL", async () => {
    firstReads();
    request
      .mockResolvedValueOnce({
        data: [page("111")],
        paging: {
          next: "https://graph.facebook.com/v26.0/me/accounts?after=cursor&access_token=ignored",
          cursors: { after: "cursor" },
        },
      })
      .mockResolvedValueOnce({ data: [page("222")] });
    const result = await new MetaAccountClient("facebook_page", application).connect(short);
    expect(result).toHaveProperty("pages.length", 2);
    expect(request.mock.calls[4]?.[1]).toBe("v26.0/me/accounts");
    expect(Object.fromEntries(request.mock.calls[4]?.[4] ?? [])).toEqual({
      fields: "id,name,access_token,tasks",
      limit: "50",
      after: "cursor",
    });
  });
  it.each([
    "https://other.example/v26.0/me/accounts",
    "https://graph.facebook.com/v26.0/other",
    "https://user:pass@graph.facebook.com/v26.0/me/accounts",
  ])("refuses unsafe or mismatched pagination %s without more I/O", async (next) => {
    firstReads();
    request.mockResolvedValueOnce({
      data: [page("111")],
      paging: { next, cursors: { after: "cursor" } },
    });
    safeError(
      await new MetaAccountClient("facebook_page", application).connect(short).catch((e) => e),
    );
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("refuses duplicate destinations instead of selecting one silently", async () => {
    firstReads();
    request.mockResolvedValueOnce({ data: [page("111"), page("111")] });
    safeError(
      await new MetaAccountClient("facebook_page", application).connect(short).catch((e) => e),
    );
  });
});

describe("Unusable lifecycle evidence", () => {
  it.each(["threads", "instagram_native", "facebook_page"] as const)(
    "refuses %s credentials that expire while awaiting the final identity read",
    async (provider) => {
      request.mockResolvedValueOnce({ ...long, expires_in: 1 });
      if (provider === "threads") {
        request.mockResolvedValueOnce(threadsProof()).mockImplementationOnce(async () => {
          vi.setSystemTime(now + 2000);
          return { id: "654321", username: "studio" };
        });
      } else if (provider === "instagram_native") {
        request.mockResolvedValueOnce(instagramIdentity).mockImplementationOnce(async () => {
          vi.setSystemTime(now + 2000);
          return quota;
        });
      } else {
        request
          .mockResolvedValueOnce(facebookProof())
          .mockResolvedValueOnce(permissions)
          .mockImplementationOnce(async () => {
            vi.setSystemTime(now + 2000);
            return { data: [page("111")] };
          });
      }
      safeError(
        await new MetaAccountClient(provider, application)
          .connect(provider === "instagram_native" ? instagramCode : short)
          .catch((e) => e),
      );
    },
  );
  it("refuses a username that echoes the original short-lived code token", async () => {
    request
      .mockResolvedValueOnce(long)
      .mockResolvedValueOnce(threadsProof())
      .mockResolvedValueOnce({ id: "654321", username: short.accessToken });
    safeError(await new MetaAccountClient("threads", application).connect(short).catch((e) => e));
  });
  it("refuses a Page label that echoes another discovered Page's token", async () => {
    request
      .mockResolvedValueOnce(long)
      .mockResolvedValueOnce(facebookProof())
      .mockResolvedValueOnce(permissions)
      .mockResolvedValueOnce({
        data: [
          { ...page("111"), name: "Journal synthetic-page-token-333" },
          page("333", ["MODERATE"]),
        ],
      });
    safeError(
      await new MetaAccountClient("facebook_page", application).connect(short).catch((e) => e),
    );
  });
  it("preserves a known credential or permission refusal without retaining provider details", async () => {
    request.mockRejectedValue(
      new PlatformRejectionError(`${longToken} ${application.clientSecret}`, 400),
    );
    safeError(
      await new MetaAccountClient("instagram_native", application)
        .connect(instagramCode)
        .catch((e) => e),
      "provider",
    );
  });
  it("keeps a transient provider read failure inconclusive and redacted", async () => {
    request.mockRejectedValue(
      new TransientPublishError(`${longToken} ${application.clientSecret}`, 503),
    );
    safeError(await new MetaAccountClient("threads", application).connect(short).catch((e) => e));
  });
  it.each(["3600junk", "3600", 0, -1, 1.5, Number.MAX_SAFE_INTEGER])(
    "never fabricates an expiry from %s",
    async (expires_in) => {
      request.mockResolvedValueOnce({ ...long, expires_in });
      safeError(await new MetaAccountClient("threads", application).connect(short).catch((e) => e));
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("discards parser and transport details that contain secrets", async () => {
    request.mockRejectedValue(new Error(`${application.clientSecret} ${longToken}`));
    safeError(
      await new MetaAccountClient("facebook_page", application).connect(short).catch((e) => e),
    );
  });
});
