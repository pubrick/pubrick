import { schema } from "@pubrick/db";
import {
  type ContentAssignmentSummary,
  isOrganizationManager,
  ORGANIZATION_ROLES,
} from "@pubrick/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";

/** Same eligibility rule for summaries and server-side queue filtering. */
export function eligibleAssignmentSql() {
  const a = schema.contentAssignments;
  return sql<boolean>`exists (
    select 1 from member as assigned_member
    where assigned_member.organization_id = ${a.orgId}
      and assigned_member.id = ${a.assigneeMemberId}
      and assigned_member.user_id = ${a.assigneeUserId}
      and exists (
        select 1 from member as recognized_member,
          lateral unnest(string_to_array(recognized_member.role, ',')) as recognized_role(value)
        where recognized_member.organization_id = ${a.orgId}
          and recognized_member.user_id = assigned_member.user_id
          and recognized_role.value = any(${sql.param([...ORGANIZATION_ROLES])}::text[])
      )
      and (
        exists (
          select 1 from member as manager_member,
            lateral unnest(string_to_array(manager_member.role, ',')) as manager_role(value)
          where manager_member.organization_id = ${a.orgId}
            and manager_member.user_id = assigned_member.user_id
            and manager_role.value = any(${sql.param(ORGANIZATION_ROLES.filter(isOrganizationManager))}::text[])
        ) or exists (
          select 1 from brand_access as assigned_grant
          inner join member as granted_member on granted_member.id = assigned_grant.member_id
            and granted_member.organization_id = assigned_grant.org_id
          where assigned_grant.org_id = ${a.orgId}
            and assigned_grant.brand_id = ${a.brandId}
            and granted_member.user_id = assigned_member.user_id
        )
      )
  )`;
}

/** A queue filter narrows SQL before the keyset limit; it never filters a page in memory. */
export function assignmentQueuePredicate(
  orgId: string,
  filter: "mine" | "unassigned",
  userId: string,
) {
  const active = sql<boolean>`exists (
    select 1 from ${schema.contentAssignments}
    where ${schema.contentAssignments.orgId} = ${orgId}
      and ${schema.contentAssignments.contentItemId} = ${schema.contentItems.id}
      and ${schema.contentAssignments.brandId} = ${schema.contentItems.brandId}
      ${filter === "mine" ? sql`and ${schema.contentAssignments.assigneeUserId} = ${userId}` : sql``}
      and ${eligibleAssignmentSql()}
  )`;
  return filter === "mine" ? active : sql<boolean>`not (${active})`;
}

export async function contentAssignmentSummaries(orgId: string, itemIds: string[]) {
  const rows =
    itemIds.length === 0
      ? []
      : await db
          .select({
            itemId: schema.contentAssignments.contentItemId,
            revision: schema.contentAssignments.revision,
            memberId: schema.contentAssignments.assigneeMemberId,
            userId: schema.contentAssignments.assigneeUserId,
            name: schema.contentAssignments.assigneeName,
            eligible: eligibleAssignmentSql(),
          })
          .from(schema.contentAssignments)
          .where(
            and(
              eq(schema.contentAssignments.orgId, orgId),
              inArray(schema.contentAssignments.contentItemId, itemIds),
            ),
          );
  return new Map<string, ContentAssignmentSummary>(
    rows.map((row) => [
      row.itemId,
      {
        revision: row.revision,
        assignee:
          row.memberId !== null && row.userId !== null && row.name !== null
            ? {
                memberId: row.memberId,
                userId: row.userId,
                name: row.name,
                eligible: row.eligible,
              }
            : null,
      },
    ]),
  );
}
