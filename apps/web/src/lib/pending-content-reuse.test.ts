import { describe, expect, it } from "vitest";
import {
  getPendingContentReuse,
  retainPendingContentReuse,
  settlePendingContentReuse,
} from "./pending-content-reuse";

const target = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const body = {
  expectedSourceRevision: 3,
  expectedSourceDigest: "a".repeat(64),
  contentType: "social_post" as const,
  channelIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
  allowPaidGeneration: true as const,
  consentVersion: "byok-paid-generation-v1" as const,
};
function fixture(userId: string) {
  return {
    identity: { userId, orgId: "org" },
    request: {
      operation: "reuse" as const,
      targetId: target,
      key: crypto.randomUUID(),
      body: { ...body, channelIds: [...body.channelIds] },
    },
  };
}

describe("confirmed paid reuse registry", () => {
  it("canonicalizes UUIDs and isolates users, organizations, operations and targets", () => {
    const { identity, request } = fixture("isolation");
    retainPendingContentReuse(identity, request);
    expect(getPendingContentReuse(identity, "reuse", target.toLowerCase())?.key).toBe(request.key);
    expect(getPendingContentReuse({ ...identity, userId: "other" }, "reuse", target)).toBeNull();
    expect(getPendingContentReuse({ ...identity, orgId: "other" }, "reuse", target)).toBeNull();
    expect(getPendingContentReuse(identity, "reuse-retry", target)).toBeNull();
    expect(
      getPendingContentReuse(identity, "reuse", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    ).toBeNull();
    settlePendingContentReuse(identity, "reuse", target, request.key);
  });
  it("does not overwrite unresolved operations, and late acknowledgements cannot clear newer entries", () => {
    const { identity, request } = fixture("late-ack");
    retainPendingContentReuse(identity, request);
    const next = { ...request, key: crypto.randomUUID() };
    expect(() => retainPendingContentReuse(identity, next)).toThrow("Unresolved");
    settlePendingContentReuse(identity, "reuse", target, next.key);
    expect(getPendingContentReuse(identity, "reuse", target)?.key).toBe(request.key);
    settlePendingContentReuse(identity, "reuse", target, request.key);
    retainPendingContentReuse(identity, next);
    settlePendingContentReuse(identity, "reuse", target, request.key);
    expect(getPendingContentReuse(identity, "reuse", target)?.key).toBe(next.key);
    settlePendingContentReuse(identity, "reuse", target, next.key);
  });
  it("retains a strict independent immutable DTO without preview material", () => {
    const { identity, request } = fixture("copy");
    retainPendingContentReuse(identity, request);
    request.body.channelIds.push("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const stored = getPendingContentReuse(identity, "reuse", target);
    expect(stored?.body).toEqual(body);
    expect(Object.isFrozen(stored?.body)).toBe(true);
    expect(() =>
      retainPendingContentReuse({ userId: "invalid", orgId: "org" }, {
        ...request,
        body: { ...request.body, material: "private" },
      } as typeof request),
    ).toThrow();
    settlePendingContentReuse(identity, "reuse", target, request.key);
  });
  it("refuses oversized, empty, NUL or invalid resource identities", () => {
    const { identity, request } = fixture("invalid");
    for (const userId of ["", "x".repeat(256), "x\0y"])
      expect(() => retainPendingContentReuse({ ...identity, userId }, request)).toThrow();
    expect(() => retainPendingContentReuse(identity, { ...request, targetId: "bad" })).toThrow();
  });
});
