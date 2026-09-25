import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { badRequest, notFound } from "../api-error";
import { db } from "../db";

const MANAGER_ROLES = ["owner", "admin"];

@Injectable()
export class BrandAccessRepository {
  /** Managers can see every brand; regular members see their explicit grants. */
  async visibleBrandIds(orgId: string, userId: string): Promise<string[] | null> {
    const [membership] = await db
      .select({ id: schema.member.id, role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
      .limit(1);
    if (!membership) return [];
    if (MANAGER_ROLES.includes(membership.role)) return null;
    const grants = await db
      .select({ brandId: schema.brandAccess.brandId })
      .from(schema.brandAccess)
      .where(
        and(eq(schema.brandAccess.orgId, orgId), eq(schema.brandAccess.memberId, membership.id)),
      );
    return grants.map((grant) => grant.brandId);
  }

  /** Checks both the active membership and the brand's organization. */
  async hasAccess(orgId: string, brandId: string, userId: string): Promise<boolean> {
    const [row] = await db
      .select({
        role: schema.member.role,
        grant: schema.brandAccess.memberId,
      })
      .from(schema.brands)
      .innerJoin(
        schema.member,
        and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)),
      )
      .leftJoin(
        schema.brandAccess,
        and(
          eq(schema.brandAccess.orgId, orgId),
          eq(schema.brandAccess.brandId, schema.brands.id),
          eq(schema.brandAccess.memberId, schema.member.id),
        ),
      )
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    return !!row && (MANAGER_ROLES.includes(row.role) || row.grant !== null);
  }

  async isManager(orgId: string, userId: string): Promise<boolean> {
    const [membership] = await db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
      .limit(1);
    return !!membership && MANAGER_ROLES.includes(membership.role);
  }

  async list(orgId: string, brandId: string) {
    return db.transaction(async (tx) => {
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .limit(1)
        .for("key share");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      return this.listMembers(orgId, brandId, tx);
    });
  }

  /** Serialize replacements on the brand row and validate every selected member in the same transaction. */
  async replace(orgId: string, brandId: string, memberIds: string[]) {
    return db.transaction(async (tx) => {
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .limit(1)
        .for("update");
      if (!brand) throw notFound("brand_not_found", "Brand not found");

      if (memberIds.length > 0) {
        const members = await tx
          .select({ id: schema.member.id, role: schema.member.role })
          .from(schema.member)
          .where(and(eq(schema.member.organizationId, orgId), inArray(schema.member.id, memberIds)))
          .orderBy(schema.member.id)
          .for("key share");
        if (
          members.length !== memberIds.length ||
          members.some((member) => !["member", "author", "editor"].includes(member.role))
        ) {
          throw badRequest(
            "invalid_request",
            "Every selected member must be a non-manager member of this organization",
          );
        }
      }

      await tx
        .delete(schema.brandAccess)
        .where(and(eq(schema.brandAccess.orgId, orgId), eq(schema.brandAccess.brandId, brandId)));
      if (memberIds.length > 0) {
        await tx
          .insert(schema.brandAccess)
          .values(memberIds.map((memberId) => ({ orgId, brandId, memberId })));
      }
      return this.listMembers(orgId, brandId, tx);
    });
  }

  private async listMembers(
    orgId: string,
    brandId: string,
    client: Pick<typeof db, "select"> = db,
  ) {
    const members = await client
      .select({
        memberId: schema.member.id,
        userId: schema.member.userId,
        name: schema.user.name,
        email: schema.user.email,
        role: schema.member.role,
        grant: schema.brandAccess.memberId,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .leftJoin(
        schema.brandAccess,
        and(
          eq(schema.brandAccess.orgId, orgId),
          eq(schema.brandAccess.brandId, brandId),
          eq(schema.brandAccess.memberId, schema.member.id),
        ),
      )
      .where(eq(schema.member.organizationId, orgId))
      .orderBy(sql`lower(${schema.user.name})`, schema.member.id);
    return {
      members: members.map(({ grant, ...member }) => ({
        ...member,
        hasAccess: MANAGER_ROLES.includes(member.role) || grant !== null,
      })),
    };
  }
}
