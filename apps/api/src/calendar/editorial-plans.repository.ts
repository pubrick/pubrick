import { Injectable } from "@nestjs/common";
import {
  calculateEditorialPlanOccurrences,
  type EditorialPlanOccurrenceRow,
  EditorialPlanPersistenceError,
  type EditorialPlanRow,
  EditorialPlansPersistence,
  editorialPlanColumns,
  editorialPlanLocalDate,
  editorialPlanOccurrenceColumns,
  schema,
} from "@pubrick/db";
import {
  type EditorialPlanCreate,
  type EditorialPlanEnable,
  type EditorialPlanOccurrencesQuery,
  type EditorialPlanPreview,
  type EditorialPlanUpdate,
  editorialPlanOccurrenceSchema,
  editorialPlanOccurrencesPageSchema,
  editorialPlanSummarySchema,
} from "@pubrick/shared";
import { and, asc, eq, gt, gte, isNull } from "drizzle-orm";
import { ZodError } from "zod";
import { badRequest, conflict, forbidden, notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";
import { currentRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";

function sessionActor(orgId: string, brandId: string) {
  const actor = currentRequestAuthority();
  if (actor?.kind !== "session" || actor.orgId !== orgId || actor.brandId !== brandId)
    throw forbidden(
      "editorial_plan_session_required",
      "Recurring plans require an authenticated organization session",
    );
  return actor;
}
export function editorialPlanApiError(error: unknown): never {
  if (error instanceof EditorialPlanPersistenceError) {
    switch (error.code) {
      case "not_found":
        throw notFound("editorial_plan_not_found", "Editorial plan not found");
      case "revision_conflict":
        throw conflict(
          "editorial_plan_revision_conflict",
          "The plan changed; reload it before trying again",
        );
      case "removed":
        throw conflict("editorial_plan_removed", "The plan has been removed");
      case "already_enabled":
        throw conflict("editorial_plan_already_enabled", "The plan is already enabled");
      case "plan_limit":
        throw conflict("editorial_plan_limit", "A brand may retain at most five nonremoved plans");
      case "retention_capacity_reached":
        throw conflict(
          "editorial_plan_retention_capacity",
          "Retained occurrence capacity has been reached",
        );
      case "channels_missing":
        throw badRequest(
          "editorial_plan_channels_missing",
          "Select existing channels belonging to this brand",
        );
      case "authority_revoked":
        throw forbidden(
          "editorial_plan_authority_revoked",
          "The session or editorial authority changed",
        );
      case "not_dispatchable":
        throw conflict("calendar_slot_started", "Generation has already started for this slot");
    }
  }
  if (error instanceof RangeError || error instanceof ZodError)
    throw badRequest(
      "invalid_request",
      "Use a valid weekly schedule, IANA zone and finite calendar date range",
    );
  throw error;
}
export function editorialOccurrenceDto(row: EditorialPlanOccurrenceRow) {
  return editorialPlanOccurrenceSchema.parse({
    id: row.id,
    planId: row.planId,
    localDate: row.localDate,
    localTime: row.localTime,
    timezone: row.timezone,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    offsetMinutes: row.offsetMinutes,
    planRevision: row.planRevision,
    brief: row.brief,
    channelIds: row.channelIds,
    state: row.state,
    reason: row.reason,
    consentVersion: row.consentVersion,
    consentingActorId: row.consentingActorId,
    consentedAt: row.consentedAt?.toISOString() ?? null,
    consentedRevision: row.consentedRevision,
    slotId: row.slotId,
    runId: row.runId,
  });
}

@Injectable()
export class EditorialPlansRepository {
  constructor(private readonly queue: QueueService) {}
  private persistence(orgId: string, brandId: string) {
    sessionActor(orgId, brandId);
    return new EditorialPlansPersistence(db, async (tenant, tx, brand) => {
      const actor = currentRequestAuthority();
      return (
        actor?.kind === "session" &&
        actor.orgId === tenant &&
        actor.brandId === brand &&
        (await authorizeRequestActor(tx, tenant))
      );
    });
  }
  private async summary(orgId: string, plan: EditorialPlanRow, now: Date) {
    const today = editorialPlanLocalDate(plan.timezone, now);
    const occurrences = await db
      .select(editorialPlanOccurrenceColumns)
      .from(schema.editorialPlanOccurrences)
      .where(
        and(
          eq(schema.editorialPlanOccurrences.orgId, orgId),
          eq(schema.editorialPlanOccurrences.brandId, plan.brandId),
          eq(schema.editorialPlanOccurrences.planId, plan.id),
          gte(schema.editorialPlanOccurrences.localDate, today),
        ),
      )
      .orderBy(asc(schema.editorialPlanOccurrences.localDate))
      .limit(14);
    return editorialPlanSummarySchema.parse({
      id: plan.id,
      brandId: plan.brandId,
      name: plan.name,
      brief: plan.brief,
      channelIds: plan.channelIds,
      weekdays: plan.weekdays,
      localTime: plan.localTime,
      timezone: plan.timezone,
      startDate: plan.startDate,
      endDate: plan.endDate,
      enabled: plan.enabled,
      ended: today > plan.endDate,
      revision: plan.revision,
      consentVersion: plan.consentVersion,
      consentingActorId: plan.consentingActorId,
      consentedAt: plan.consentedAt?.toISOString() ?? null,
      consentedRevision: plan.consentedRevision,
      blockedReason:
        plan.blockedReason ??
        occurrences.find((row) => row.state === "planned" && row.reason)?.reason ??
        null,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      occurrences: occurrences.map(editorialOccurrenceDto),
    });
  }
  async list(orgId: string, brandId: string) {
    sessionActor(orgId, brandId);
    const plans = await db.transaction(async (tx) => {
      const [org] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("share");
      if (!org || !(await authorizeRequestActor(tx, orgId)))
        throw forbidden(
          "editorial_plan_authority_revoked",
          "The session or brand authority changed",
        );
      return tx
        .select(editorialPlanColumns)
        .from(schema.editorialPlans)
        .where(
          and(
            eq(schema.editorialPlans.orgId, orgId),
            eq(schema.editorialPlans.brandId, brandId),
            isNull(schema.editorialPlans.removedAt),
          ),
        )
        .orderBy(asc(schema.editorialPlans.id))
        .limit(5);
    });
    return Promise.all(plans.map((plan) => this.summary(orgId, plan, new Date())));
  }
  async preview(orgId: string, brandId: string, schedule: EditorialPlanPreview) {
    sessionActor(orgId, brandId);
    try {
      return calculateEditorialPlanOccurrences(schedule, new Date());
    } catch (error) {
      editorialPlanApiError(error);
    }
  }
  async create(orgId: string, input: EditorialPlanCreate) {
    try {
      const now = new Date();
      const plan = await this.persistence(orgId, input.brandId).create(orgId, input, now);
      return this.summary(orgId, plan, now);
    } catch (error) {
      editorialPlanApiError(error);
    }
  }
  async update(orgId: string, brandId: string, id: string, input: EditorialPlanUpdate) {
    try {
      const now = new Date();
      const plan = await this.persistence(orgId, brandId).update(orgId, brandId, id, input, now);
      if (!plan) throw new Error("Plan update returned no row");
      return this.summary(orgId, plan, now);
    } catch (error) {
      editorialPlanApiError(error);
    }
  }
  async enable(orgId: string, brandId: string, id: string, input: EditorialPlanEnable) {
    try {
      const actor = sessionActor(orgId, brandId);
      const now = new Date();
      const plan = await this.persistence(orgId, brandId).enable(
        orgId,
        brandId,
        id,
        input,
        actor.userId,
        now,
        (tx, enabled) =>
          this.queue.enqueueEditorialPlan({ orgId, brandId, planId: enabled.id }, tx),
      );
      return this.summary(orgId, plan, now);
    } catch (error) {
      editorialPlanApiError(error);
    }
  }
  async pause(orgId: string, brandId: string, id: string, input: { expectedRevision: number }) {
    try {
      const now = new Date();
      const plan = await this.persistence(orgId, brandId).pause(orgId, brandId, id, input, now);
      if (!plan) throw new Error("Plan pause returned no row");
      return this.summary(orgId, plan, now);
    } catch (error) {
      editorialPlanApiError(error);
    }
  }
  async remove(orgId: string, brandId: string, id: string, input: { expectedRevision: number }) {
    try {
      const plan = await this.persistence(orgId, brandId).remove(
        orgId,
        brandId,
        id,
        input,
        new Date(),
      );
      if (!plan) throw new Error("Plan removal returned no row");
      return { removed: true as const, revision: plan.revision };
    } catch (error) {
      editorialPlanApiError(error);
    }
  }
  async occurrences(
    orgId: string,
    brandId: string,
    id: string,
    query: EditorialPlanOccurrencesQuery,
  ) {
    sessionActor(orgId, brandId);
    const [plan] = await db
      .select({ id: schema.editorialPlans.id })
      .from(schema.editorialPlans)
      .where(
        and(
          eq(schema.editorialPlans.orgId, orgId),
          eq(schema.editorialPlans.brandId, brandId),
          eq(schema.editorialPlans.id, id),
        ),
      );
    if (!plan) throw notFound("editorial_plan_not_found", "Editorial plan not found");
    const rows = await db
      .select(editorialPlanOccurrenceColumns)
      .from(schema.editorialPlanOccurrences)
      .where(
        and(
          eq(schema.editorialPlanOccurrences.orgId, orgId),
          eq(schema.editorialPlanOccurrences.brandId, brandId),
          eq(schema.editorialPlanOccurrences.planId, id),
          query.cursor ? gt(schema.editorialPlanOccurrences.id, query.cursor) : undefined,
        ),
      )
      .orderBy(asc(schema.editorialPlanOccurrences.id))
      .limit(query.limit + 1);
    return editorialPlanOccurrencesPageSchema.parse({
      rows: rows.slice(0, query.limit).map(editorialOccurrenceDto),
      nextCursor: rows.length > query.limit ? (rows[query.limit - 1]?.id ?? null) : null,
    });
  }
}
