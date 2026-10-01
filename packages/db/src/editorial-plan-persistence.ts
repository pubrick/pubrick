import {
  type EditorialPlanCreate,
  type EditorialPlanEnable,
  type EditorialPlanUpdate,
  editorialPlanCreateSchema,
  editorialPlanEnableSchema,
  editorialPlanRevisionSchema,
  editorialPlanUpdateSchema,
  MAX_EDITORIAL_PLAN_OCCURRENCES_PER_BRAND,
  MAX_EDITORIAL_PLANS_PER_BRAND,
} from "@pubrick/shared";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { createDb } from "./client.js";
import {
  calculateEditorialPlanOccurrences,
  validateEditorialPlanSchedule,
} from "./editorial-plan-occurrences.js";
import * as schema from "./schema/index.js";

type Database = ReturnType<typeof createDb>["db"];
export type EditorialPlanTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type EditorialPlanPersistenceCode =
  | "not_found"
  | "revision_conflict"
  | "removed"
  | "already_enabled"
  | "plan_limit"
  | "retention_capacity_reached"
  | "channels_missing"
  | "not_dispatchable"
  | "authority_revoked";
export class EditorialPlanPersistenceError extends Error {
  constructor(readonly code: EditorialPlanPersistenceCode) {
    super(code);
  }
}

export const editorialPlanColumns = {
  id: schema.editorialPlans.id,
  orgId: schema.editorialPlans.orgId,
  brandId: schema.editorialPlans.brandId,
  name: schema.editorialPlans.name,
  brief: schema.editorialPlans.brief,
  channelIds: schema.editorialPlans.channelIds,
  weekdays: schema.editorialPlans.weekdays,
  localTime: schema.editorialPlans.localTime,
  timezone: schema.editorialPlans.timezone,
  startDate: schema.editorialPlans.startDate,
  endDate: schema.editorialPlans.endDate,
  enabled: schema.editorialPlans.enabled,
  revision: schema.editorialPlans.revision,
  consentVersion: schema.editorialPlans.consentVersion,
  consentingActorId: schema.editorialPlans.consentingActorId,
  consentedAt: schema.editorialPlans.consentedAt,
  consentedRevision: schema.editorialPlans.consentedRevision,
  blockedReason: schema.editorialPlans.blockedReason,
  removedAt: schema.editorialPlans.removedAt,
  createdAt: schema.editorialPlans.createdAt,
  updatedAt: schema.editorialPlans.updatedAt,
};
export const editorialPlanOccurrenceColumns = {
  id: schema.editorialPlanOccurrences.id,
  orgId: schema.editorialPlanOccurrences.orgId,
  brandId: schema.editorialPlanOccurrences.brandId,
  planId: schema.editorialPlanOccurrences.planId,
  localDate: schema.editorialPlanOccurrences.localDate,
  localTime: schema.editorialPlanOccurrences.localTime,
  timezone: schema.editorialPlanOccurrences.timezone,
  scheduledAt: schema.editorialPlanOccurrences.scheduledAt,
  offsetMinutes: schema.editorialPlanOccurrences.offsetMinutes,
  planRevision: schema.editorialPlanOccurrences.planRevision,
  brief: schema.editorialPlanOccurrences.brief,
  channelIds: schema.editorialPlanOccurrences.channelIds,
  state: schema.editorialPlanOccurrences.state,
  reason: schema.editorialPlanOccurrences.reason,
  slotId: schema.editorialPlanOccurrences.slotId,
  runId: schema.editorialPlanOccurrences.runId,
  dispatchedAt: schema.editorialPlanOccurrences.dispatchedAt,
  consentVersion: schema.editorialPlanOccurrences.consentVersion,
  consentingActorId: schema.editorialPlanOccurrences.consentingActorId,
  consentedAt: schema.editorialPlanOccurrences.consentedAt,
  consentedRevision: schema.editorialPlanOccurrences.consentedRevision,
  createdAt: schema.editorialPlanOccurrences.createdAt,
  updatedAt: schema.editorialPlanOccurrences.updatedAt,
};
export type EditorialPlanRow = typeof schema.editorialPlans.$inferSelect;
export type EditorialPlanOccurrenceRow = typeof schema.editorialPlanOccurrences.$inferSelect;
const clearedConsent = {
  consentVersion: null,
  consentingActorId: null,
  consentedAt: null,
  consentedRevision: null,
};
const planScope = (orgId: string, brandId: string, planId: string) =>
  and(
    eq(schema.editorialPlans.orgId, orgId),
    eq(schema.editorialPlans.brandId, brandId),
    eq(schema.editorialPlans.id, planId),
  );
const occurrenceScope = (orgId: string, brandId: string, planId: string) =>
  and(
    eq(schema.editorialPlanOccurrences.orgId, orgId),
    eq(schema.editorialPlanOccurrences.brandId, brandId),
    eq(schema.editorialPlanOccurrences.planId, planId),
  );

/** Quota-growing mutations and materialization serialize on this parent lock. */
export async function lockEditorialPlanParents(
  orgId: string,
  tx: EditorialPlanTransaction,
  brandId: string,
  authorizeActor?: EditorialPlanActorAuthorization,
) {
  const [org] = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .for("share");
  if (!org) throw new EditorialPlanPersistenceError("not_found");
  if (authorizeActor && !(await authorizeActor(orgId, tx, brandId)))
    throw new EditorialPlanPersistenceError("authority_revoked");
  const [brand] = await tx
    .select({ id: schema.brands.id })
    .from(schema.brands)
    .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
    .for("no key update");
  if (!brand) throw new EditorialPlanPersistenceError("not_found");
}
export async function lockEditorialPlan(
  orgId: string,
  tx: EditorialPlanTransaction,
  brandId: string,
  planId: string,
) {
  const [plan] = await tx
    .select(editorialPlanColumns)
    .from(schema.editorialPlans)
    .where(planScope(orgId, brandId, planId))
    .for("update");
  if (!plan) throw new EditorialPlanPersistenceError("not_found");
  return plan;
}
function requireRevision(plan: EditorialPlanRow, expectedRevision: number) {
  if (plan.revision !== expectedRevision)
    throw new EditorialPlanPersistenceError("revision_conflict");
}
function requireLive(plan: EditorialPlanRow) {
  if (plan.removedAt) throw new EditorialPlanPersistenceError("removed");
}
async function retainedCount(tx: EditorialPlanTransaction, orgId: string, brandId: string) {
  const [row] = await tx
    .select({ total: count() })
    .from(schema.editorialPlanOccurrences)
    .where(
      and(
        eq(schema.editorialPlanOccurrences.orgId, orgId),
        eq(schema.editorialPlanOccurrences.brandId, brandId),
      ),
    );
  return row?.total ?? 0;
}
async function requireCapacity(
  tx: EditorialPlanTransaction,
  orgId: string,
  brandId: string,
  needed: number,
) {
  if ((await retainedCount(tx, orgId, brandId)) + needed > MAX_EDITORIAL_PLAN_OCCURRENCES_PER_BRAND)
    throw new EditorialPlanPersistenceError("retention_capacity_reached");
}
async function requireChannels(
  tx: EditorialPlanTransaction,
  orgId: string,
  brandId: string,
  channelIds: string[],
) {
  const rows = await tx
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.orgId, orgId),
        eq(schema.channels.brandId, brandId),
        inArray(schema.channels.id, channelIds),
      ),
    );
  if (rows.length !== channelIds.length)
    throw new EditorialPlanPersistenceError("channels_missing");
}
const scheduleOf = (plan: EditorialPlanRow) => ({
  weekdays: plan.weekdays,
  localTime: plan.localTime,
  timezone: plan.timezone,
  startDate: plan.startDate,
  endDate: plan.endDate,
});
async function lockOccurrences(
  tx: EditorialPlanTransaction,
  orgId: string,
  brandId: string,
  planId: string,
) {
  return tx
    .select(editorialPlanOccurrenceColumns)
    .from(schema.editorialPlanOccurrences)
    .where(occurrenceScope(orgId, brandId, planId))
    .orderBy(asc(schema.editorialPlanOccurrences.id))
    .for("update");
}
async function deleteOwnedSlots(
  tx: EditorialPlanTransaction,
  orgId: string,
  brandId: string,
  occurrenceIds: string[],
) {
  if (!occurrenceIds.length) return;
  const scope = and(
    eq(schema.calendarSlots.orgId, orgId),
    eq(schema.calendarSlots.brandId, brandId),
    inArray(schema.calendarSlots.recurringOccurrenceId, occurrenceIds),
    isNull(schema.calendarSlots.runId),
  );
  const slots = await tx
    .select({ id: schema.calendarSlots.id })
    .from(schema.calendarSlots)
    .where(scope)
    .orderBy(asc(schema.calendarSlots.id))
    .for("update");
  if (slots.length)
    await tx.delete(schema.calendarSlots).where(
      and(
        scope,
        inArray(
          schema.calendarSlots.id,
          slots.map((slot) => slot.id),
        ),
      ),
    );
}
async function suspendPending(
  tx: EditorialPlanTransaction,
  orgId: string,
  brandId: string,
  planId: string,
  removed: boolean,
  now: Date,
) {
  const occurrences = await lockOccurrences(tx, orgId, brandId, planId);
  const pending = occurrences.filter(
    (row) => !row.dispatchedAt && (row.state === "planned" || row.state === "suspended"),
  );
  if (!pending.length) return;
  const ids = pending.map((row) => row.id);
  await tx
    .update(schema.editorialPlanOccurrences)
    .set({
      state: removed ? "cancelled" : "suspended",
      reason: removed ? "plan_removed" : "plan_paused",
      updatedAt: now,
    })
    .where(
      and(
        occurrenceScope(orgId, brandId, planId),
        inArray(schema.editorialPlanOccurrences.id, ids),
      ),
    );
  await deleteOwnedSlots(tx, orgId, brandId, ids);
}

/** No authorization policy or provider call lives here; callers enforce session/editorial capability. */
export type EditorialPlanActorAuthorization = (
  orgId: string,
  tx: EditorialPlanTransaction,
  brandId: string,
) => Promise<boolean>;

export class EditorialPlansPersistence {
  constructor(
    private readonly db: Database,
    private readonly authorizeActor?: EditorialPlanActorAuthorization,
  ) {}

  async create(orgId: string, input: EditorialPlanCreate, now: Date) {
    const parsed = editorialPlanCreateSchema.parse(input);
    validateEditorialPlanSchedule({
      weekdays: parsed.weekdays,
      localTime: parsed.localTime,
      timezone: parsed.timezone,
      startDate: parsed.startDate,
      endDate: parsed.endDate,
    });
    return this.db.transaction(async (tx) => {
      await lockEditorialPlanParents(orgId, tx, parsed.brandId, this.authorizeActor);
      const [plans] = await tx
        .select({ total: count() })
        .from(schema.editorialPlans)
        .where(
          and(
            eq(schema.editorialPlans.orgId, orgId),
            eq(schema.editorialPlans.brandId, parsed.brandId),
            isNull(schema.editorialPlans.removedAt),
          ),
        );
      if ((plans?.total ?? 0) >= MAX_EDITORIAL_PLANS_PER_BRAND)
        throw new EditorialPlanPersistenceError("plan_limit");
      await requireCapacity(tx, orgId, parsed.brandId, 1);
      await requireChannels(tx, orgId, parsed.brandId, parsed.channelIds);
      const [plan] = await tx
        .insert(schema.editorialPlans)
        .values({ ...parsed, orgId, createdAt: now, updatedAt: now })
        .returning(editorialPlanColumns);
      if (!plan) throw new Error("Plan insert returned no row");
      return plan;
    });
  }

  async update(
    orgId: string,
    brandId: string,
    planId: string,
    input: EditorialPlanUpdate,
    now: Date,
  ) {
    const { expectedRevision, ...fields } = editorialPlanUpdateSchema.parse(input);
    validateEditorialPlanSchedule({
      weekdays: fields.weekdays,
      localTime: fields.localTime,
      timezone: fields.timezone,
      startDate: fields.startDate,
      endDate: fields.endDate,
    });
    return this.db.transaction(async (tx) => {
      await lockEditorialPlanParents(orgId, tx, brandId, this.authorizeActor);
      const plan = await lockEditorialPlan(orgId, tx, brandId, planId);
      requireRevision(plan, expectedRevision);
      requireLive(plan);
      if (fields.startDate < plan.startDate || fields.endDate > plan.endDate)
        await requireCapacity(tx, orgId, brandId, 1);
      await requireChannels(tx, orgId, brandId, fields.channelIds);
      await suspendPending(tx, orgId, brandId, planId, false, now);
      const [updated] = await tx
        .update(schema.editorialPlans)
        .set({
          ...fields,
          enabled: false,
          revision: plan.revision + 1,
          ...clearedConsent,
          blockedReason: null,
          updatedAt: now,
        })
        .where(planScope(orgId, brandId, planId))
        .returning(editorialPlanColumns);
      return updated;
    });
  }

  async enable(
    orgId: string,
    brandId: string,
    planId: string,
    input: EditorialPlanEnable,
    actorId: string,
    now: Date,
    enqueue: (tx: EditorialPlanTransaction, plan: EditorialPlanRow) => Promise<void>,
  ) {
    const parsed = editorialPlanEnableSchema.parse(input);
    if (!actorId || actorId.length > 255 || actorId.includes("\0"))
      throw new Error("Invalid consenting actor ID");
    return this.db.transaction(async (tx) => {
      await lockEditorialPlanParents(orgId, tx, brandId, this.authorizeActor);
      const plan = await lockEditorialPlan(orgId, tx, brandId, planId);
      requireRevision(plan, parsed.expectedRevision);
      requireLive(plan);
      if (plan.enabled) throw new EditorialPlanPersistenceError("already_enabled");
      const dates = calculateEditorialPlanOccurrences(scheduleOf(plan), now).occurrences;
      const existing = await lockOccurrences(tx, orgId, brandId, planId);
      const needed = dates.filter(
        (date) => !existing.some((row) => row.localDate === date.localDate),
      ).length;
      await requireCapacity(tx, orgId, brandId, needed);
      const [enabled] = await tx
        .update(schema.editorialPlans)
        .set({
          enabled: true,
          revision: plan.revision + 1,
          consentVersion: parsed.consentVersion,
          consentingActorId: actorId,
          consentedAt: now,
          consentedRevision: plan.revision + 1,
          blockedReason: null,
          updatedAt: now,
        })
        .where(planScope(orgId, brandId, planId))
        .returning(editorialPlanColumns);
      if (!enabled) throw new Error("Plan enable returned no row");
      await enqueue(tx, enabled);
      return enabled;
    });
  }

  async pause(
    orgId: string,
    brandId: string,
    planId: string,
    input: { expectedRevision: number },
    now: Date,
  ) {
    return this.stop(orgId, brandId, planId, input, now, false);
  }
  async remove(
    orgId: string,
    brandId: string,
    planId: string,
    input: { expectedRevision: number },
    now: Date,
  ) {
    return this.stop(orgId, brandId, planId, input, now, true);
  }
  private async stop(
    orgId: string,
    brandId: string,
    planId: string,
    input: { expectedRevision: number },
    now: Date,
    removed: boolean,
  ) {
    const { expectedRevision } = editorialPlanRevisionSchema.parse(input);
    return this.db.transaction(async (tx) => {
      await lockEditorialPlanParents(orgId, tx, brandId, this.authorizeActor);
      const plan = await lockEditorialPlan(orgId, tx, brandId, planId);
      requireRevision(plan, expectedRevision);
      if (plan.removedAt || (!removed && !plan.enabled)) return plan;
      await suspendPending(tx, orgId, brandId, planId, removed, now);
      const [stopped] = await tx
        .update(schema.editorialPlans)
        .set({
          enabled: false,
          revision: plan.revision + 1,
          ...clearedConsent,
          removedAt: removed ? now : null,
          blockedReason: null,
          updatedAt: now,
        })
        .where(planScope(orgId, brandId, planId))
        .returning(editorialPlanColumns);
      return stopped;
    });
  }

  async materialize(orgId: string, brandId: string, planId: string, now: Date) {
    return this.db.transaction(async (tx) => {
      await lockEditorialPlanParents(orgId, tx, brandId, this.authorizeActor);
      const plan = await lockEditorialPlan(orgId, tx, brandId, planId);
      if (!plan.enabled || plan.removedAt || plan.consentedRevision !== plan.revision)
        return { createdCount: 0, replannedCount: 0, blockedReason: null };
      const dates = calculateEditorialPlanOccurrences(scheduleOf(plan), now).occurrences;
      const existing = await lockOccurrences(tx, orgId, brandId, planId);
      const needed = dates.filter(
        (date) => !existing.some((row) => row.localDate === date.localDate),
      ).length;
      if (
        (await retainedCount(tx, orgId, brandId)) + needed >
        MAX_EDITORIAL_PLAN_OCCURRENCES_PER_BRAND
      ) {
        await tx
          .update(schema.editorialPlans)
          .set({ blockedReason: "retention_capacity_reached", updatedAt: now })
          .where(planScope(orgId, brandId, planId));
        return {
          createdCount: 0,
          replannedCount: 0,
          blockedReason: "retention_capacity_reached" as const,
        };
      }
      let createdCount = 0;
      let replannedCount = 0;
      for (const date of dates) {
        const old = existing.find((row) => row.localDate === date.localDate);
        if (
          old &&
          (old.dispatchedAt ||
            old.state === "dispatched" ||
            old.state === "skipped" ||
            old.state === "cancelled" ||
            old.planRevision === plan.revision)
        )
          continue;
        if (old) await deleteOwnedSlots(tx, orgId, brandId, [old.id]);
        const snapshot = {
          orgId,
          brandId,
          planId,
          ...date,
          scheduledAt: date.scheduledAt ? new Date(date.scheduledAt) : null,
          planRevision: plan.revision,
          brief: plan.brief,
          channelIds: plan.channelIds,
          consentVersion: plan.consentVersion,
          consentingActorId: plan.consentingActorId,
          consentedAt: plan.consentedAt,
          consentedRevision: plan.consentedRevision,
          updatedAt: now,
        };
        const [occurrence] = old
          ? await tx
              .update(schema.editorialPlanOccurrences)
              .set(snapshot)
              .where(
                and(
                  occurrenceScope(orgId, brandId, planId),
                  eq(schema.editorialPlanOccurrences.id, old.id),
                ),
              )
              .returning(editorialPlanOccurrenceColumns)
          : await tx
              .insert(schema.editorialPlanOccurrences)
              .values({ ...snapshot, createdAt: now })
              .returning(editorialPlanOccurrenceColumns);
        if (!occurrence) throw new Error("Occurrence write returned no row");
        if (old) replannedCount++;
        else createdCount++;
        if (occurrence.state === "planned" && occurrence.scheduledAt) {
          const [slot] = await tx
            .insert(schema.calendarSlots)
            .values({
              orgId,
              brandId,
              recurringOccurrenceId: occurrence.id,
              scheduledAt: occurrence.scheduledAt,
              brief: occurrence.brief,
              channelIds: occurrence.channelIds,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: schema.calendarSlots.id });
          if (!slot) throw new Error("Slot insert returned no row");
          await tx
            .update(schema.editorialPlanOccurrences)
            .set({ slotId: slot.id })
            .where(
              and(
                occurrenceScope(orgId, brandId, planId),
                eq(schema.editorialPlanOccurrences.id, occurrence.id),
              ),
            );
        }
      }
      await tx
        .update(schema.editorialPlans)
        .set({ blockedReason: null, updatedAt: now })
        .where(planScope(orgId, brandId, planId));
      return { createdCount, replannedCount, blockedReason: null };
    });
  }

  /** Discover without a slot lock, then revalidate under parent/plan/occurrence/slot locks. */
  async skipSlot(orgId: string, brandId: string, slotId: string, now: Date) {
    return this.db.transaction(async (tx) => {
      await lockEditorialPlanParents(orgId, tx, brandId, this.authorizeActor);
      const [attribution] = await tx
        .select({ occurrenceId: schema.calendarSlots.recurringOccurrenceId })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, brandId),
            eq(schema.calendarSlots.id, slotId),
          ),
        );
      if (!attribution?.occurrenceId) throw new EditorialPlanPersistenceError("not_found");
      const [identity] = await tx
        .select({ planId: schema.editorialPlanOccurrences.planId })
        .from(schema.editorialPlanOccurrences)
        .where(
          and(
            eq(schema.editorialPlanOccurrences.orgId, orgId),
            eq(schema.editorialPlanOccurrences.brandId, brandId),
            eq(schema.editorialPlanOccurrences.id, attribution.occurrenceId),
          ),
        );
      if (!identity) throw new EditorialPlanPersistenceError("not_found");
      await lockEditorialPlan(orgId, tx, brandId, identity.planId);
      const [occurrence] = await tx
        .select(editorialPlanOccurrenceColumns)
        .from(schema.editorialPlanOccurrences)
        .where(
          and(
            occurrenceScope(orgId, brandId, identity.planId),
            eq(schema.editorialPlanOccurrences.id, attribution.occurrenceId),
          ),
        )
        .for("update");
      const [slot] = await tx
        .select({
          id: schema.calendarSlots.id,
          occurrenceId: schema.calendarSlots.recurringOccurrenceId,
          runId: schema.calendarSlots.runId,
        })
        .from(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, brandId),
            eq(schema.calendarSlots.id, slotId),
          ),
        )
        .for("update");
      if (
        !occurrence ||
        !slot ||
        slot.occurrenceId !== occurrence.id ||
        occurrence.slotId !== slot.id
      )
        throw new EditorialPlanPersistenceError("not_found");
      if (occurrence.dispatchedAt || slot.runId)
        throw new EditorialPlanPersistenceError("not_dispatchable");
      await tx
        .update(schema.editorialPlanOccurrences)
        .set({ state: "skipped", reason: "manual_skip", updatedAt: now })
        .where(
          and(
            occurrenceScope(orgId, brandId, identity.planId),
            eq(schema.editorialPlanOccurrences.id, occurrence.id),
          ),
        );
      await tx
        .delete(schema.calendarSlots)
        .where(
          and(
            eq(schema.calendarSlots.orgId, orgId),
            eq(schema.calendarSlots.brandId, brandId),
            eq(schema.calendarSlots.id, slotId),
          ),
        );
    });
  }
}

/** Caller already owns the organization's/brand's parent locks in its paid admission transaction. */
export async function lockEditorialPlanOccurrence(
  orgId: string,
  tx: EditorialPlanTransaction,
  brandId: string,
  planId: string,
  occurrenceId: string,
) {
  const plan = await lockEditorialPlan(orgId, tx, brandId, planId);
  const [occurrence] = await tx
    .select(editorialPlanOccurrenceColumns)
    .from(schema.editorialPlanOccurrences)
    .where(
      and(
        occurrenceScope(orgId, brandId, planId),
        eq(schema.editorialPlanOccurrences.id, occurrenceId),
      ),
    )
    .for("update");
  if (!occurrence) throw new EditorialPlanPersistenceError("not_found");
  return { plan, occurrence };
}

/** Atomic durable attribution after the caller has performed all paid admission and lateness checks.
 * Run creation and queue enqueue must be in this SAME transaction; failure rolls every write back.
 */
export async function recordEditorialPlanDispatch(
  orgId: string,
  tx: EditorialPlanTransaction,
  brandId: string,
  planId: string,
  occurrenceId: string,
  slotId: string,
  runId: string,
  now: Date,
) {
  const { plan, occurrence } = await lockEditorialPlanOccurrence(
    orgId,
    tx,
    brandId,
    planId,
    occurrenceId,
  );
  if (
    !plan.enabled ||
    plan.removedAt ||
    plan.consentedRevision !== plan.revision ||
    occurrence.planRevision !== plan.revision ||
    occurrence.consentedRevision !== occurrence.planRevision ||
    occurrence.consentVersion !== plan.consentVersion ||
    occurrence.dispatchedAt ||
    occurrence.state !== "planned" ||
    occurrence.slotId !== slotId
  )
    throw new EditorialPlanPersistenceError("not_dispatchable");
  const [slot] = await tx
    .select({
      id: schema.calendarSlots.id,
      recurringOccurrenceId: schema.calendarSlots.recurringOccurrenceId,
      runId: schema.calendarSlots.runId,
    })
    .from(schema.calendarSlots)
    .where(
      and(
        eq(schema.calendarSlots.orgId, orgId),
        eq(schema.calendarSlots.brandId, brandId),
        eq(schema.calendarSlots.id, slotId),
      ),
    )
    .for("update");
  if (!slot || slot.recurringOccurrenceId !== occurrence.id || slot.runId)
    throw new EditorialPlanPersistenceError("not_dispatchable");
  const [run] = await tx
    .select({ id: schema.pipelineRuns.id })
    .from(schema.pipelineRuns)
    .where(
      and(
        eq(schema.pipelineRuns.orgId, orgId),
        eq(schema.pipelineRuns.brandId, brandId),
        eq(schema.pipelineRuns.id, runId),
      ),
    );
  if (!run) throw new EditorialPlanPersistenceError("not_dispatchable");
  await tx
    .update(schema.editorialPlanOccurrences)
    .set({ state: "dispatched", reason: null, runId, dispatchedAt: now, updatedAt: now })
    .where(
      and(
        occurrenceScope(orgId, brandId, planId),
        eq(schema.editorialPlanOccurrences.id, occurrence.id),
      ),
    );
  await tx
    .update(schema.calendarSlots)
    .set({ runId, updatedAt: now })
    .where(
      and(
        eq(schema.calendarSlots.orgId, orgId),
        eq(schema.calendarSlots.brandId, brandId),
        eq(schema.calendarSlots.id, slotId),
      ),
    );
}
