import { publicDraftCreateSchema } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { publicIdempotencyKey, publicRequestHash } from "./public-request-hash";

const brandId = "11111111-1111-4111-8111-111111111111",
  channelId = "22222222-2222-4222-8222-222222222222";
describe("public parsed DTO identity", () => {
  it("hashes normalized parsed content rather than key order or newline spelling", () => {
    const a = publicDraftCreateSchema.parse({
      brandId,
      channelIds: [channelId],
      body: "One\r\nTwo",
    });
    const b = publicDraftCreateSchema.parse({ body: "One\nTwo", channelIds: [channelId], brandId });
    expect(publicRequestHash("content:create", a)).toBe(publicRequestHash("content:create", b));
    expect(publicRequestHash("content:create", a)).not.toBe(
      publicRequestHash("generation:create", a),
    );
    expect(publicRequestHash("content:create", a)).not.toBe(
      publicRequestHash("content:create", { ...a, body: "Changed" }),
    );
  });
  it("rejects runtime cycles, bigint and nonfinite values instead of producing lossy hashes", () => {
    const loop: { self?: unknown } = {};
    loop.self = loop;
    for (const input of [loop, { n: NaN }, { n: 1n }])
      expect(() => publicRequestHash("content:create", input)).toThrow();
  });
  it("refuses missing/duplicate/nonASCII headers and preserves case-sensitive identities", () => {
    expect(publicIdempotencyKey("fixture.ABC", ["Idempotency-Key", "fixture.ABC"])).toBe(
      "fixture.ABC",
    );
    for (const header of [undefined, "short", "ключ-1234", "fixture good"])
      expect(() => publicIdempotencyKey(header, [])).toThrow();
    expect(() =>
      publicIdempotencyKey("fixture.ABC", [
        "Idempotency-Key",
        "fixture.ABC",
        "idempotency-key",
        "fixture.ABC",
      ]),
    ).toThrow();
  });
});
