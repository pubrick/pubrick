import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { type HostedAdmissionPorts, HostedAdmissionRepository } from "./hosted-admission.js";
import { runMigrations } from "./migrate.js";
import * as schema from "./schema/index.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("atomic hosted workspace admission", () => {
  let connection: ReturnType<typeof createDb>;
  const users: string[] = [];
  const organizations: string[] = [];
  let limit = 2;
  let refuseMail = false;
  let refuseDeletion = false;
  const ports: HostedAdmissionPorts = {
    authorizeGrowth: async (_tx, input) => {
      if (input.occupiedSeats + input.additionalSeats > limit) throw new Error("seat_limit");
    },
    enqueueInvitation: async (tx, input) => {
      if (refuseMail) throw new Error("mail_unavailable");
      // Separate read occurs inside SAME transaction; this proves caller ordering.
      const [row] = await tx
        .select({ id: schema.invitation.id })
        .from(schema.invitation)
        .where(eq(schema.invitation.id, input.invitationId));
      expect(row?.id).toBe(input.invitationId);
    },
    stageDeletion: async () => {
      if (refuseDeletion) throw new Error("tombstone_unavailable");
    },
  };
  beforeAll(async () => {
    await runMigrations(url as string);
    connection = createDb(url as string);
  }, 60_000);
  afterAll(async () => {
    if (!connection) return;
    for (const orgId of organizations)
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    for (const id of users) await connection.db.delete(schema.user).where(eq(schema.user.id, id));
    await connection.pool.end();
  });
  async function account(verified = true) {
    const userId = randomUUID();
    const sessionId = randomUUID();
    const email = `${userId}@example.test`;
    users.push(userId);
    await connection.db
      .insert(schema.user)
      .values({ id: userId, name: "Fixture", email, emailVerified: verified });
    await connection.db.insert(schema.session).values({
      id: sessionId,
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
    });
    return { userId, sessionId, email };
  }
  function repository(maxOwnedWorkspaces = 5, maxCreationsPerDay = 5) {
    return new HostedAdmissionRepository(
      connection.db,
      { maxOwnedWorkspaces, maxCreationsPerDay },
      ports,
    );
  }
  async function workspace(actor: Awaited<ReturnType<typeof account>>) {
    const result = await repository().create(actor, { name: "Fixture", slug: randomUUID() });
    organizations.push(result.organizationId);
    return result.organizationId;
  }
  it("serializes concurrent account creation and retains claims after deletion", async () => {
    const actor = await account();
    const repo = repository(1, 1);
    const results = await Promise.allSettled([
      repo.create(actor, { name: "One", slug: randomUUID() }),
      repo.create(actor, { name: "Two", slug: randomUUID() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const success = results.find((r) => r.status === "fulfilled");
    if (success?.status !== "fulfilled") throw new Error("missing admission");
    organizations.push(success.value.organizationId);
    await repo.delete(success.value.organizationId, actor);
    await expect(repo.create(actor, { name: "Again", slug: randomUUID() })).rejects.toThrow(
      "creation_rate_limit",
    );
    await connection.db
      .update(schema.hostedAccountCreationClaims)
      .set({ createdAt: new Date(Date.now() - 25 * 3600000) })
      .where(eq(schema.hostedAccountCreationClaims.userId, actor.userId));
    const next = await repo.create(actor, { name: "Later", slug: randomUUID() });
    organizations.push(next.organizationId);
  });
  it("rejects unverified/revoked sessions before any claims or creation", async () => {
    const actor = await account(false);
    await expect(repository().create(actor, { name: "No", slug: randomUUID() })).rejects.toThrow(
      "unauthenticated",
    );
    await connection.db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, actor.userId));
    await connection.db.delete(schema.session).where(eq(schema.session.id, actor.sessionId));
    await expect(repository().create(actor, { name: "No", slug: randomUUID() })).rejects.toThrow(
      "unauthenticated",
    );
    expect(
      await connection.db
        .select({ id: schema.hostedAccountCreationClaims.id })
        .from(schema.hostedAccountCreationClaims)
        .where(eq(schema.hostedAccountCreationClaims.userId, actor.userId)),
    ).toHaveLength(0);
  });
  it("serializes last seat invitations and rolls back a failed durable enqueue", async () => {
    limit = 2;
    const owner = await account();
    const orgId = await workspace(owner);
    const repo = repository();
    const results = await Promise.allSettled([
      repo.invite(orgId, owner, { email: "first@example.test", role: "member", locale: "en" }),
      repo.invite(orgId, owner, { email: "second@example.test", role: "member", locale: "en" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [pending] = await connection.db
      .select({ id: schema.invitation.id, email: schema.invitation.email })
      .from(schema.invitation)
      .where(
        and(eq(schema.invitation.organizationId, orgId), eq(schema.invitation.status, "pending")),
      );
    refuseMail = true;
    try {
      await expect(
        repo.invite(orgId, owner, {
          email: pending.email,
          role: "member",
          locale: "en",
          resendId: pending.id,
        }),
      ).rejects.toThrow("mail_unavailable");
    } finally {
      refuseMail = false;
    }
    const [original] = await connection.db
      .select({ status: schema.invitation.status })
      .from(schema.invitation)
      .where(eq(schema.invitation.id, pending.id));
    expect(original.status).toBe("pending");
    const replacement = await repo.invite(orgId, owner, {
      email: pending.email.toUpperCase(),
      role: "member",
      locale: "ru",
      resendId: pending.id,
    });
    expect(replacement.invitationId).not.toBe(pending.id);
  });
  it("converts reservation once, binds accepted replay and keeps existing member role", async () => {
    limit = 2;
    const owner = await account();
    const recipient = await account();
    const other = await account();
    const orgId = await workspace(owner);
    const repo = repository();
    const invite = await repo.invite(orgId, owner, {
      email: recipient.email,
      role: "editor",
      locale: "en",
    });
    const accepts = await Promise.all([
      repo.accept(orgId, recipient, invite.invitationId),
      repo.accept(orgId, recipient, invite.invitationId),
    ]);
    expect(accepts[0].memberId).toBe(accepts[1].memberId);
    await expect(repo.accept(orgId, other, invite.invitationId)).rejects.toThrow(
      "invitation_unavailable",
    );
    expect(
      await connection.db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(
          and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, recipient.userId)),
        ),
    ).toHaveLength(1);
    await connection.db.insert(schema.invitation).values({
      id: randomUUID(),
      organizationId: orgId,
      email: recipient.email,
      role: "admin",
      status: "pending",
      expiresAt: new Date(Date.now() + 60000),
      inviterId: owner.userId,
    });
    const [second] = await connection.db
      .select({ id: schema.invitation.id })
      .from(schema.invitation)
      .where(
        and(eq(schema.invitation.organizationId, orgId), eq(schema.invitation.status, "pending")),
      );
    await repo.accept(orgId, recipient, second.id);
    const [membership] = await connection.db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(
        and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, recipient.userId)),
      );
    expect(membership.role).toBe("editor");
  });
  it("locks current role, keeps the last owner, and rolls back failed tombstone", async () => {
    const owner = await account();
    const orgId = await workspace(owner);
    const repo = repository();
    const [membership] = await connection.db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.organizationId, orgId));
    await expect(repo.remove(orgId, owner, membership.id)).rejects.toThrow("last_owner");
    refuseDeletion = true;
    try {
      await expect(repo.delete(orgId, owner)).rejects.toThrow("tombstone_unavailable");
    } finally {
      refuseDeletion = false;
    }
    expect(
      await connection.db
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId)),
    ).toHaveLength(1);
    await connection.db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.id, membership.id));
    await expect(repo.delete(orgId, owner)).rejects.toThrow("forbidden");
    await connection.db.execute(sql`select 1`);
  });
  it("checks owner grants and invitation acceptance against the same account cap", async () => {
    limit = 10;
    const owner = await account();
    const recipient = await account();
    const orgId = await workspace(owner);
    const recipientOrg = await workspace(recipient);
    const limited = repository(1, 10);
    await expect(
      limited.invite(orgId, owner, { email: recipient.email, role: "owner", locale: "en" }),
    ).rejects.toThrow("owned_workspace_limit");
    const invitation = await repository().invite(orgId, owner, {
      email: recipient.email,
      role: "owner",
      locale: "en",
    });
    await expect(limited.accept(orgId, recipient, invitation.invitationId)).rejects.toThrow(
      "owned_workspace_limit",
    );
    const memberId = randomUUID();
    await connection.db
      .insert(schema.member)
      .values({ id: memberId, organizationId: orgId, userId: recipient.userId, role: "editor" });
    await expect(limited.updateRole(orgId, owner, memberId, "owner,editor")).rejects.toThrow(
      "owned_workspace_limit",
    );
    await repository().delete(recipientOrg, recipient);
    await limited.updateRole(orgId, owner, memberId, ["owner", "editor"]);
    await limited.leave(orgId, owner);
    await expect(limited.leave(orgId, recipient)).rejects.toThrow("last_owner");
  });
  it("refuses canceled, expired and wrong-tenant invitations", async () => {
    limit = 10;
    const owner = await account();
    const recipient = await account();
    const orgId = await workspace(owner);
    const otherOrg = await workspace(owner);
    const repo = repository();
    const invitation = await repo.invite(orgId, owner, {
      email: recipient.email,
      role: "member",
      locale: "en",
    });
    await expect(repo.accept(otherOrg, recipient, invitation.invitationId)).rejects.toThrow(
      "invitation_unavailable",
    );
    await connection.db
      .update(schema.invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invitation.id, invitation.invitationId));
    await expect(repo.accept(orgId, recipient, invitation.invitationId)).rejects.toThrow(
      "invitation_unavailable",
    );
    await repo.cancel(orgId, owner, invitation.invitationId);
    await expect(repo.accept(orgId, recipient, invitation.invitationId)).rejects.toThrow(
      "invitation_unavailable",
    );
  });
});
