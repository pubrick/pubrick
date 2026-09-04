import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { and, eq, gt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db";

/** One organization this account has been invited into and has not answered yet. */
export type PendingInvitation = {
  id: string;
  organizationId: string;
  organizationName: string;
  inviterEmail: string;
  /** ISO 8601, serialised by Nest's JSON encoder from the timestamp column. */
  expiresAt: Date;
};

/**
 * The invitations waiting for the signed-in account.
 *
 * **Why this exists at all**, given the organization plugin has
 * `/organization/list-user-invitations`: that endpoint refuses outright unless
 * `session.user.emailVerified` is true, and this product does not verify email
 * addresses — there is no mailer to verify them with (docs/self-hosting.md).
 * So on every Pubrick install that endpoint answers 403 to everybody, and the
 * invited person has no way to discover the invitation that let them register.
 *
 * **Why it is not org-scoped**, against the convention every other repository
 * here follows: the caller is by definition not yet a member of the
 * organization it names. There is no `orgId` to take first, and taking one
 * would be a lie about what this reads. It is scoped by the one thing that is
 * safe to scope it by — the session's own user id, resolved to that account's
 * own address inside this method, never an address supplied by the caller.
 *
 * "Waiting" is the same TWO facts the signup gate checks, for the same reason
 * (see `auth-signup-gate.ts`): a `pending` status and an expiry in the future,
 * neither implying the other. A revoked invitation keeps its future expiry, and
 * one nobody answered stays `pending` forever past its date. Offering either to
 * a stranger would hand them a Join button the plugin's own
 * `accept-invitation` is going to refuse — and, worse, would tell them an
 * organization they cannot enter exists.
 */
@Injectable()
export class InvitationsRepository {
  async listPendingForUser(userId: string): Promise<PendingInvitation[]> {
    const [account] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1);
    if (!account) return [];

    // The plugin lowercases the address it stores; the account's own address is
    // whatever the person typed at sign-up. Lowered on both sides rather than
    // trusting either — the same comparison the gate makes, so a person the gate
    // admitted cannot then be told they have no invitation.
    const email = account.email.trim().toLowerCase();
    if (email === "") return [];

    const inviter = alias(schema.user, "inviter");
    return db
      .select({
        id: schema.invitation.id,
        organizationId: schema.invitation.organizationId,
        organizationName: schema.organization.name,
        inviterEmail: inviter.email,
        expiresAt: schema.invitation.expiresAt,
      })
      .from(schema.invitation)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
      .innerJoin(inviter, eq(inviter.id, schema.invitation.inviterId))
      .where(
        and(
          sql`lower(${schema.invitation.email}) = ${email}`,
          eq(schema.invitation.status, "pending"),
          gt(schema.invitation.expiresAt, new Date()),
        ),
      );
  }
}
