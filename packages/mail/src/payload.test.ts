import { decryptJson, encryptJson } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { createMailIdentity, deliveryEligibility, openAuthMail, sealAuthMail } from "./index.js";

const key = Buffer.alloc(32, 1).toString("base64");
const otherKey = Buffer.alloc(32, 2).toString("base64");
const now = 1_790_000_000_000;
const identity = createMailIdentity("https://pubrick.example", "hosted", "private-auth-secret");
const payload = {
  purpose: "pubrick-auth-mail" as const,
  version: 1 as const,
  jobId: "a91b4a67-2a4d-45f6-b7ce-a12b0b912ac0",
  identity,
  kind: "verify" as const,
  recipient: "person@example.com",
  locale: "en" as const,
  userId: "user_1",
  createdAt: now,
  expiresAt: now + 3_600_000,
  messageId: "<pubrick-auth.a91b4a67-2a4d-45f6-b7ce-a12b0b912ac0@pubrick.example>",
  link: "https://pubrick.example/api/auth/verify-email?token=private-token&callbackURL=%2Fen%2Fverify-email",
};
const user = { id: "user_1", email: "person@example.com", emailVerified: false };
describe("encrypted authentication mail contract", () => {
  it("requires the exact unconsumed reset verification row, its owner and authoritative deadline", () => {
    const reset = {
      ...payload,
      kind: "reset" as const,
      link: "https://pubrick.example/api/auth/reset-password/private-token?callbackURL=%2Fen%2Freset-password",
    };
    const verification = {
      identifier: "reset-password:private-token",
      userId: user.id,
      expiresAt: reset.expiresAt,
    };
    expect(deliveryEligibility(reset, identity, now, { user })).toBe("reset_token_invalid");
    expect(deliveryEligibility(reset, identity, now, { user, resetVerification: null })).toBe(
      "reset_token_invalid",
    );
    expect(
      deliveryEligibility(reset, identity, now, { user, resetVerification: verification }),
    ).toBe("eligible");
    for (const changed of [
      { ...verification, identifier: "reset-password:other-token" },
      { ...verification, userId: "other_user" },
    ]) {
      expect(deliveryEligibility(reset, identity, now, { user, resetVerification: changed })).toBe(
        "reset_token_invalid",
      );
    }
    expect(
      deliveryEligibility(reset, identity, now, {
        user,
        resetVerification: { ...verification, expiresAt: now },
      }),
    ).toBe("expired");
  });
  it("stores only ciphertext, preserves a stable Message-ID and reads old rotated keys", () => {
    const envelope = sealAuthMail(payload, key);
    expect(Object.keys(envelope)).toEqual(["ciphertext"]);
    expect(JSON.stringify(envelope)).not.toMatch(
      /person@example|private-token|private-auth-secret/,
    );
    expect(openAuthMail(envelope, `${otherKey},${key}`)).toEqual(payload);
    expect(openAuthMail(envelope, `${otherKey},${key}`).messageId).toBe(payload.messageId);
    expect(() => openAuthMail(envelope, otherKey)).toThrowError("unreadable_payload");
    expect(decryptJson(envelope.ciphertext, key)).toEqual(payload);
  });
  it("rejects malformed, tampered, unrelated or incomplete encrypted payloads without leaking data", () => {
    for (const value of [
      "broken",
      { ciphertext: "broken" },
      { ciphertext: encryptJson({ recipient: "private@example.com" }, key) },
      { ciphertext: encryptJson({ ...payload, purpose: "other-product" }, key) },
      { ciphertext: encryptJson({ ...payload, kind: "unknown" }, key) },
      { ciphertext: encryptJson({ ...payload, locale: "constructor" }, key) },
    ]) {
      expect(() => openAuthMail(value, key)).toThrowError(/unreadable_payload|invalid_payload/);
    }
  });
  it("refuses links for other origins, user info, unbounded callbacks and header injection", () => {
    for (const link of [
      "https://evil.example/api/auth/verify-email?token=x",
      "https://user:password@pubrick.example/api/auth/verify-email?token=x",
      "https://pubrick.example/api/auth/verify-email?callbackURL=//evil.example",
      "https://pubrick.example/api/auth/reset-password/token?callbackURL=/en/reset-password",
    ]) {
      expect(() => sealAuthMail({ ...payload, link }, key)).toThrowError("invalid_payload");
    }
    expect(() =>
      sealAuthMail({ ...payload, messageId: "<id@example>\r\nBcc: attacker@example.com" }, key),
    ).toThrowError("invalid_payload");
  });
  it("checks exact expiry and authoritative ownership on every attempt", () => {
    expect(deliveryEligibility(payload, identity, now, { user })).toBe("eligible");
    expect(deliveryEligibility(payload, identity, payload.expiresAt, { user })).toBe("expired");
    expect(
      deliveryEligibility(payload, identity, now, { user: { ...user, email: "new@example.com" } }),
    ).toBe("recipient_changed");
    expect(
      deliveryEligibility(payload, identity, now, { user: { ...user, emailVerified: true } }),
    ).toBe("already_verified");
    expect(deliveryEligibility(payload, identity, now, {})).toBe("missing_target");
    const later = { user: { ...user, email: "changed@example.com" } };
    expect(deliveryEligibility(payload, identity, now + 1, later)).toBe("recipient_changed");
  });
  it("refuses stale deployment identity and deadlines beyond the token contract", () => {
    for (const changed of [
      createMailIdentity("https://other.example", "hosted", "private-auth-secret"),
      createMailIdentity("https://pubrick.example", "self-hosted", "private-auth-secret"),
      createMailIdentity("https://pubrick.example", "hosted", "different-auth-secret"),
    ]) {
      expect(deliveryEligibility(payload, changed, now, { user })).toBe("identity_mismatch");
    }
    expect(() => sealAuthMail({ ...payload, expiresAt: now + 3_600_001 }, key)).toThrowError(
      "invalid_payload",
    );
    expect(deliveryEligibility(payload, identity, now - 60_001, { user })).toBe("invalid_payload");
  });
  it("sends pending invitations only while organization, recipient and invitation remain current", () => {
    const invite = {
      ...payload,
      kind: "invite" as const,
      userId: undefined,
      invitationId: "invite_1",
      organizationId: "org_1",
      expiresAt: now + 48 * 3_600_000,
      link: "https://pubrick.example/en/onboarding?invitation=invite_1",
    };
    const validated = openAuthMail(sealAuthMail(invite, key), key);
    const invitation = {
      id: "invite_1",
      organizationId: "org_1",
      email: payload.recipient,
      status: "pending" as const,
      expiresAt: invite.expiresAt,
      organizationExists: true,
    };
    expect(deliveryEligibility(validated, identity, now, { invitation })).toBe("eligible");
    expect(
      deliveryEligibility(validated, identity, now, {
        invitation: { ...invitation, status: "canceled" },
      }),
    ).toBe("invitation_closed");
    expect(
      deliveryEligibility(validated, identity, now, {
        invitation: { ...invitation, organizationExists: false },
      }),
    ).toBe("missing_target");
    expect(
      deliveryEligibility(validated, identity, now, {
        invitation: { ...invitation, expiresAt: now },
      }),
    ).toBe("expired");
  });
});
