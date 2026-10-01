import { type BillingTransaction, schema } from "@pubrick/db";
import {
  hasOrganizationRole,
  isOrganizationManager,
  ORGANIZATION_ROLES,
  PUBLIC_WRITE_OPERATIONS,
  type PublicWriteOperation,
} from "@pubrick/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { brandIdForResource } from "./org/brand-resource";
import { currentRequestAuthority } from "./request-authority";

export type ExpectedApiOperation = Readonly<{
  operation: PublicWriteOperation;
  brandId: string;
  channelIds: readonly string[];
}>;

/** Call only after admission advisory -> tenant lock. Never reads caller-controlled actor fields. */
export async function authorizeRequestActor(
  tx: BillingTransaction,
  orgId: string,
  expected?: ExpectedApiOperation,
): Promise<boolean> {
  const actor = currentRequestAuthority();
  if (!actor || actor.orgId !== orgId) return false;
  if (actor.kind === "api-key") {
    if (
      !expected ||
      !(PUBLIC_WRITE_OPERATIONS as readonly string[]).includes(expected.operation) ||
      actor.operation !== expected.operation ||
      actor.scope !== expected.operation ||
      !expected.channelIds.length ||
      new Set(expected.channelIds).size !== expected.channelIds.length
    )
      return false;
    const [key] = await tx
      .select({ id: schema.organizationApiKeys.id })
      .from(schema.organizationApiKeys)
      .where(
        and(
          eq(schema.organizationApiKeys.id, actor.keyId),
          eq(schema.organizationApiKeys.orgId, orgId),
          eq(schema.organizationApiKeys.scope, actor.scope),
          isNull(schema.organizationApiKeys.revokedAt),
        ),
      )
      .for("share");
    if (!key) return false;
    const [brand] = await tx
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, expected.brandId)))
      .for("key share");
    if (!brand) return false;
    const targets = await tx
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, expected.brandId),
          inArray(schema.channels.id, [...expected.channelIds]),
        ),
      )
      .for("key share");
    return targets.length === expected.channelIds.length;
  }
  const [session] = await tx
    .select({ id: schema.session.id })
    .from(schema.session)
    .where(
      and(
        eq(schema.session.id, actor.sessionId),
        eq(schema.session.userId, actor.userId),
        eq(schema.session.activeOrganizationId, orgId),
        sql`${schema.session.expiresAt} > clock_timestamp()`,
      ),
    )
    .for("share");
  if (!session) return false;
  const [user] = await tx
    .select({ verified: schema.user.emailVerified })
    .from(schema.user)
    .where(eq(schema.user.id, actor.userId))
    .for("share");
  if (!user?.verified) return false;
  const members = await tx
    .select({ id: schema.member.id, role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, actor.userId)));
  const role = members.map((member) => member.role).join(",");
  if (!hasOrganizationRole(role, ORGANIZATION_ROLES)) return false;
  const manager = isOrganizationManager(role);
  const editorial =
    !manager &&
    !hasOrganizationRole(role, ["member"]) &&
    hasOrganizationRole(role, ["author", "editor"]);
  // Check the database clock again after any user/brand/billing lock wait.
  const sessionCurrent = async () => {
    const [current] = await tx
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(
        and(
          eq(schema.session.id, actor.sessionId),
          sql`${schema.session.expiresAt} > clock_timestamp()`,
        ),
      );
    return Boolean(current);
  };
  const scope = actor.scope;
  if ("roles" in scope && scope.roles === "manager" && !manager) return false;
  if (editorial && actor.mutation) {
    if (scope.kind === "org-list" || (scope.kind === "org" && !scope.editorialBrand)) return false;
    if (
      !actor.capability ||
      (actor.capability === "editor" && !hasOrganizationRole(role, ["editor"]))
    )
      return false;
  }
  if (scope.kind === "org" || scope.kind === "org-list") {
    if (!actor.brandId) return (!editorial || !actor.mutation) && (await sessionCurrent());
  }
  const brandId = actor.brandId;
  if (!brandId) return false;
  // Brand grant replacement holds UPDATE on the brand first. This compatible
  // lock precedes grant lookup and persists through insertion/lease commit.
  const [brand] = await tx
    .select({ id: schema.brands.id })
    .from(schema.brands)
    .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
    .for("key share");
  if (!brand) return false;
  if (scope.kind === "resource") {
    if (
      !actor.resourceId ||
      (await brandIdForResource(orgId, scope.resource, actor.resourceId, tx)) !== brandId
    )
      return false;
  }
  if (!(await sessionCurrent())) return false;
  if (manager) return true;
  const [grant] = await tx
    .select({ id: schema.brandAccess.memberId })
    .from(schema.brandAccess)
    .where(
      and(
        eq(schema.brandAccess.orgId, orgId),
        eq(schema.brandAccess.brandId, brandId),
        inArray(
          schema.brandAccess.memberId,
          members.map((member) => member.id),
        ),
      ),
    )
    .limit(1);
  return Boolean(grant);
}
