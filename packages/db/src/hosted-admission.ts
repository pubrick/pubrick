import { randomUUID } from "node:crypto";
import { RUN_ADMISSION_LOCK_NAMESPACE } from "@pubrick/shared";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import type { createDb } from "./client.js";
import {
  admissionSeats,
  assertCreationPolicy,
  assertInvitationRole,
  assertMemberRemoval,
  assertRoleUpdate,
  canonicalEmail,
  HOSTED_CREATION_WINDOW_MS,
  HOSTED_INVITATION_LIFETIME_MS,
  HostedAdmissionError,
  type HostedCreationPolicy,
  hasRole,
  isManager,
  normalizeHostedRoles,
} from "./hosted-admission-policy.js";
import { invitation, member, organization, session, user } from "./schema/auth.js";
import {
  hostedAccountCreationClaims,
  hostedInvitationAcceptances,
} from "./schema/hosted-account-admission.js";

type Database = ReturnType<typeof createDb>["db"];
export type HostedAdmissionTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export interface HostedAdmissionActor {
  userId: string;
  sessionId: string;
}
export type HostedAdmissionLocale = "en" | "es" | "ru" | "pt";
export interface HostedAdmissionPorts {
  /** Database-only; shares this transaction and locks the central entitlement authority. */
  authorizeGrowth(
    tx: HostedAdmissionTransaction,
    input: {
      orgId: string;
      userId: string;
      operation: "create" | "invite" | "accept";
      occupiedSeats: number;
      additionalSeats: number;
    },
  ): Promise<void>;
  /** Durable encrypted pg-boss insertion in THIS transaction, including bounded admission. */
  enqueueInvitation(
    tx: HostedAdmissionTransaction,
    input: {
      invitationId: string;
      organizationId: string;
      email: string;
      expiresAt: Date;
      inviterId: string;
      role: string;
      locale: HostedAdmissionLocale;
    },
  ): Promise<void>;
  /** Writes a durable billing deletion tombstone before cascading organization deletion. */
  stageDeletion(
    tx: HostedAdmissionTransaction,
    input: { orgId: string; userId: string },
  ): Promise<void>;
}

/** Shared tenant advisory -> strongest organization lock -> quota/session/domain rows. */
export class HostedAdmissionRepository {
  constructor(
    private readonly db: Database,
    private readonly policy: HostedCreationPolicy,
    private readonly ports: HostedAdmissionPorts,
  ) {}

  private async lockOrganization(tx: HostedAdmissionTransaction, orgId: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
    );
    const [found] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, orgId))
      .for("update");
    if (!found) throw new HostedAdmissionError("not_found");
  }
  private async preflightActor(
    tx: HostedAdmissionTransaction,
    actor: HostedAdmissionActor,
  ): Promise<void> {
    const [found] = await tx
      .select({ id: session.id })
      .from(session)
      .innerJoin(user, eq(user.id, session.userId))
      .where(
        and(
          eq(session.id, actor.sessionId),
          eq(session.userId, actor.userId),
          eq(user.emailVerified, true),
          gt(session.expiresAt, new Date()),
        ),
      );
    if (!found) throw new HostedAdmissionError("unauthenticated");
  }
  private async actor(tx: HostedAdmissionTransaction, actor: HostedAdmissionActor, now: Date) {
    // Update-lock avoids shared-to-exclusive session upgrades when activating an organization.
    const [s] = await tx
      .select({ id: session.id, userId: session.userId, expiresAt: session.expiresAt })
      .from(session)
      .where(
        and(
          eq(session.id, actor.sessionId),
          eq(session.userId, actor.userId),
          gt(session.expiresAt, now),
        ),
      )
      .for("update");
    if (!s) throw new HostedAdmissionError("unauthenticated");
    const [u] = await tx
      .select({ id: user.id, email: user.email, verified: user.emailVerified })
      .from(user)
      .where(eq(user.id, actor.userId))
      .for("share");
    if (!u?.verified || s.expiresAt.getTime() <= Date.now())
      throw new HostedAdmissionError("unauthenticated");
    return u;
  }
  private async membership(tx: HostedAdmissionTransaction, orgId: string, userId: string) {
    const rows = await tx
      .select({ id: member.id, userId: member.userId, role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)));
    const first = rows[0];
    if (!first) throw new HostedAdmissionError("forbidden");
    // Preserve legacy rows, combining permission roles for the same account.
    return { id: first.id, role: rows.map((row) => row.role).join(",") };
  }
  private async lockAccountQuota(
    tx: HostedAdmissionTransaction,
    userIds: readonly string[],
  ): Promise<void> {
    for (const id of [...new Set(userIds)].sort())
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 39427))`);
  }
  private async assertOwnerCapacity(
    tx: HostedAdmissionTransaction,
    userId: string,
    orgId: string,
  ): Promise<void> {
    const owned = await tx
      .select({ orgId: member.organizationId, role: member.role })
      .from(member)
      .where(eq(member.userId, userId));
    const ids = new Set(owned.filter((row) => hasRole(row.role, "owner")).map((row) => row.orgId));
    if (!Number.isSafeInteger(this.policy.maxOwnedWorkspaces) || this.policy.maxOwnedWorkspaces < 1)
      throw new HostedAdmissionError("invalid_policy");
    if (!ids.has(orgId) && ids.size >= this.policy.maxOwnedWorkspaces)
      throw new HostedAdmissionError("owned_workspace_limit");
  }
  private async seats(tx: HostedAdmissionTransaction, orgId: string, now: Date) {
    const members = await tx
      .select({ userId: member.userId, email: user.email })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, orgId));
    const pending = await tx
      .select({ email: invitation.email })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, orgId),
          eq(invitation.status, "pending"),
          gt(invitation.expiresAt, now),
        ),
      );
    return {
      members,
      pending: pending.map((row) => row.email),
      occupied: admissionSeats(
        members,
        pending.map((row) => row.email),
      ),
    };
  }

  async create(
    actor: HostedAdmissionActor,
    input: { name: string; slug: string },
  ): Promise<{ organizationId: string }> {
    const name = input.name.trim();
    const slug = input.slug.trim();
    if (!name || name.length > 120 || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug))
      throw new HostedAdmissionError("invalid_input");
    return this.db.transaction(async (tx) => {
      // Creation-only account lock. Existing-org mutations never acquire this lock.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor.userId}, 39427))`);
      let now = new Date();
      await this.actor(tx, actor, now);
      now = new Date();
      await tx
        .delete(hostedAccountCreationClaims)
        .where(
          and(
            eq(hostedAccountCreationClaims.userId, actor.userId),
            lt(
              hostedAccountCreationClaims.createdAt,
              new Date(now.getTime() - HOSTED_CREATION_WINDOW_MS),
            ),
          ),
        );
      const owned = await tx
        .select({ orgId: member.organizationId, role: member.role })
        .from(member)
        .where(eq(member.userId, actor.userId));
      const recent = await tx
        .select({ id: hostedAccountCreationClaims.id })
        .from(hostedAccountCreationClaims)
        .where(
          and(
            eq(hostedAccountCreationClaims.userId, actor.userId),
            gt(
              hostedAccountCreationClaims.createdAt,
              new Date(now.getTime() - HOSTED_CREATION_WINDOW_MS),
            ),
          ),
        );
      assertCreationPolicy(
        this.policy,
        new Set(owned.filter((row) => hasRole(row.role, "owner")).map((row) => row.orgId)).size,
        recent.length,
      );
      const orgId = randomUUID();
      await tx.insert(organization).values({ id: orgId, name, slug, createdAt: now });
      // New row is transaction-owned; no preexisting organization can lock it.
      await this.ports.authorizeGrowth(tx, {
        orgId,
        userId: actor.userId,
        operation: "create",
        occupiedSeats: 0,
        additionalSeats: 1,
      });
      await tx.insert(member).values({
        id: randomUUID(),
        organizationId: orgId,
        userId: actor.userId,
        role: "owner",
        createdAt: now,
      });
      await tx.insert(hostedAccountCreationClaims).values({ userId: actor.userId, createdAt: now });
      await tx
        .update(session)
        .set({ activeOrganizationId: orgId })
        .where(eq(session.id, actor.sessionId));
      return { organizationId: orgId };
    });
  }

  async invite(
    orgId: string,
    actor: HostedAdmissionActor,
    input: { email: string; role: string; locale: HostedAdmissionLocale; resendId?: string },
  ): Promise<{ invitationId: string; email: string; expiresAt: Date }> {
    const email = canonicalEmail(input.email.trim());
    const invitedRole = normalizeHostedRoles(input.role);
    if (!email || email.length > 320 || !["en", "es", "ru", "pt"].includes(input.locale))
      throw new HostedAdmissionError("invalid_input");
    return this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, orgId);
      await this.preflightActor(tx, actor);
      const initialMembership = await this.membership(tx, orgId, actor.userId);
      assertInvitationRole(initialMembership.role, invitedRole, !!input.resendId);
      if (hasRole(invitedRole, "owner")) {
        const [recipient] = await tx
          .select({ id: user.id })
          .from(user)
          .where(sql`lower(${user.email}) = ${email}`)
          .limit(1);
        if (recipient) {
          await this.lockAccountQuota(tx, [recipient.id]);
          await this.assertOwnerCapacity(tx, recipient.id, orgId);
        }
      }
      let now = new Date();
      await this.actor(tx, actor, now);
      now = new Date();
      const membership = await this.membership(tx, orgId, actor.userId);
      assertInvitationRole(membership.role, invitedRole, !!input.resendId);
      if (input.resendId) {
        const [existing] = await tx
          .select({ email: invitation.email, role: invitation.role, status: invitation.status })
          .from(invitation)
          .where(and(eq(invitation.id, input.resendId), eq(invitation.organizationId, orgId)));
        if (
          existing?.status !== "pending" ||
          canonicalEmail(existing.email) !== email ||
          normalizeHostedRoles(existing.role ?? "") !== invitedRole
        )
          throw new HostedAdmissionError("invitation_unavailable");
      }
      const seats = await this.seats(tx, orgId, now);
      if (seats.members.some((m) => canonicalEmail(m.email) === email))
        throw new HostedAdmissionError("already_member");
      const additionalSeats = seats.pending.some((e) => canonicalEmail(e) === email) ? 0 : 1;
      await this.ports.authorizeGrowth(tx, {
        orgId,
        userId: actor.userId,
        operation: "invite",
        occupiedSeats: seats.occupied,
        additionalSeats,
      });
      // Replacement revokes old links and uses a fresh token/job. Same address still reserves one seat.
      await tx
        .update(invitation)
        .set({ status: "canceled" })
        .where(
          and(
            eq(invitation.organizationId, orgId),
            eq(invitation.status, "pending"),
            sql`lower(${invitation.email}) = ${email}`,
          ),
        );
      const id = randomUUID();
      const expiresAt = new Date(now.getTime() + HOSTED_INVITATION_LIFETIME_MS);
      const [persisted] = await tx
        .insert(invitation)
        .values({
          id,
          organizationId: orgId,
          email,
          role: invitedRole,
          status: "pending",
          expiresAt,
          createdAt: now,
          inviterId: actor.userId,
        })
        .returning({ id: invitation.id, email: invitation.email, expiresAt: invitation.expiresAt });
      if (!persisted) throw new Error("Invitation insertion returned no row");
      await this.ports.enqueueInvitation(tx, {
        invitationId: id,
        organizationId: orgId,
        email,
        role: invitedRole,
        expiresAt,
        inviterId: actor.userId,
        locale: input.locale,
      });
      return { invitationId: persisted.id, email: persisted.email, expiresAt: persisted.expiresAt };
    });
  }

  async accept(
    orgId: string,
    actor: HostedAdmissionActor,
    invitationId: string,
  ): Promise<{ organizationId: string; memberId: string }> {
    return this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, orgId);
      await this.lockAccountQuota(tx, [actor.userId]);
      let now = new Date();
      const account = await this.actor(tx, actor, now);
      now = new Date();
      const [inv] = await tx
        .select({
          id: invitation.id,
          email: invitation.email,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
        })
        .from(invitation)
        .where(and(eq(invitation.id, invitationId), eq(invitation.organizationId, orgId)));
      if (!inv) throw new HostedAdmissionError("invitation_unavailable");
      const existing = await tx
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.organizationId, orgId), eq(member.userId, actor.userId)))
        .limit(1);
      if (inv.status === "accepted") {
        const [claim] = await tx
          .select({ userId: hostedInvitationAcceptances.userId })
          .from(hostedInvitationAcceptances)
          .where(eq(hostedInvitationAcceptances.invitationId, invitationId));
        const acceptedMember = existing[0];
        if (claim?.userId !== actor.userId || !acceptedMember)
          throw new HostedAdmissionError("invitation_unavailable");
        await tx
          .update(session)
          .set({ activeOrganizationId: orgId })
          .where(eq(session.id, actor.sessionId));
        return { organizationId: orgId, memberId: acceptedMember.id };
      }
      if (
        inv.status !== "pending" ||
        inv.expiresAt <= now ||
        canonicalEmail(inv.email) !== canonicalEmail(account.email) ||
        !inv.role
      )
        throw new HostedAdmissionError("invitation_unavailable");
      const acceptedRole = normalizeHostedRoles(inv.role);
      if (!existing.length && hasRole(acceptedRole, "owner"))
        await this.assertOwnerCapacity(tx, actor.userId, orgId);
      const seats = await this.seats(tx, orgId, now);
      // Usually converts the one pending reservation. Legacy case-variant user
      // accounts may share a canonical email, so recompute the actual post-accept
      // occupancy instead of assuming that a reservation always existed.
      const postAcceptMembers = existing.length
        ? seats.members
        : [...seats.members, { userId: actor.userId, email: account.email }];
      const postAcceptPending = seats.pending.filter(
        (email) => canonicalEmail(email) !== canonicalEmail(account.email),
      );
      const additionalSeats = Math.max(
        0,
        admissionSeats(postAcceptMembers, postAcceptPending) - seats.occupied,
      );
      await this.ports.authorizeGrowth(tx, {
        orgId,
        userId: actor.userId,
        operation: "accept",
        occupiedSeats: seats.occupied,
        additionalSeats,
      });
      const memberId = existing[0]?.id ?? randomUUID();
      if (!existing.length)
        await tx.insert(member).values({
          id: memberId,
          organizationId: orgId,
          userId: actor.userId,
          role: acceptedRole,
          createdAt: now,
        });
      await tx
        .update(invitation)
        .set({ status: "accepted" })
        .where(eq(invitation.id, invitationId));
      await tx
        .insert(hostedInvitationAcceptances)
        .values({ invitationId, userId: actor.userId, acceptedAt: now });
      // Revoke other legacy reservations for this now-member without deleting their history.
      await tx
        .update(invitation)
        .set({ status: "canceled" })
        .where(
          and(
            eq(invitation.organizationId, orgId),
            eq(invitation.status, "pending"),
            sql`lower(${invitation.email}) = ${canonicalEmail(account.email)}`,
          ),
        );
      await tx
        .update(session)
        .set({ activeOrganizationId: orgId })
        .where(eq(session.id, actor.sessionId));
      return { organizationId: orgId, memberId };
    });
  }

  async cancel(orgId: string, actor: HostedAdmissionActor, invitationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, orgId);
      await this.actor(tx, actor, new Date());
      const m = await this.membership(tx, orgId, actor.userId);
      if (!isManager(m.role) && !hasRole(m.role, "member"))
        throw new HostedAdmissionError("forbidden");
      const [inv] = await tx
        .select({ id: invitation.id })
        .from(invitation)
        .where(and(eq(invitation.organizationId, orgId), eq(invitation.id, invitationId)));
      if (!inv) throw new HostedAdmissionError("not_found");
      await tx
        .update(invitation)
        .set({ status: "canceled" })
        .where(and(eq(invitation.id, invitationId), eq(invitation.status, "pending")));
    });
  }

  async remove(orgId: string, actor: HostedAdmissionActor, memberId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, orgId);
      await this.actor(tx, actor, new Date());
      const acting = await this.membership(tx, orgId, actor.userId);
      if (!isManager(acting.role)) throw new HostedAdmissionError("forbidden");
      const members = await tx
        .select({ id: member.id, userId: member.userId, role: member.role })
        .from(member)
        .where(eq(member.organizationId, orgId));
      const target = members.find((m) => m.id === memberId);
      if (!target) throw new HostedAdmissionError("not_found");
      const targetRoles = members
        .filter((m) => m.userId === target.userId)
        .map((m) => m.role)
        .join(",");
      assertMemberRemoval(
        acting.role,
        targetRoles,
        new Set(members.filter((m) => hasRole(m.role, "owner")).map((m) => m.userId)).size,
      );
      // Remove this logical account membership, including preexisting duplicate rows.
      await tx
        .delete(member)
        .where(and(eq(member.organizationId, orgId), eq(member.userId, target.userId)));
      if (target.userId === actor.userId)
        await tx
          .update(session)
          .set({ activeOrganizationId: null })
          .where(and(eq(session.id, actor.sessionId), eq(session.activeOrganizationId, orgId)));
    });
  }

  async updateRole(
    orgId: string,
    actor: HostedAdmissionActor,
    memberId: string,
    role: string | readonly string[],
  ): Promise<void> {
    const nextRole = normalizeHostedRoles(role);
    await this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, orgId);
      await this.preflightActor(tx, actor);
      const initialMembership = await this.membership(tx, orgId, actor.userId);
      if (!isManager(initialMembership.role)) throw new HostedAdmissionError("forbidden");
      const members = await tx
        .select({ id: member.id, userId: member.userId, role: member.role })
        .from(member)
        .where(eq(member.organizationId, orgId));
      const target = members.find((m) => m.id === memberId);
      if (!target) throw new HostedAdmissionError("not_found");
      if (hasRole(nextRole, "owner")) await this.lockAccountQuota(tx, [target.userId]);
      await this.actor(tx, actor, new Date());
      const acting = await this.membership(tx, orgId, actor.userId);
      const targetRoles = members
        .filter((m) => m.userId === target.userId)
        .map((m) => m.role)
        .join(",");
      assertRoleUpdate(
        acting.role,
        targetRoles,
        nextRole,
        new Set(members.filter((m) => hasRole(m.role, "owner")).map((m) => m.userId)).size,
      );
      if (hasRole(nextRole, "owner")) await this.assertOwnerCapacity(tx, target.userId, orgId);
      await tx
        .update(member)
        .set({ role: nextRole })
        .where(and(eq(member.organizationId, orgId), eq(member.userId, target.userId)));
    });
  }
  async leave(orgId: string, actor: HostedAdmissionActor): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, orgId);
      await this.actor(tx, actor, new Date());
      const membership = await this.membership(tx, orgId, actor.userId);
      const members = await tx
        .select({ userId: member.userId, role: member.role })
        .from(member)
        .where(eq(member.organizationId, orgId));
      if (
        hasRole(membership.role, "owner") &&
        new Set(members.filter((m) => hasRole(m.role, "owner")).map((m) => m.userId)).size <= 1
      )
        throw new HostedAdmissionError("last_owner");
      await tx
        .delete(member)
        .where(and(eq(member.organizationId, orgId), eq(member.userId, actor.userId)));
      await tx
        .update(session)
        .set({ activeOrganizationId: null })
        .where(and(eq(session.id, actor.sessionId), eq(session.activeOrganizationId, orgId)));
    });
  }

  async delete(orgId: string, actor: HostedAdmissionActor): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockOrganization(tx, orgId);
      await this.actor(tx, actor, new Date());
      const m = await this.membership(tx, orgId, actor.userId);
      if (!hasRole(m.role, "owner")) throw new HostedAdmissionError("forbidden");
      // No growth/entitlement check: expired accounts retain export, billing and deletion.
      await this.ports.stageDeletion(tx, { orgId, userId: actor.userId });
      await tx
        .update(session)
        .set({ activeOrganizationId: null })
        .where(and(eq(session.id, actor.sessionId), eq(session.activeOrganizationId, orgId)));
      await tx.delete(organization).where(eq(organization.id, orgId));
    });
  }
}
