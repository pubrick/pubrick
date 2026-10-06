import { describe, expect, it } from "vitest";
import {
  inboxCollectSchema,
  inboxOlderSchema,
  inboxPageQuerySchema,
  inboxQuerySchema,
  inboxReplyResolutionSchema,
  inboxReplySchema,
  inboxStateSchema,
} from "./inbox.js";

const id = "7c5d37a7-fde5-4118-a5a1-2272a3e88e4a";
const reply = {
  operationKey: id,
  senderPreviewId: id,
  messageId: id,
  expectedMessageRevision: 3,
  expectedMessageFingerprint: "a".repeat(64),
  body: "Reviewed human reply.",
};
describe("supported conversation inbox contracts", () => {
  it("preserves the complete reviewed reply request and requires one-use sender proof", () => {
    expect(inboxReplySchema.parse(reply)).toEqual(reply);
    const { senderPreviewId: _omitted, ...without } = reply;
    expect(inboxReplySchema.safeParse(without).success).toBe(false);
    expect(inboxReplySchema.safeParse({ ...reply, expectedMessageRevision: -1 }).success).toBe(
      false,
    );
    expect(inboxReplySchema.safeParse({ ...reply, externalUrl: "https://evil.test" }).success).toBe(
      false,
    );
  });
  it("normalizes reply newlines before bounding the saved text", () => {
    expect(inboxReplySchema.parse({ ...reply, body: "One.\r\nTwo.\rThree." }).body).toBe(
      "One.\nTwo.\nThree.",
    );
    expect(inboxReplySchema.parse({ ...reply, body: "x\r\n".repeat(2000) }).body).toBe(
      "x\n".repeat(2000),
    );
  });
  it.each(["", "   ", "\u0000", "a".repeat(4001)])(
    "refuses empty, unsafe or oversized human text",
    (body) => expect(inboxReplySchema.safeParse({ ...reply, body }).success).toBe(false),
  );
  it("keeps read and resolve decisions bound to the collected activity revision", () => {
    const input = { action: "resolve", expectedActivityRevision: 7 };
    expect(inboxStateSchema.parse(input)).toEqual(input);
    expect(inboxStateSchema.safeParse({ action: "resolve" }).success).toBe(false);
    expect(inboxOlderSchema.parse({ expectedCollectionRevision: 2 })).toEqual({
      expectedCollectionRevision: 2,
    });
    expect(inboxCollectSchema.parse({ publicationId: id })).toEqual({ publicationId: id });
  });
  it("requires explicit provider inspection and original account verification for settlement", () => {
    const input = {
      senderPreviewId: id,
      expectedStatus: "unknown",
      outcome: "not_sent",
      inspectedProvider: true,
    };
    expect(inboxReplyResolutionSchema.parse(input)).toEqual(input);
    expect(
      inboxReplyResolutionSchema.safeParse({ ...input, inspectedProvider: false }).success,
    ).toBe(false);
    expect(inboxReplyResolutionSchema.safeParse({ ...input, expectedStatus: "sent" }).success).toBe(
      false,
    );
  });
  it("bounds cursors and applies supported filters server-side", () => {
    expect(inboxQuerySchema.parse({})).toEqual({ filter: "open" });
    expect(inboxQuerySchema.parse({ filter: "resolved", cursor: "scoped" })).toEqual({
      filter: "resolved",
      cursor: "scoped",
    });
    expect(inboxPageQuerySchema.safeParse({ cursor: "x".repeat(1025) }).success).toBe(false);
    expect(inboxQuerySchema.safeParse({ filter: "dm" }).success).toBe(false);
  });
});
