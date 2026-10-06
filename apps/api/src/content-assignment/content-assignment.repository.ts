import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type ContentAssignmentUpdate,
  hasOrganizationRole,
  isOrganizationManager,
  ORGANIZATION_ROLES,
} from "@pubrick/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { badRequest, conflict, forbidden, notFound } from "../api-error";
import { db } from "../db";
import { holdOrganization } from "../organization-lock";
import { eligibleAssignmentSql } from "./content-assignment.query";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const assignmentColumns = {
  revision: schema.contentAssignments.revision,
  memberId: schema.contentAssignments.assigneeMemberId,
  userId: schema.contentAssignments.assigneeUserId,
  name: schema.contentAssignments.assigneeName,
};
const historyColumns = {
  id: schema.contentAssignmentHistory.id,
  revision: schema.contentAssignmentHistory.revision,
  previousName: schema.contentAssignmentHistory.previousName,
  assigneeName: schema.contentAssignmentHistory.assigneeName,
  actorName: schema.contentAssignmentHistory.actorName,
  createdAt: schema.contentAssignmentHistory.createdAt,
};

@Injectable()
export class ContentAssignmentRepository {
  async get(orgId: string, itemId: string, cursor?: string) {
    return db.transaction(async (tx) => {
      const item = await this.holdItem(orgId, itemId, tx, "share");
      return this.state(orgId, itemId, item.brandId, tx, cursor);
    });
  }

  async update(orgId: string, itemId: string, actorUserId: string, input: ContentAssignmentUpdate) {
    return db.transaction(async (tx) => {
      await holdOrganization(tx, orgId);
      const item = await this.discoverItem(orgId, itemId, tx);
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, item.brandId)))
        .for("key share");
      if (!brand) throw notFound("content_not_found", "Content item not found");

      const [target] =
        input.memberId === null
          ? []
          : await tx
              .select({ userId: schema.member.userId })
              .from(schema.member)
              .where(
                and(eq(schema.member.organizationId, orgId), eq(schema.member.id, input.memberId)),
              );
      if (input.memberId !== null && !target)
        throw badRequest(
          "assignment_member_unavailable",
          "Choose a current member with access to this brand",
        );
      // SHARE blocks role edits and removal; the earlier brand lock fences grant replacement.
      const memberships = await tx
        .select({ id: schema.member.id, userId: schema.member.userId, role: schema.member.role })
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, orgId),
            inArray(schema.member.userId, target ? [actorUserId, target.userId] : [actorUserId]),
          ),
        )
        .orderBy(schema.member.id)
        .for("share");
      const actorMemberships = memberships.filter((m) => m.userId === actorUserId);
      const actorRole = actorMemberships.map((m) => m.role).join(",");
      if (!hasOrganizationRole(actorRole, ["owner", "admin", "member", "editor"]))
        throw forbidden("invalid_request", "An editor is required to assign content");
      const eligible = await this.members(orgId, item.brandId, tx);
      if (!eligible.some((m) => m.userId === actorUserId))
        throw notFound("content_not_found", "Content item not found");
      const eligibleUser =
        target && memberships.some((m) => m.id === input.memberId && m.userId === target.userId)
          ? eligible.find((m) => m.userId === target.userId)
          : null;
      const assignee =
        input.memberId === null || !eligibleUser
          ? null
          : { ...eligibleUser, memberId: input.memberId };
      if (input.memberId !== null && !assignee)
        throw badRequest(
          "assignment_member_unavailable",
          "Choose a current member with access to this brand",
        );
      const [locked] = await tx
        .select({ id: schema.contentItems.id })
        .from(schema.contentItems)
        .where(
          and(
            eq(schema.contentItems.orgId, orgId),
            eq(schema.contentItems.brandId, item.brandId),
            eq(schema.contentItems.id, itemId),
          ),
        )
        .for("no key update");
      if (!locked) throw notFound("content_not_found", "Content item not found");
      const [current] = await tx
        .select(assignmentColumns)
        .from(schema.contentAssignments)
        .where(
          and(
            eq(schema.contentAssignments.orgId, orgId),
            eq(schema.contentAssignments.contentItemId, itemId),
          ),
        )
        .for("update");
      const revision = current?.revision ?? 0;
      if (revision !== input.expectedRevision)
        throw conflict("assignment_changed", "Assignment changed; reload before saving");
      if ((current?.memberId ?? null) === input.memberId)
        return this.state(orgId, itemId, item.brandId, tx);
      const [actor] = await tx
        .select({ name: schema.user.name })
        .from(schema.user)
        .where(eq(schema.user.id, actorUserId));
      if (!actor) throw forbidden("invalid_request", "The assigning account no longer exists");
      const next = {
        orgId,
        brandId: item.brandId,
        contentItemId: itemId,
        revision: revision + 1,
        assigneeMemberId: assignee?.memberId ?? null,
        assigneeUserId: assignee?.userId ?? null,
        assigneeName: assignee?.name ?? null,
        updatedAt: new Date(),
      };
      await tx
        .insert(schema.contentAssignments)
        .values(next)
        .onConflictDoUpdate({ target: schema.contentAssignments.contentItemId, set: next });
      await tx.insert(schema.contentAssignmentHistory).values({
        orgId,
        brandId: item.brandId,
        contentItemId: itemId,
        revision: next.revision,
        previousMemberId: current?.memberId ?? null,
        previousName: current?.name ?? null,
        assigneeMemberId: assignee?.memberId ?? null,
        assigneeName: assignee?.name ?? null,
        actorUserId,
        actorName: actor.name,
      });
      return this.state(orgId, itemId, item.brandId, tx);
    });
  }

  private async discoverItem(orgId: string, itemId: string, tx: Tx) {
    const [item] = await tx
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)));
    if (!item) throw notFound("content_not_found", "Content item not found");
    return item;
  }

  private async holdItem(orgId: string, itemId: string, tx: Tx, lock: "share") {
    await holdOrganization(tx, orgId);
    const item = await this.discoverItem(orgId, itemId, tx);
    const [brand] = await tx
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, item.brandId)))
      .for("key share");
    if (!brand) throw notFound("content_not_found", "Content item not found");
    const [locked] = await tx
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.contentItems)
      .where(
        and(
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.brandId, item.brandId),
          eq(schema.contentItems.id, itemId),
        ),
      )
      .for(lock);
    if (!locked) throw notFound("content_not_found", "Content item not found");
    return locked;
  }

  private async members(orgId: string, brandId: string, tx: Tx) {
    const rows = await tx
      .select({
        memberId: schema.member.id,
        userId: schema.member.userId,
        role: schema.member.role,
        name: schema.user.name,
        grant: schema.brandAccess.memberId,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .leftJoin(
        schema.brandAccess,
        and(
          eq(schema.brandAccess.orgId, orgId),
          eq(schema.brandAccess.brandId, brandId),
          eq(schema.brandAccess.memberId, schema.member.id),
        ),
      )
      .where(eq(schema.member.organizationId, orgId))
      .orderBy(schema.member.id);
    const users = new Map<string, typeof rows>();
    for (const row of rows) users.set(row.userId, [...(users.get(row.userId) ?? []), row]);
    return [...users.values()]
      .flatMap((members) => {
        const first = members[0];
        const role = members.map((m) => m.role).join(",");
        if (
          !first ||
          !hasOrganizationRole(role, ORGANIZATION_ROLES) ||
          (!isOrganizationManager(role) && !members.some((m) => m.grant !== null))
        )
          return [];
        return [{ memberId: first.memberId, userId: first.userId, name: first.name }];
      })
      .sort((a, b) => a.name.localeCompare(b.name, "en") || a.memberId.localeCompare(b.memberId));
  }

  private async state(orgId: string, itemId: string, brandId: string, tx: Tx, cursor?: string) {
    const [assignment] = await tx
      .select({ ...assignmentColumns, eligible: eligibleAssignmentSql() })
      .from(schema.contentAssignments)
      .where(
        and(
          eq(schema.contentAssignments.orgId, orgId),
          eq(schema.contentAssignments.contentItemId, itemId),
        ),
      );
    const [before] = cursor
      ? await tx
          .select({ revision: schema.contentAssignmentHistory.revision })
          .from(schema.contentAssignmentHistory)
          .where(
            and(
              eq(schema.contentAssignmentHistory.orgId, orgId),
              eq(schema.contentAssignmentHistory.contentItemId, itemId),
              eq(schema.contentAssignmentHistory.id, cursor),
            ),
          )
      : [];
    if (cursor && !before)
      throw badRequest(
        "invalid_request",
        "Assignment history cursor does not belong to this content",
      );
    const rows = await tx
      .select(historyColumns)
      .from(schema.contentAssignmentHistory)
      .where(
        and(
          eq(schema.contentAssignmentHistory.orgId, orgId),
          eq(schema.contentAssignmentHistory.contentItemId, itemId),
          before
            ? sql`${schema.contentAssignmentHistory.revision} < ${before.revision}`
            : undefined,
        ),
      )
      .orderBy(desc(schema.contentAssignmentHistory.revision))
      .limit(21);
    return {
      revision: assignment?.revision ?? 0,
      assignee:
        assignment?.memberId != null && assignment.userId !== null && assignment.name !== null
          ? {
              memberId: assignment.memberId,
              userId: assignment.userId,
              name: assignment.name,
              eligible: assignment.eligible,
            }
          : null,
      members: await this.members(orgId, brandId, tx),
      history: {
        rows: rows.slice(0, 20),
        nextCursor: rows.length > 20 ? (rows[19]?.id ?? null) : null,
      },
    };
  }
}
