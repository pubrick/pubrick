import { randomUUID } from "node:crypto";
import { createDb, schema } from "@pubrick/db";
import { type AuthMailPayload, createMailIdentity, deliveryEligibility } from "@pubrick/mail";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("authoritative mail ownership from durable auth records", () => {
  let database: ReturnType<typeof createDb>;
  let repository: InstanceType<typeof import("./auth-mail.repository").AuthMailRepository>;
  const userId = randomUUID();
  const orgId = randomUUID();
  const invitationId = randomUUID();
  const verificationId = randomUUID();
  const identity = createMailIdentity("https://pubrick.example", "hosted", "synthetic-secret");
  const now = Date.now();
  function payload(kind: "verify" | "reset" | "invite"): AuthMailPayload {
    const jobId = randomUUID();
    const common = {
      purpose: "pubrick-auth-mail" as const,
      version: 1 as const,
      jobId,
      identity,
      recipient: "synthetic@example.com",
      locale: "en" as const,
      createdAt: now,
      expiresAt: now + 3600000,
      messageId: `<pubrick-auth.${jobId}@pubrick.example>`,
    };
    return kind === "invite"
      ? {
          ...common,
          kind,
          invitationId,
          organizationId: orgId,
          link: `https://pubrick.example/en/onboarding?invitation=${invitationId}`,
        }
      : {
          ...common,
          kind,
          userId,
          link:
            kind === "verify"
              ? "https://pubrick.example/api/auth/verify-email?token=fixture"
              : "https://pubrick.example/api/auth/reset-password/fixture_token",
        };
  }
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    database = createDb(url as string);
    await database.db
      .insert(schema.user)
      .values({
        id: userId,
        email: "synthetic@example.com",
        name: "Synthetic",
        emailVerified: false,
      });
    await database.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Synthetic", slug: `synthetic-${orgId}` });
    await database.db
      .insert(schema.invitation)
      .values({
        id: invitationId,
        organizationId: orgId,
        email: "synthetic@example.com",
        inviterId: userId,
        expiresAt: new Date(now + 3600000),
      });
    await database.db
      .insert(schema.verification)
      .values({
        id: verificationId,
        identifier: "reset-password:fixture_token",
        value: userId,
        expiresAt: new Date(now + 3600000),
      });
    const { AuthMailRepository } = await import("./auth-mail.repository");
    repository = new AuthMailRepository();
  });
  afterAll(async () => {
    if (database) {
      await database.db
        .delete(schema.verification)
        .where(eq(schema.verification.id, verificationId));
      await database.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await database.db.delete(schema.user).where(eq(schema.user.id, userId));
      await database.pool.end();
    }
    await (await import("../db")).pool.end();
  });
  it("reads exact reset identifier/user/expiry and detects real token consumption", async () => {
    const value = payload("reset");
    expect(
      deliveryEligibility(value, identity, Date.now(), await repository.ownership(value)),
    ).toBe("eligible");
    await database.db.delete(schema.verification).where(eq(schema.verification.id, verificationId));
    expect(
      deliveryEligibility(value, identity, Date.now(), await repository.ownership(value)),
    ).toBe("reset_token_invalid");
  });
  it("rechecks current account email and verification before every attempt", async () => {
    const value = payload("verify");
    expect(
      deliveryEligibility(value, identity, Date.now(), await repository.ownership(value)),
    ).toBe("eligible");
    await database.db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, userId));
    expect(
      deliveryEligibility(value, identity, Date.now(), await repository.ownership(value)),
    ).toBe("already_verified");
    await database.db
      .update(schema.user)
      .set({ email: "changed@example.com" })
      .where(eq(schema.user.id, userId));
    expect(
      deliveryEligibility(value, identity, Date.now(), await repository.ownership(value)),
    ).toBe("recipient_changed");
  });
  it("rejects closed invitations and detects real organization deletion", async () => {
    const value = payload("invite");
    expect(
      deliveryEligibility(value, identity, Date.now(), await repository.ownership(value)),
    ).toBe("eligible");
    await database.db
      .update(schema.invitation)
      .set({ status: "accepted" })
      .where(eq(schema.invitation.id, invitationId));
    expect(
      deliveryEligibility(value, identity, Date.now(), await repository.ownership(value)),
    ).toBe("invitation_closed");
    await database.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    expect(
      deliveryEligibility(value, identity, Date.now(), await repository.ownership(value)),
    ).toBe("missing_target");
  });
});
