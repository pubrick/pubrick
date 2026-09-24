import { createHmac } from "node:crypto";
import type { guardedFetch } from "guarded-fetch";
import { describe, expect, it, vi } from "vitest";
import { postWebhook, signWebhook } from "./webhook-http";

describe("outgoing webhook HTTP boundary", () => {
  it("signs the exact JSON bytes and disables redirects on a bounded HTTPS request", async () => {
    const fake = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const envelope = {
      id: "a1d0880f-748d-4ca1-92e4-5f4d935effb8",
      event: "publication.succeeded",
      createdAt: "2026-09-24T12:00:00.000Z",
      data: { publicationId: "p1", status: "published" },
    };
    expect(
      await postWebhook(
        "https://hooks.example.com/events",
        "whsec_secret",
        envelope,
        fake as typeof guardedFetch,
      ),
    ).toBe(204);
    const [url, options] = fake.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("https://hooks.example.com/events");
    expect(options).toMatchObject({
      method: "POST",
      httpsOnly: true,
      followRedirects: false,
      timeoutMs: 5000,
      opaqueErrors: true,
    });
    expect(options.body).toBe(JSON.stringify(envelope));
    const headers = options.headers as Record<string, string>;
    expect(headers["X-Pubrick-Event-Id"]).toBe(envelope.id);
    expect(headers["X-Pubrick-Signature"]).toBe(
      `v1=${createHmac("sha256", "whsec_secret")
        .update(`${headers["X-Pubrick-Timestamp"]}.${options.body}`)
        .digest("hex")}`,
    );
  });

  it("makes a changed timestamp or raw body fail signature verification", () => {
    const original = signWebhook("secret", 123, '{"id":"one"}');
    expect(original).not.toBe(signWebhook("secret", 124, '{"id":"one"}'));
    expect(original).not.toBe(signWebhook("secret", 123, '{ "id":"one"}'));
  });
});
