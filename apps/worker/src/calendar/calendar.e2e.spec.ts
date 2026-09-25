import { randomUUID } from "node:crypto";
import type { ContentType } from "@pubrick/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("planned calendar generation", () => {
  let db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
  let pool: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
  let schema: typeof import("@pubrick/db").schema;
  let boss: InstanceType<typeof import("pg-boss").PgBoss>;
  let service: InstanceType<typeof import("./calendar.service").CalendarService>;
  let orgId: string;
  let brandId: string;
  let channelId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    const dbPackage = await import("@pubrick/db");
    schema = dbPackage.schema;
    ({ db, pool } = dbPackage.createDb(url as string));
    const { PgBoss } = await import("pg-boss");
    boss = new PgBoss({ connectionString: url as string, supervise: false, schedule: false });
    boss.on("error", (error: Error) => console.error("pg-boss calendar test", error));
    await boss.start();
    await boss.createQueue("generate");
    const { CalendarService } = await import("./calendar.service");
    service = new CalendarService();
    orgId = `calendar-e2e-${randomUUID()}`;
    await db.insert(schema.organization).values({ id: orgId, name: "Calendar E2E", slug: orgId });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    brandId = brand?.id as string;
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "telegram",
        name: "Channel",
        credentialsEncrypted: "test-only",
      })
      .returning({ id: schema.channels.id });
    channelId = channel?.id as string;
  });

  afterAll(async () => {
    if (db && orgId) {
      const { eq } = await import("drizzle-orm");
      await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    }
    await boss?.stop({ graceful: false, timeout: 5_000 });
    await pool?.end();
  });

  async function seed(
    channelIds = [channelId],
    generateCover = false,
    generateInlineImages = false,
    contentType: ContentType = "social_post",
  ) {
    const [slot] = await db
      .insert(schema.calendarSlots)
      .values({
        orgId,
        brandId,
        scheduledAt: new Date(Date.now() - 60_000),
        brief: "A useful topic",
        channelIds,
        generateCover,
        generateInlineImages,
        contentType,
      })
      .returning({ id: schema.calendarSlots.id });
    return slot?.id as string;
  }

  it("creates one real queued run and never queues the same slot twice", async () => {
    const { eq } = await import("drizzle-orm");
    const slotId = await seed();
    await service.trigger(boss, orgId, slotId);
    await service.trigger(boss, orgId, slotId);
    const [slot] = await db
      .select({ runId: schema.calendarSlots.runId })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    expect(slot?.runId).toBeTruthy();
    const rows = await db
      .select({ orgId: schema.pipelineRuns.orgId, input: schema.pipelineRuns.input })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, slot?.runId as string));
    expect(rows).toEqual([
      { orgId, input: { kind: "brief", text: "A useful topic", channelIds: [channelId] } },
    ]);
    const jobs = await boss.findJobs("generate", { data: { runId: slot?.runId, orgId } });
    expect(jobs).toHaveLength(1);
  });

  it("defers when three runs are live instead of spending past the admission cap", async () => {
    const { eq } = await import("drizzle-orm");
    const slotId = await seed();
    const inserted = await db
      .insert(schema.pipelineRuns)
      .values(
        Array.from({ length: 2 }, () => ({
          orgId,
          brandId,
          input: { kind: "brief" as const, text: "Existing", channelIds: [channelId] },
        })),
      )
      .returning({ id: schema.pipelineRuns.id });
    await service.trigger(boss, orgId, slotId);
    const [slot] = await db
      .select({ runId: schema.calendarSlots.runId, retryAfter: schema.calendarSlots.retryAfter })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    expect(slot?.runId).toBeNull();
    expect(slot?.retryAfter?.getTime()).toBeGreaterThan(Date.now());
    await db
      .delete(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, inserted[0]?.id as string));
    await db
      .delete(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, inserted[1]?.id as string));
  });

  it("records a removed channel and cannot trigger a slot from another organization", async () => {
    const { eq } = await import("drizzle-orm");
    const slotId = await seed([randomUUID()]);
    await service.trigger(boss, "another-org", slotId);
    await service.trigger(boss, orgId, slotId);
    const [slot] = await db
      .select({ runId: schema.calendarSlots.runId, errorCode: schema.calendarSlots.errorCode })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    expect(slot).toEqual({ runId: null, errorCode: "channels_missing" });
  });

  it("refuses an archived or edited linked topic before enqueueing a paid run", async () => {
    const { eq } = await import("drizzle-orm");
    const [topic] = await db
      .insert(schema.topics)
      .values({ orgId, brandId, title: "Approved", description: "Facts", status: "approved" })
      .returning({
        id: schema.topics.id,
        updatedAt: schema.topics.updatedAt,
        revision: schema.topics.revision,
      });
    const topicId = topic?.id as string;
    const makeLinkedSlot = async () => {
      const [slot] = await db
        .insert(schema.calendarSlots)
        .values({
          orgId,
          brandId,
          scheduledAt: new Date(Date.now() - 60_000),
          brief: "Approved\n\nFacts",
          channelIds: [channelId],
          topicId,
          topicTitle: "Approved",
          topicDescription: "Facts",
          topicUpdatedAt: topic?.updatedAt,
          topicRevision: topic?.revision,
        })
        .returning({ id: schema.calendarSlots.id });
      return slot?.id as string;
    };
    const archivedSlot = await makeLinkedSlot();
    await db
      .update(schema.topics)
      .set({ status: "archived", updatedAt: new Date(Date.now() + 1000) })
      .where(eq(schema.topics.id, topicId));
    await service.trigger(boss, orgId, archivedSlot);
    const [archived] = await db
      .select({ runId: schema.calendarSlots.runId, errorCode: schema.calendarSlots.errorCode })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, archivedSlot));
    expect(archived).toEqual({ runId: null, errorCode: "topic_changed" });
    const changedSlot = await makeLinkedSlot();
    await db
      .update(schema.topics)
      .set({ status: "approved", title: "Changed" })
      .where(eq(schema.topics.id, topicId));
    await service.trigger(boss, orgId, changedSlot);
    const [changed] = await db
      .select({ runId: schema.calendarSlots.runId, errorCode: schema.calendarSlots.errorCode })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, changedSlot));
    expect(changed).toEqual({ runId: null, errorCode: "topic_changed" });
  });

  it("queues the approved linked topic with its stored source as an immutable run input", async () => {
    const { eq } = await import("drizzle-orm");
    const [topic] = await db
      .insert(schema.topics)
      .values({
        orgId,
        brandId,
        title: "Reference",
        description: "Approved facts",
        sourceUrl: "https://example.com/reference",
        status: "approved",
      })
      .returning({
        id: schema.topics.id,
        updatedAt: schema.topics.updatedAt,
        revision: schema.topics.revision,
      });
    const [slot] = await db
      .insert(schema.calendarSlots)
      .values({
        orgId,
        brandId,
        scheduledAt: new Date(Date.now() - 60_000),
        brief: "Reference\n\nApproved facts",
        channelIds: [channelId],
        topicId: topic?.id,
        topicTitle: "Reference",
        topicDescription: "Approved facts",
        topicSourceUrl: "https://example.com/reference",
        topicUpdatedAt: topic?.updatedAt,
        topicRevision: topic?.revision,
      })
      .returning({ id: schema.calendarSlots.id });
    await service.trigger(boss, orgId, slot?.id as string);
    const [started] = await db
      .select({ runId: schema.calendarSlots.runId })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slot?.id as string));
    expect(started?.runId).toBeTruthy();
    const [run] = await db
      .select({ input: schema.pipelineRuns.input })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, started?.runId as string));
    expect(run?.input).toEqual({
      kind: "source",
      text: null,
      sourceUrl: "https://example.com/reference",
      material: "Reference\n\nApproved facts",
      channelIds: [channelId],
    });
  });

  it("carries a planned cover choice into the queued run", async () => {
    const { eq } = await import("drizzle-orm");
    const slotId = await seed([channelId], true);
    await service.trigger(boss, orgId, slotId);
    const [slot] = await db
      .select({ runId: schema.calendarSlots.runId })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    const [run] = await db
      .select({ input: schema.pipelineRuns.input })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, slot?.runId as string));
    expect(run?.input).toEqual({
      kind: "brief",
      text: "A useful topic",
      channelIds: [channelId],
      generateCover: true,
    });
  });

  it("carries an illustrated article format into the queued run", async () => {
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.pipelineRuns)
      .set({ status: "succeeded" })
      .where(eq(schema.pipelineRuns.orgId, orgId));
    const slotId = await seed([channelId], false, true, "expert_article");
    await service.trigger(boss, orgId, slotId);
    const [slot] = await db
      .select({ runId: schema.calendarSlots.runId })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    const [run] = await db
      .select({ input: schema.pipelineRuns.input })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, slot?.runId as string));
    expect(run?.input).toEqual({
      kind: "brief",
      text: "A useful topic",
      channelIds: [channelId],
      contentType: "expert_article",
      generateInlineImages: true,
    });
  });

  it("uses the approved topic SEO snapshot and refuses a changed one before a paid run", async () => {
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.pipelineRuns)
      .set({ status: "succeeded" })
      .where(eq(schema.pipelineRuns.orgId, orgId));
    const [topic] = await db
      .insert(schema.topics)
      .values({
        orgId,
        brandId,
        title: "Guide",
        description: "Reviewed facts",
        status: "approved",
        contentType: "expert_article",
        seoKeywords: ["local guide"],
      })
      .returning({
        id: schema.topics.id,
        updatedAt: schema.topics.updatedAt,
        revision: schema.topics.revision,
      });
    if (!topic) throw new Error("Topic insert failed");
    const values = {
      orgId,
      brandId,
      scheduledAt: new Date(Date.now() - 60_000),
      brief: "Guide\n\nReviewed facts",
      channelIds: [channelId],
      topicId: topic.id,
      topicTitle: "Guide",
      topicDescription: "Reviewed facts",
      topicUpdatedAt: topic.updatedAt,
      topicRevision: topic.revision,
      contentType: "expert_article" as const,
      seoKeywords: ["local guide"],
    };
    const [ready] = await db
      .insert(schema.calendarSlots)
      .values(values)
      .returning({ id: schema.calendarSlots.id });
    await service.trigger(boss, orgId, ready?.id as string);
    const [completed] = await db
      .select({ runId: schema.calendarSlots.runId })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, ready?.id as string));
    const [run] = await db
      .select({ input: schema.pipelineRuns.input })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, completed?.runId as string));
    expect(run?.input).toMatchObject({
      contentType: "expert_article",
      seoKeywords: ["local guide"],
    });
    const [stale] = await db
      .insert(schema.calendarSlots)
      .values(values)
      .returning({ id: schema.calendarSlots.id });
    await db
      .update(schema.topics)
      .set({ seoKeywords: ["changed guide"], revision: 2 })
      .where(eq(schema.topics.id, topic.id));
    await service.trigger(boss, orgId, stale?.id as string);
    const [refused] = await db
      .select({ runId: schema.calendarSlots.runId, errorCode: schema.calendarSlots.errorCode })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, stale?.id as string));
    expect(refused).toEqual({ runId: null, errorCode: "topic_changed" });
  });

  it("honors an older linked article slot when the topic predates saved formats", async () => {
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.pipelineRuns)
      .set({ status: "succeeded" })
      .where(eq(schema.pipelineRuns.orgId, orgId));
    const [topic] = await db
      .insert(schema.topics)
      .values({
        orgId,
        brandId,
        title: "Legacy guide",
        description: "Reviewed facts",
        status: "approved",
      })
      .returning({
        id: schema.topics.id,
        updatedAt: schema.topics.updatedAt,
        revision: schema.topics.revision,
      });
    if (!topic) throw new Error("Topic insert failed");
    const [slot] = await db
      .insert(schema.calendarSlots)
      .values({
        orgId,
        brandId,
        scheduledAt: new Date(Date.now() - 60_000),
        brief: "Legacy guide\n\nReviewed facts",
        channelIds: [channelId],
        topicId: topic.id,
        topicTitle: "Legacy guide",
        topicDescription: "Reviewed facts",
        topicUpdatedAt: topic.updatedAt,
        topicRevision: topic.revision,
        contentType: "expert_article",
      })
      .returning({ id: schema.calendarSlots.id });
    await service.trigger(boss, orgId, slot?.id as string);
    const [result] = await db
      .select({ runId: schema.calendarSlots.runId, errorCode: schema.calendarSlots.errorCode })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slot?.id as string));
    expect(result?.errorCode).toBeNull();
    const [run] = await db
      .select({ input: schema.pipelineRuns.input })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, result?.runId as string));
    expect(run?.input).toMatchObject({ contentType: "expert_article" });
    expect(run?.input).not.toHaveProperty("seoKeywords");
  });

  it("defers an illustrated article when fewer than two hourly image calls remain", async () => {
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.pipelineRuns)
      .set({ status: "succeeded" })
      .where(eq(schema.pipelineRuns.orgId, orgId));
    await db.insert(schema.usageLedger).values(
      Array.from({ length: 11 }, () => ({
        orgId,
        step: "image_generate",
        provider: "google" as const,
        modelId: "test-image-model",
        costSource: "unknown" as const,
        status: "ok" as const,
      })),
    );
    const slotId = await seed([channelId], false, true, "educational");
    await service.trigger(boss, orgId, slotId);
    const [slot] = await db
      .select({ runId: schema.calendarSlots.runId, retryAfter: schema.calendarSlots.retryAfter })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    expect(slot?.runId).toBeNull();
    expect(slot?.retryAfter?.getTime()).toBeGreaterThan(Date.now());
  });

  it("defers a planned cover while the hourly image budget is full", async () => {
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.pipelineRuns)
      .set({ status: "succeeded" })
      .where(eq(schema.pipelineRuns.orgId, orgId));
    const slotId = await seed([channelId], true);
    await db.insert(schema.usageLedger).values(
      Array.from({ length: 12 }, () => ({
        orgId,
        step: "image_generate",
        provider: "google" as const,
        modelId: "test-image-model",
        costSource: "unknown" as const,
        status: "ok" as const,
      })),
    );
    await service.trigger(boss, orgId, slotId);
    const [slot] = await db
      .select({ runId: schema.calendarSlots.runId, retryAfter: schema.calendarSlots.retryAfter })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    expect(slot?.runId).toBeNull();
    expect(slot?.retryAfter?.getTime()).toBeGreaterThan(Date.now());
    const invalidSlotId = await seed([randomUUID()], true);
    await service.trigger(boss, orgId, invalidSlotId);
    const [invalid] = await db
      .select({ errorCode: schema.calendarSlots.errorCode })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, invalidSlotId));
    expect(invalid?.errorCode).toBe("channels_missing");
  });
});
