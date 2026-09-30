import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type AuthMailPayload,
  type MailOwnershipSnapshot,
  resetMailVerificationIdentifier,
} from "@pubrick/mail";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
@Injectable()
export class AuthMailRepository {
  async ownership(payload: AuthMailPayload): Promise<MailOwnershipSnapshot> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      if (payload.kind === "invite") {
        const [value] = await tx
          .select({
            id: schema.invitation.id,
            organizationId: schema.invitation.organizationId,
            email: schema.invitation.email,
            status: schema.invitation.status,
            expiresAt: schema.invitation.expiresAt,
          })
          .from(schema.invitation)
          .innerJoin(
            schema.organization,
            eq(schema.organization.id, schema.invitation.organizationId),
          )
          .where(
            and(
              eq(schema.invitation.id, payload.invitationId),
              eq(schema.invitation.organizationId, payload.organizationId),
            ),
          )
          .limit(1);
        return value
          ? {
              invitation: {
                ...value,
                expiresAt: value.expiresAt.getTime(),
                organizationExists: true,
              },
            }
          : {};
      }
      const [user] = await tx
        .select({
          id: schema.user.id,
          email: schema.user.email,
          emailVerified: schema.user.emailVerified,
        })
        .from(schema.user)
        .where(eq(schema.user.id, payload.userId))
        .limit(1);
      if (payload.kind === "verify") return { user };
      const [reset] = await tx
        .select({
          identifier: schema.verification.identifier,
          userId: schema.verification.value,
          expiresAt: schema.verification.expiresAt,
        })
        .from(schema.verification)
        .where(eq(schema.verification.identifier, resetMailVerificationIdentifier(payload)))
        .limit(1);
      return {
        user,
        resetVerification: reset ? { ...reset, expiresAt: reset.expiresAt.getTime() } : undefined,
      };
    });
  }
}
