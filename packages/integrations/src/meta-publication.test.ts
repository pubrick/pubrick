import { guardedFetch } from "guarded-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { instagramNativeStagedPublisher } from "./instagram-native.js";
import { instagramCredentialTarget, threadsCredentialsSchema } from "./meta-credentials.js";
import { META_REQUEST_TIMEOUT_MS, metaRequest } from "./meta-transport.js";
import { getStagedPublisher } from "./staged-registry.js";
import { type StagedPreparation, UnknownPreparationError } from "./staged-types.js";
import { threadsStagedPublisher } from "./threads.js";
import {
  AcceptedPublicationError,
  PermanentPublishError,
  PlatformRejectionError,
  TransientPublishError,
  UnknownOutcomePublishError,
} from "./types.js";

vi.mock("guarded-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("guarded-fetch")>()),
  guardedFetch: vi.fn(),
}));
const network = vi.mocked(guardedFetch);
const credentials = {
  accessToken: "fixture-meta-secret",
  accountId: "12345",
  scopes: "fake_claim",
  expiresAt: "2099-01-01T00:00:00Z",
};
const container = { containerId: "99887" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const orgId = "fixture-org";
const id = "00000000-0000-4000-8000-000000000001";
function preparation(platform: "threads" | "instagram_native" = "threads"): StagedPreparation {
  const deadlineAt = new Date(Date.now() + 300_000).toISOString();
  const mediaId = "00000000-0000-4000-8000-000000000005";
  const sha256 = "a".repeat(64);
  return {
    identity: {
      orgId,
      brandId: id,
      adaptationId: id,
      channelId: id,
      attempt: 1,
      inputHash: "b".repeat(64),
      target: platform === "threads" ? "threads:12345" : "instagram:12345",
      credentialGeneration: 1,
    },
    input: {
      version: 1,
      platform,
      text: "Reviewed & literal + text",
      ...(platform === "instagram_native"
        ? {
            image: {
              mediaId,
              sha256,
              mimeType: "image/jpeg",
              width: 1080,
              height: 1080,
              byteSize: 12345,
            },
          }
        : {}),
    },
    deadlineAt,
    ...(platform === "instagram_native"
      ? {
          imageCapability: {
            url: "https://media.example.com/approved/fixture?capability=fixture-bearer",
            expiresAt: deadlineAt,
            orgId,
            adaptationId: id,
            attempt: 1,
            mediaId,
            sha256,
            purpose: "meta_preparation",
          },
        }
      : {}),
  };
}
const igOptions = { approvedMediaOrigin: "https://media.example.com" };
const threadsApplication = { clientId: "445566", clientSecret: "fixture-threads-app-secret" };
const threadsOptions = { threads: threadsApplication };
const debug = () => ({
  data: {
    type: "USER",
    is_valid: true,
    user_id: credentials.accountId,
    scopes: ["threads_basic", "threads_content_publish"],
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  },
});
const identity = { id: credentials.accountId, username: "fixture_writer" };
const limit = { data: [{ quota_usage: 0, config: { quota_total: 100, quota_duration: 86400 } }] };
beforeEach(() => network.mockReset());

describe("explicit staged registry", () => {
  it("keeps stages separate from direct publish and refuses prototype keys", () => {
    expect(getStagedPublisher("threads")).toBe(threadsStagedPublisher);
    expect(getStagedPublisher("instagram_native")).toBe(instagramNativeStagedPublisher);
    for (const name of ["instagram", "facebook_page", "constructor", "toString", "__proto__"])
      expect(getStagedPublisher(name)).toBeUndefined();
    expect("publish" in threadsStagedPublisher).toBe(false);
  });
  it("refuses structured secret bags and noncanonical account IDs", () => {
    expect(
      threadsCredentialsSchema.safeParse({ ...credentials, scopes: ["threads_content_publish"] })
        .success,
    ).toBe(false);
    expect(
      threadsCredentialsSchema.safeParse({ ...credentials, accountId: "../other" }).success,
    ).toBe(false);
    expect(instagramCredentialTarget(credentials)).toBe("instagram:12345");
  });
});

describe("Threads actual provider grant and nonpublic stages", () => {
  it("checks actual grants/expiry and personal identity without trusting saved metadata", async () => {
    network.mockResolvedValueOnce(response(debug())).mockResolvedValueOnce(response(identity));
    await expect(threadsStagedPublisher.verify(credentials, threadsOptions)).resolves.toEqual({
      ok: true,
      account: "fixture_writer",
      target: "threads:12345",
    });
    expect(network).toHaveBeenCalledTimes(2);
    const [url, options] = network.mock.calls[0] ?? [];
    expect(new URL(String(url)).origin).toBe("https://graph.threads.com");
    expect(options).toMatchObject({
      method: "GET",
      allowedHosts: ["graph.threads.com"],
      httpsOnly: true,
      followRedirects: false,
      timeoutMs: META_REQUEST_TIMEOUT_MS,
      opaqueErrors: true,
    });
    expect(new URL(String(url)).searchParams.get("input_token")).toBe(credentials.accessToken);
    expect(new URL(String(url)).searchParams.toString()).not.toContain(
      threadsApplication.clientSecret,
    );
    expect(options?.headers).toMatchObject({
      Authorization: `Bearer TH|${threadsApplication.clientId}|${threadsApplication.clientSecret}`,
    });
    expect(network.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${credentials.accessToken}`,
    });
  });
  it.each(["missing_permission", "wrong_identity", "expired", "invalid"])(
    "refuses %s provider proof",
    async (kind) => {
      const proof = debug();
      if (kind === "missing_permission") proof.data.scopes = ["threads_basic"];
      if (kind === "wrong_identity") proof.data.user_id = "777";
      if (kind === "expired") proof.data.expires_at = 1;
      if (kind === "invalid") Object.assign(proof.data, { is_valid: false });
      network.mockResolvedValueOnce(response(proof));
      await expect(
        threadsStagedPublisher.verify(credentials, threadsOptions),
      ).resolves.toMatchObject({
        ok: false,
      });
      expect(network).toHaveBeenCalledTimes(1);
    },
  );
  it.each([undefined, { clientId: "not-an-app-id", clientSecret: "fixture-app-secret" }])(
    "does not inspect ordinary users with their own token when application config is missing or invalid",
    async (application) => {
      await expect(
        threadsStagedPublisher.verify(credentials, { threads: application }),
      ).resolves.toMatchObject({ ok: false });
      expect(network).not.toHaveBeenCalled();
    },
  );
  it.each(["wrong_type", "missing_valid", "string_valid"])(
    "does not infer a healthy user token from %s provider proof",
    async (kind) => {
      const proof: Record<string, unknown> = { ...debug().data };
      if (kind === "wrong_type") proof.type = "APP";
      if (kind === "missing_valid") delete proof.is_valid;
      if (kind === "string_valid") proof.is_valid = "true";
      network.mockResolvedValueOnce(response({ data: proof }));
      await expect(
        threadsStagedPublisher.verify(credentials, threadsOptions),
      ).resolves.toMatchObject({
        ok: false,
        indeterminate: true,
      });
      expect(network).toHaveBeenCalledTimes(1);
    },
  );
  it("redacts a same-app inspection refusal before any identity read", async () => {
    network.mockResolvedValueOnce(
      response(
        {
          error: {
            code: 190,
            type: "OAuthException",
            message: `Wrong app ${threadsApplication.clientSecret} and token ${credentials.accessToken}`,
          },
        },
        400,
      ),
    );
    const verdict = await threadsStagedPublisher.verify(credentials, threadsOptions);
    expect(verdict.ok).toBe(false);
    expect(JSON.stringify(verdict)).not.toContain(threadsApplication.clientSecret);
    expect(JSON.stringify(verdict)).not.toContain(credentials.accessToken);
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("does not infer a healthy grant from an identity read or saved scope string", async () => {
    network.mockResolvedValueOnce(response({ data: { user_id: credentials.accountId } }));
    await expect(
      threadsStagedPublisher.verify(
        {
          ...credentials,
          scopes: "threads_basic,threads_content_publish",
        },
        threadsOptions,
      ),
    ).resolves.toMatchObject({ ok: false, indeterminate: true });
  });
  it("explicitly disables automatic text publication and retains only a container receipt", async () => {
    network.mockResolvedValueOnce(response({ id: container.containerId }));
    await expect(threadsStagedPublisher.prepare(credentials, preparation())).resolves.toEqual(
      container,
    );
    const [url, options] = network.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://graph.threads.com/me/threads");
    expect(options?.method).toBe("POST");
    expect(options?.body).toEqual(
      new URLSearchParams({
        media_type: "TEXT",
        text: "Reviewed & literal + text",
        auto_publish_text: "false",
      }),
    );
    expect(String(url)).not.toContain(credentials.accessToken);
  });
  it.each(["image", "video", "long_text", "wrong_target", "expired"])(
    "rejects %s before any side effect",
    async (kind) => {
      const input = preparation();
      if (kind === "image") input.input.image = preparation("instagram_native").input.image;
      if (kind === "video") Object.assign(input.input, { video: { bytes: "unsupported" } });
      if (kind === "long_text") input.input.text = "x".repeat(501);
      if (kind === "wrong_target") input.identity.target = "threads:777";
      if (kind === "expired") input.deadlineAt = "2000-01-01T00:00:00Z";
      await expect(threadsStagedPublisher.prepare(credentials, input)).rejects.toBeInstanceOf(
        PermanentPublishError,
      );
      expect(network).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["IN_PROGRESS", "processing"],
    ["FINISHED", "ready"],
    ["ERROR", "rejected"],
    ["EXPIRED", "expired"],
    ["PUBLISHED", "published_without_receipt"],
  ])("maps %s without inventing a post receipt", async (providerStatus, status) => {
    network.mockResolvedValueOnce(
      response({
        id: container.containerId,
        status: providerStatus,
        error_message: credentials.accessToken,
      }),
    );
    await expect(threadsStagedPublisher.inspect(credentials, container)).resolves.toEqual({
      status,
    });
    expect(network.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(new URL(String(network.mock.calls[0]?.[0])).searchParams.get("fields")).toBe(
      "id,status,error_message",
    );
  });
  it("requires a real final receipt and never converts a container into a post", async () => {
    network.mockResolvedValueOnce(response({ id: "44556" }));
    await expect(threadsStagedPublisher.finalize(credentials, container)).resolves.toEqual({
      externalId: "44556",
      externalUrl: null,
    });
    network.mockResolvedValueOnce(response({ id: container.containerId }));
    await expect(threadsStagedPublisher.finalize(credentials, container)).rejects.toBeInstanceOf(
      UnknownOutcomePublishError,
    );
  });
});

describe("Instagram native identity, permission probe and approved JPEG", () => {
  it.each(["flat", "wrapped"])(
    "probes publishing access with %s professional identity, never the app-scoped ID",
    async (shape) => {
      const account = {
        id: "998811",
        user_id: credentials.accountId,
        username: "fixture_writer",
        account_type: "BUSINESS",
      };
      network
        .mockResolvedValueOnce(response(shape === "flat" ? account : { data: [account] }))
        .mockResolvedValueOnce(response(limit));
      await expect(instagramNativeStagedPublisher.verify(credentials)).resolves.toEqual({
        ok: true,
        account: "fixture_writer",
        target: "instagram:12345",
      });
      expect(String(network.mock.calls[1]?.[0])).toContain("/v26.0/12345/content_publishing_limit");
      expect(
        network.mock.calls.every(([url]) => String(url).startsWith("https://graph.instagram.com/")),
      ).toBe(true);
    },
  );
  it("rejects ambiguous identities and never falls back to another account", async () => {
    network.mockResolvedValueOnce(
      response({
        data: [
          { user_id: "777", username: "other" },
          { user_id: credentials.accountId, username: "fixture_writer" },
        ],
      }),
    );
    await expect(instagramNativeStagedPublisher.verify(credentials)).resolves.toMatchObject({
      ok: false,
      indeterminate: true,
    });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("rejects competing flat and wrapped account identities before the permission probe", async () => {
    network.mockResolvedValueOnce(
      response({
        user_id: credentials.accountId,
        username: "fixture_writer",
        data: [{ user_id: "777", username: "other" }],
      }),
    );
    await expect(instagramNativeStagedPublisher.verify(credentials)).resolves.toMatchObject({
      ok: false,
      indeterminate: true,
    });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it("does not call native publishing healthy when the permission probe is refused", async () => {
    network
      .mockResolvedValueOnce(
        response({ user_id: credentials.accountId, username: "fixture_writer" }),
      )
      .mockResolvedValueOnce(
        response(
          { error: { code: 10, type: "OAuthException", message: credentials.accessToken } },
          403,
        ),
      );
    const result = await instagramNativeStagedPublisher.verify(credentials);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(credentials.accessToken);
  });
  it("prepares the exact approved caption and capability only, with no automatic publish option", async () => {
    const input = preparation("instagram_native");
    network.mockResolvedValueOnce(response({ id: container.containerId }));
    await expect(
      instagramNativeStagedPublisher.prepare(credentials, input, igOptions),
    ).resolves.toEqual(container);
    const [url, options] = network.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://graph.instagram.com/v26.0/12345/media");
    expect(options?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(options?.body))).toEqual({
      image_url: input.imageCapability?.url ?? "",
      caption: input.input.text,
    });
    expect(String(options?.body)).not.toContain("auto_publish");
    expect(String(url)).not.toContain("fixture-bearer");
  });
  it.each([
    "missing",
    "byte_size",
    "narrow",
    "ratio",
    "wrong_attempt",
    "wrong_digest",
    "wrong_origin",
    "expired",
    "beyond_deadline",
    "caption",
    "mentions",
    "hashtags",
  ])("rejects %s JPEG admission before HTTP", async (kind) => {
    const input = preparation("instagram_native");
    const image = input.input.image;
    const capability = input.imageCapability;
    if (!image || !capability) throw new Error("Fixture image is missing");
    if (kind === "missing") delete input.input.image;
    if (kind === "byte_size") image.byteSize = 8_000_001;
    if (kind === "narrow") image.width = 319;
    if (kind === "ratio") image.height = 2000;
    if (kind === "wrong_attempt") capability.attempt = 2;
    if (kind === "wrong_digest") capability.sha256 = "c".repeat(64);
    if (kind === "wrong_origin") capability.url = "https://other.example.com/approved/fixture";
    if (kind === "expired") capability.expiresAt = "2000-01-01T00:00:00Z";
    if (kind === "beyond_deadline")
      capability.expiresAt = new Date(Date.now() + 600_000).toISOString();
    if (kind === "caption") input.input.text = "x".repeat(2201);
    if (kind === "mentions") input.input.text = "@user ".repeat(21);
    if (kind === "hashtags") input.input.text = "#tag ".repeat(31);
    await expect(
      instagramNativeStagedPublisher.prepare(credentials, input, igOptions),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(network).not.toHaveBeenCalled();
  });
  it.each([
    ["IN_PROGRESS", "processing"],
    ["FINISHED", "ready"],
    ["ERROR", "rejected"],
    ["EXPIRED", "expired"],
    ["PUBLISHED", "published_without_receipt"],
  ])("reads status_code %s on the native endpoint", async (providerStatus, status) => {
    network.mockResolvedValueOnce(response({ status_code: providerStatus }));
    await expect(instagramNativeStagedPublisher.inspect(credentials, container)).resolves.toEqual({
      status,
    });
    expect(String(network.mock.calls[0]?.[0])).toBe(
      "https://graph.instagram.com/v26.0/99887?fields=status_code",
    );
  });
  it("finalizes the saved container using the documented native JSON body", async () => {
    network.mockResolvedValueOnce(response({ id: "44556" }));
    await expect(instagramNativeStagedPublisher.finalize(credentials, container)).resolves.toEqual({
      externalId: "44556",
      externalUrl: null,
    });
    const [url, options] = network.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://graph.instagram.com/v26.0/12345/media_publish");
    expect(options?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(options?.body))).toEqual({ creation_id: container.containerId });
  });
});

describe("side-effect classification and redaction", () => {
  it.each([
    "https://other.example.com/me",
    "https://user:fixture-secret@graph.threads.com/me",
    "https://graph.threads.com/me#fixture-secret",
    "https://[invalid]/fixture-secret",
  ])("refuses an unsafe API path before HTTP", async (path) => {
    const error = await metaRequest(
      "https://graph.threads.com",
      path,
      credentials.accessToken,
      "read",
      new URLSearchParams(),
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(PermanentPublishError);
    expect((error as Error).message).not.toContain("fixture-secret");
    expect(network).not.toHaveBeenCalled();
  });
  it("pins official origins at runtime as well as in the TypeScript contract", async () => {
    await expect(
      metaRequest(
        "https://other.example.com" as never,
        "me",
        credentials.accessToken,
        "read",
        new URLSearchParams(),
      ),
    ).rejects.toBeInstanceOf(PermanentPublishError);
    expect(network).not.toHaveBeenCalled();
  });
  it.each(["threads", "instagram_native"])(
    "keeps %s lost preparation distinct from a public send",
    async (platform) => {
      network.mockRejectedValueOnce(new Error(`opaque socket failure ${credentials.accessToken}`));
      const publisher =
        platform === "threads" ? threadsStagedPublisher : instagramNativeStagedPublisher;
      const failure = await publisher
        .prepare(credentials, preparation(publisher.platform), igOptions)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UnknownPreparationError);
      expect(failure).not.toBeInstanceOf(UnknownOutcomePublishError);
      expect((failure as Error).message).not.toContain(credentials.accessToken);
    },
  );
  it.each(["network", "gateway", "malformed", "missing_receipt", "five_hundred", "redirect"])(
    "keeps final %s unknown with no transport retry",
    async (kind) => {
      if (kind === "network")
        network.mockRejectedValueOnce(new Error(`socket lost ${credentials.accessToken}`));
      if (kind === "gateway")
        network.mockResolvedValueOnce(new Response("gateway HTML", { status: 429 }));
      if (kind === "malformed") network.mockResolvedValueOnce(new Response("{", { status: 200 }));
      if (kind === "missing_receipt") network.mockResolvedValueOnce(response({ ok: true }));
      if (kind === "five_hundred")
        network.mockResolvedValueOnce(
          response(
            { error: { code: 1, type: "Exception", message: credentials.accessToken } },
            503,
          ),
        );
      if (kind === "redirect")
        network.mockResolvedValueOnce(
          new Response("", { status: 302, headers: { location: "https://other.example.com/" } }),
        );
      const failure = await threadsStagedPublisher
        .finalize(credentials, container)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(UnknownOutcomePublishError);
      expect((failure as Error).message).not.toContain(credentials.accessToken);
      expect(network).toHaveBeenCalledTimes(1);
    },
  );
  it("knows refusal only from an explicit provider envelope and rate code", async () => {
    network.mockResolvedValueOnce(
      response(
        { error: { code: 4, type: "OAuthException", message: credentials.accessToken } },
        429,
      ),
    );
    await expect(threadsStagedPublisher.finalize(credentials, container)).rejects.toBeInstanceOf(
      TransientPublishError,
    );
    network.mockResolvedValueOnce(
      response(
        { error: { code: 190, type: "OAuthException", message: credentials.accessToken } },
        401,
      ),
    );
    await expect(threadsStagedPublisher.finalize(credentials, container)).rejects.toBeInstanceOf(
      PlatformRejectionError,
    );
  });
  it("retains an actual accepted record without calling it published", async () => {
    network.mockResolvedValueOnce(response({ id: "44556", status: "DRAFT" }));
    const error = await threadsStagedPublisher
      .finalize(credentials, container)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AcceptedPublicationError);
    expect((error as AcceptedPublicationError).receipt).toEqual({
      externalId: "44556",
      externalUrl: null,
    });
  });
  it.each(["threads", "instagram_native"])(
    "retains a real %s receipt when an explicit status is malformed",
    async (platform) => {
      network.mockResolvedValueOnce(
        response({ id: "44556", [platform === "threads" ? "status" : "status_code"]: null }),
      );
      const publisher =
        platform === "threads" ? threadsStagedPublisher : instagramNativeStagedPublisher;
      const error = await publisher
        .finalize(credentials, container)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AcceptedPublicationError);
      expect((error as AcceptedPublicationError).receipt.externalId).toBe("44556");
      expect(network).toHaveBeenCalledTimes(1);
    },
  );
});
