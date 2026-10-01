import {
  PAID_GENERATION_CONSENT_VERSION,
  publicDraftCreateSchema,
  publicRunCreateSchema,
} from "@pubrick/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createPublicContentClient,
  createPublicDraftWriteClient,
  createPublicGenerationClient,
  createPublicPublicationClient,
  loadConfig,
  validateBaseUrl,
} from "./api.js";

const id = "90ebcfc4-e20a-4b03-8501-0e883767a137";
const brandId = "0d139af6-c7a0-46f8-bfb7-b4111d8c3121";
const channelId = "d6ab65a0-8145-4a22-82fa-956042f43c2a";
const config = {
  baseUrl: validateBaseUrl("https://pubrick.example/mount"),
  apiKey: "pbrk_write_fixture",
};
const draft = { brandId, channelIds: [channelId], body: "Imported draft" };
const run = {
  brandId,
  channelIds: [channelId],
  brief: "Make a post",
  allowPaidGeneration: true as const,
  consentVersion: PAID_GENERATION_CONSENT_VERSION,
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
describe("scoped write transport", () => {
  it("requires explicit version and keeps dedicated keys separate", () => {
    const env = {
      PUBRICK_API_BASE_URL: "https://pubrick.example",
      PUBRICK_API_KEY: "read_fixture",
      PUBRICK_CONTENT_CREATE_API_KEY: "draft_fixture",
      PUBRICK_GENERATION_API_KEY: "generation_fixture",
    };
    expect(() => loadConfig(env)).toThrow("explicit");
    expect(loadConfig({ ...env, PUBRICK_API_VERSION: "v2" })).toMatchObject({
      apiVersion: "v2",
      apiKey: "read_fixture",
      contentCreateApiKey: "draft_fixture",
      generationApiKey: "generation_fixture",
    });
    expect(() =>
      loadConfig({
        ...env,
        PUBRICK_API_VERSION: "v2",
        PUBRICK_GENERATION_API_KEY: "private\nsecret",
      }),
    ).toThrow("single-line");
  });
  it("forwards exact validated body and stable key without automatic retry", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("secret URL/token"))
      .mockResolvedValueOnce(
        json({ id, status: "draft", origin: "external", requiresReview: true }),
      );
    const client = createPublicDraftWriteClient(config, fetcher);
    await expect(client.create(draft, "operation.123")).rejects.toThrow("outcome is unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(client.create(draft, "operation.123")).resolves.toMatchObject({
      id,
      status: "draft",
    });
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://pubrick.example/mount/api/v2/content");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      credentials: "omit",
      headers: {
        Authorization: "Bearer pbrk_write_fixture",
        "Idempotency-Key": "operation.123",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual(draft);
    expect(publicDraftCreateSchema.parse(JSON.parse(String(init?.body)))).toEqual(draft);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(init?.body);
  });
  it("refuses missing consent/unknown fields/invalid keys before dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createPublicGenerationClient(config, fetcher);
    expect(() =>
      client.create({ ...run, allowPaidGeneration: false } as never, "operation.123"),
    ).toThrow("consent");
    expect(() => client.create({ ...run, provider: "google" } as never, "operation.123")).toThrow(
      "input",
    );
    await expect(
      createPublicDraftWriteClient(config, fetcher).create(draft, "short"),
    ).rejects.toThrow("idempotency");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses generation key for paid create and polling; preserves unknown cost", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ id, status: "queued" }))
      .mockResolvedValueOnce(
        json({
          id,
          status: "succeeded",
          contentItemId: null,
          error: null,
          cost: { status: "unknown" },
        }),
      );
    const client = createPublicGenerationClient(
      { ...config, apiKey: "generation_fixture" },
      fetcher,
    );
    await client.create(run, "operation.123");
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(payload).toEqual(run);
    expect(publicRunCreateSchema.parse(payload)).toEqual(payload);
    await expect(client.get(id)).resolves.toMatchObject({ cost: { status: "unknown" } });
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer generation_fixture",
    });
  });
  it.each([
    () => json({ id, status: "approved" }),
    () => new Response("<secret>"),
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("private key"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  ])(
    "reports unknown outcome on malformed/body-failed success without leaking payload",
    async (response) => {
      const fetcher = vi.fn<typeof fetch>(async () => response());
      await await expect(
        createPublicDraftWriteClient(config, fetcher).create(draft, "operation.123"),
      ).rejects.toThrow("SAME idempotency key");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it("reads external v2 envelope while publications stay v1", async () => {
    const summary = {
      id,
      brandId,
      title: null,
      status: "draft",
      origin: "external",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ rows: [summary], nextCursor: "v2.content.fixture" }))
      .mockResolvedValueOnce(json([]));
    await expect(
      createPublicContentClient({ ...config, apiVersion: "v2" }, fetcher).list(),
    ).resolves.toEqual({ items: [summary], nextCursor: "v2.content.fixture" });
    await createPublicPublicationClient({ ...config, apiKey: "publication_fixture" }, fetcher).list(
      { brandId },
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/api/v2/content");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("/api/v1/brands/");
  });
  it.each([
    [409, "idempotency_conflict", "different payload"],
    [410, "public_result_gone", "deleted"],
    [409, "public_operation_capacity", "capacity"],
  ] as const)("shows sanitized actionable refusal %s/%s", async (status, code, hint) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({ code, message: "PRIVATE PROVIDER TOKEN" }, status),
    );
    const promise = createPublicDraftWriteClient(config, fetcher).create(draft, "operation.123");
    await expect(promise).rejects.toThrow(hint);
    await expect(promise).rejects.not.toThrow("PRIVATE");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    "preserves explicit estimated=%s in known cost projections",
    async (estimated) => {
      const result = {
        id,
        status: "succeeded",
        contentItemId: null,
        error: null,
        cost: { status: "known", amountUsd: "0.0123", estimated },
      };
      const fetcher = vi.fn<typeof fetch>(async () => json(result));
      await expect(createPublicGenerationClient(config, fetcher).get(id)).resolves.toEqual(result);
    },
  );
  it("refuses unlabelled known costs instead of presenting an estimate as billed", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      json({
        id,
        status: "succeeded",
        contentItemId: null,
        error: null,
        cost: { status: "known", amountUsd: "0.0123" },
      }),
    );
    await expect(createPublicGenerationClient(config, fetcher).get(id)).rejects.toThrow(
      "invalid run status",
    );
  });
});
