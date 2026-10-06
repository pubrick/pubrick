import { schema } from "@pubrick/db";
import {
  type ContentAssignmentSummary,
  isOrganizationManager,
  ORGANIZATION_ROLES,
} from "@pubrick/shared";
import { sql } from "drizzle-orm";

/** Same eligibility rule for summaries and server-side queue filtering. */
export function eligibleAssignmentSql() {
  // Identifiers preserve the outer assignment correlation when this expression
  // is embedded in a single-table SELECT, whose Column chunks Drizzle dequalifies.
  const table = sql.identifier("content_assignments");
  const a = {
    orgId: sql`${table}.${sql.identifier("org_id")}`,
    brandId: sql`${table}.${sql.identifier("brand_id")}`,
    assigneeMemberId: sql`${table}.${sql.identifier("assignee_member_id")}`,
    assigneeUserId: sql`${table}.${sql.identifier("assignee_user_id")}`,
  };
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

/** Public assignment metadata rides the bounded master page without another read or an ID placeholder per row. */
export function contentAssignmentSummarySql() {
  return sql<ContentAssignmentSummary>`coalesce((
    select jsonb_build_object(
      'revision', content_assignments.revision,
      'assignee', case when content_assignments.assignee_member_id is not null
        and content_assignments.assignee_user_id is not null and content_assignments.assignee_name is not null
        then jsonb_build_object('memberId', content_assignments.assignee_member_id,
          'userId', content_assignments.assignee_user_id, 'name', content_assignments.assignee_name,
          'eligible', ${eligibleAssignmentSql()}) else null end
    ) from ${schema.contentAssignments}
    where content_assignments.org_id = "content_items"."org_id"
      and content_assignments.brand_id = "content_items"."brand_id"
      and content_assignments.content_item_id = "content_items"."id"
  ), jsonb_build_object('revision', 0, 'assignee', null))`;
}
