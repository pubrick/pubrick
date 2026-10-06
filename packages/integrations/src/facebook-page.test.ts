import { guardedFetch } from "guarded-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FACEBOOK_PAGE_MAX_DISCOVERY_PAGES, facebookPagePublisher } from "./facebook-page.js";
import {
  AcceptedPublicationError,
  PermanentPublishError,
  type PublisherOptions,
  UnknownOutcomePublishError,
} from "./types.js";

vi.mock("guarded-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("guarded-fetch")>()),
  guardedFetch: vi.fn(),
}));
const network = vi.mocked(guardedFetch);
const credentials = {
  pageId: "12345",
  accessToken: "fixture-page-secret",
  userAccessToken: "fixture-user-secret",
  scopes: "claims_are_not_proof",
};
const application = { clientId: "88990", clientSecret: "fixture-application-secret" };
const options: PublisherOptions = { facebookPage: application };
const scopes = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const debug = (type: "USER" | "PAGE") => ({
  data: {
    is_valid: true,
    app_id: application.clientId,
    type,
    user_id: "66778",
    ...(type === "PAGE" ? { profile_id: credentials.pageId } : {}),
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    scopes,
  },
});
const identity = { id: credentials.pageId, name: "Fixture Page" };
const accounts = () => ({
  data: [{ id: credentials.pageId, tasks: ["ANALYZE", "CREATE_CONTENT"] }],
});
function proof(
  user: unknown = debug("USER"),
  page: unknown = debug("PAGE"),
  list: unknown = accounts(),
) {
  network
    .mockResolvedValueOnce(response(user))
    .mockResolvedValueOnce(response(page))
    .mockResolvedValueOnce(response(identity))
    .mockResolvedValueOnce(response(list));
}
beforeEach(() => network.mockReset());

describe("Facebook Page fresh app/permission/task proof", () => {
  it("verifies both encrypted tokens and the exact Page's actual CREATE_CONTENT task without creating", async () => {
    proof();
    await expect(facebookPagePublisher.verify(credentials, options)).resolves.toEqual({
      ok: true,
      account: "Fixture Page",
      target: "facebook-page:12345",
    });
    expect(network).toHaveBeenCalledTimes(4);
    expect(String(network.mock.calls[3]?.[0])).toBe(
      "https://graph.facebook.com/v26.0/me/accounts?fields=id%2Ctasks&limit=100",
    );
    expect(network.mock.calls[3]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${credentials.userAccessToken}`,
    });
    for (const [url, request] of network.mock.calls) {
      expect(new URL(String(url)).origin).toBe("https://graph.facebook.com");
      expect(request).toMatchObject({
        httpsOnly: true,
        allowedHosts: ["graph.facebook.com"],
        followRedirects: false,
        opaqueErrors: true,
      });
    }
  });
  it.each([
    "server_config",
    "wrong_app",
    "missing_scope",
    "expired",
    "wrong_token_type",
    "wrong_owner",
    "wrong_page",
    "wrong_granular_page",
    "missing_task",
    "missing_page",
    "ambiguous_page",
  ])("refuses %s rather than trusting saved metadata", async (kind) => {
    const user = debug("USER");
    const page = debug("PAGE");
    const list = accounts();
    if (kind === "wrong_app") user.data.app_id = "99880";
    if (kind === "missing_scope") page.data.scopes = ["pages_show_list"];
    if (kind === "expired") page.data.expires_at = 1;
    if (kind === "wrong_token_type") page.data.type = "USER";
    if (kind === "wrong_owner") page.data.user_id = "99900";
    if (kind === "wrong_page") page.data.profile_id = "99900";
    if (kind === "wrong_granular_page")
      Object.assign(page.data, {
        granular_scopes: [{ scope: "pages_manage_posts", target_ids: ["99900"] }],
      });
    if (kind === "missing_task") list.data = [{ id: credentials.pageId, tasks: ["ANALYZE"] }];
    if (kind === "missing_page") list.data = [{ id: "99900", tasks: ["CREATE_CONTENT"] }];
    if (kind === "ambiguous_page")
      list.data.push({ id: credentials.pageId, tasks: ["CREATE_CONTENT"] });
    proof(user, page, list);
    const result = await facebookPagePublisher.verify(
      credentials,
      kind === "server_config" ? {} : options,
    );
    expect(result.ok).toBe(false);
    for (const secret of [
      credentials.accessToken,
      credentials.userAccessToken,
      application.clientSecret,
    ])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(network.mock.calls.every(([, request]) => request?.method === "GET")).toBe(true);
  });
  it("allows provider-confirmed zero expiry without inventing a finite Page-token lifetime", async () => {
    const page = debug("PAGE");
    page.data.expires_at = 0;
    proof(debug("USER"), page);
    await expect(facebookPagePublisher.verify(credentials, options)).resolves.toMatchObject({
      ok: true,
    });
  });
  it("reconstructs cursor reads on the fixed official path without forwarding nextURL tokens", async () => {
    proof(debug("USER"), debug("PAGE"), {
      data: [],
      paging: {
        cursors: { after: "fixture-cursor" },
        next: "https://graph.facebook.com/v26.0/66778/accounts?after=fixture-cursor&access_token=should-not-be-forwarded",
      },
    });
    network.mockResolvedValueOnce(response(accounts()));
    await expect(facebookPagePublisher.verify(credentials, options)).resolves.toMatchObject({
      ok: true,
    });
    const [url, request] = network.mock.calls[4] ?? [];
    expect(String(url)).toBe(
      "https://graph.facebook.com/v26.0/me/accounts?fields=id%2Ctasks&limit=100&after=fixture-cursor",
    );
    expect(String(url)).not.toContain("access_token");
    expect(request?.headers).toMatchObject({
      Authorization: `Bearer ${credentials.userAccessToken}`,
    });
  });
  it.each(["host", "path", "no_cursor", "repeated_cursor", "truncated"])(
    "refuses %s continuation safely",
    async (kind) => {
      const next =
        kind === "host"
          ? "https://other.example.com/v26.0/me/accounts"
          : kind === "path"
            ? "https://graph.facebook.com/v26.0/other/feed"
            : "https://graph.facebook.com/v26.0/me/accounts";
      const page = {
        data: [],
        paging: { next, cursors: kind === "no_cursor" ? {} : { after: "cursor-1" } },
      };
      proof(debug("USER"), debug("PAGE"), page);
      if (kind === "repeated_cursor") network.mockResolvedValueOnce(response(page));
      if (kind === "truncated") {
        for (let index = 2; index <= FACEBOOK_PAGE_MAX_DISCOVERY_PAGES; index++)
          network.mockResolvedValueOnce(
            response({ data: [], paging: { next, cursors: { after: `cursor-${index}` } } }),
          );
      }
      await expect(facebookPagePublisher.verify(credentials, options)).resolves.toMatchObject({
        ok: false,
      });
      expect(
        network.mock.calls.every(([url]) =>
          String(url).startsWith("https://graph.facebook.com/v26.0/"),
        ),
      ).toBe(true);
      expect(network.mock.calls.length).toBeLessThanOrEqual(FACEBOOK_PAGE_MAX_DISCOVERY_PAGES + 3);
    },
  );
});

describe("direct Facebook Page text receipt", () => {
  it("rechecks the local send fence after provider proof and publishes the literal reviewed message", async () => {
    proof();
    network.mockResolvedValueOnce(response({ id: "12345_55667" }));
    const guard = vi.fn().mockResolvedValue(undefined);
    await expect(
      facebookPagePublisher.publish(
        credentials,
        { text: "Reviewed & literal + text" },
        { ...options, beforeFacebookPageCreate: guard },
      ),
    ).resolves.toEqual({ externalId: "12345_55667", externalUrl: null });
    expect(guard).toHaveBeenCalledOnce();
    expect(guard.mock.invocationCallOrder[0]).toBeGreaterThan(
      network.mock.invocationCallOrder[3] ?? 0,
    );
    expect(guard.mock.invocationCallOrder[0]).toBeLessThan(
      network.mock.invocationCallOrder[4] ?? 0,
    );
    const [url, request] = network.mock.calls[4] ?? [];
    expect(String(url)).toBe("https://graph.facebook.com/v26.0/12345/feed");
    expect(request?.body).toEqual(
      new URLSearchParams({ message: "Reviewed & literal + text", published: "true" }),
    );
    expect(String(request?.body)).not.toContain("scheduled_publish_time");
  });
  it.each(["image", "video", "empty"])("rejects %s before any provider call", async (kind) => {
    const input = {
      text: kind === "empty" ? "  " : "Reviewed text",
      ...(kind === "image"
        ? { image: { bytes: new Uint8Array([1]), mimeType: "image/jpeg" as const } }
        : {}),
      ...(kind === "video"
        ? { video: { bytes: new Uint8Array([1]), mimeType: "video/mp4" as const } }
        : {}),
    };
    await expect(facebookPagePublisher.publish(credentials, input, options)).rejects.toBeInstanceOf(
      PermanentPublishError,
    );
    expect(network).not.toHaveBeenCalled();
  });
  it("never creates when the local destination/grant changes during the preflight", async () => {
    proof();
    await expect(
      facebookPagePublisher.publish(
        credentials,
        { text: "Reviewed text" },
        {
          ...options,
          beforeFacebookPageCreate: async () => {
            throw new PermanentPublishError("connection changed");
          },
        },
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(network).toHaveBeenCalledTimes(4);
  });
  it.each(["network", "receipt", "wrong_page", "gateway"])(
    "keeps %s final outcome unknown and never resends",
    async (kind) => {
      proof();
      if (kind === "network")
        network.mockRejectedValueOnce(new Error(`lost ${credentials.accessToken}`));
      if (kind === "receipt") network.mockResolvedValueOnce(response({ success: true }));
      if (kind === "wrong_page") network.mockResolvedValueOnce(response({ id: "99880_55667" }));
      if (kind === "gateway")
        network.mockResolvedValueOnce(new Response("gateway", { status: 503 }));
      const error = await facebookPagePublisher
        .publish(credentials, { text: "Reviewed text" }, options)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(UnknownOutcomePublishError);
      expect((error as Error).message).not.toContain(credentials.accessToken);
      expect(network).toHaveBeenCalledTimes(5);
    },
  );
  it("preserves an accepted unpublished record instead of calling it published", async () => {
    proof();
    network.mockResolvedValueOnce(response({ id: "12345_55667", is_published: false }));
    const error = await facebookPagePublisher
      .publish(credentials, { text: "Reviewed text" }, options)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AcceptedPublicationError);
    expect((error as AcceptedPublicationError).receipt.externalId).toBe("12345_55667");
  });
  it("retains an actual record when an explicit published flag is malformed", async () => {
    proof();
    network.mockResolvedValueOnce(response({ id: "12345_55667", is_published: "false" }));
    const error = await facebookPagePublisher
      .publish(credentials, { text: "Reviewed text" }, options)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AcceptedPublicationError);
    expect((error as AcceptedPublicationError).receipt.externalId).toBe("12345_55667");
    expect(network).toHaveBeenCalledTimes(5);
  });
});
