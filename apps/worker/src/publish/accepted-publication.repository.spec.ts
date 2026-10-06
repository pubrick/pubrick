import { randomUUID } from "node:crypto";
import { schema } from "@pubrick/db";
import { AcceptedPublicationError } from "@pubrick/integrations";
import { encryptJson } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const url = process.env.TEST_DATABASE_URL;
type Repository = InstanceType<typeof import("./publish.repository").PublishRepository>;
type Database = typeof import("../db").db;
type Pool = typeof import("../db").pool;
type SendClaim = import("./publish.repository").SendClaim;
const receipt = { externalId: "71", externalUrl: "https://example.com/posts/71" };
const reason = "Accepted but publication unconfirmed. Inspect the provider before sending again.";
const fence = { status: "publishing" as const, attemptCount: 1 };

describe.skipIf(!url)("accepted publication receipt durability", () => {
  let repo: Repository;
  let db: Database;
  let pool: Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    ({ db, pool } = await import("../db"));
    const { PublishRepository } = await import("./publish.repository");
    repo = new PublishRepository();
  });
  afterAll(async () => {
    await pool?.end();
  });

  function first<T>(rows: readonly T[]): T {
    const row = rows[0];
    if (!row) throw new Error("Missing fixture row");
    return row;
  }
  async function fixture() {
    const orgId = `accepted-receipt-${randomUUID()}`;
    await db.insert(schema.organization).values({
      id: orgId,
      name: "Accepted receipt fixture",
      slug: orgId,
      createdAt: new Date(),
    });
    await db.insert(schema.notificationSettings).values({
      orgId,
      enabled: true,
      deliveryProblem: true,
      credentialsEncrypted: encryptJson(
        { botToken: "fixture", chatId: "fixture" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    const brand = first(
      await db
        .insert(schema.brands)
        .values({ orgId, name: "Creator" })
        .returning({ id: schema.brands.id }),
    );
    const channel = first(
      await db
        .insert(schema.channels)
        .values({
          orgId,
          brandId: brand.id,
          platform: "telegram",
          name: "Fixture destination",
          credentialsEncrypted: encryptJson(
            { botToken: "fixture", chatId: "fixture" },
            process.env.APP_ENCRYPTION_KEY as string,
          ),
        })
        .returning({ id: schema.channels.id }),
    );
    const item = first(
      await db
        .insert(schema.contentItems)
        .values({ orgId, brandId: brand.id, body: "Reviewed content", status: "approved" })
        .returning({ id: schema.contentItems.id }),
    );
    const adaptation = first(
      await db
        .insert(schema.adaptations)
        .values({ orgId, contentItemId: item.id, channelId: channel.id, status: "queued" })
        .returning({ id: schema.adaptations.id }),
    );
    return {
      orgId,
      brandId: brand.id,
      itemId: item.id,
      channelId: channel.id,
      adaptationId: adaptation.id,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function sibling(f: Fixture): Promise<Fixture> {
    const item = first(
      await db
        .insert(schema.contentItems)
        .values({
          orgId: f.orgId,
          brandId: f.brandId,
          body: "Another reviewed post",
          status: "approved",
        })
        .returning({ id: schema.contentItems.id }),
    );
    const adaptation = first(
      await db
        .insert(schema.adaptations)
        .values({
          orgId: f.orgId,
          contentItemId: item.id,
          channelId: f.channelId,
          status: "queued",
        })
        .returning({ id: schema.adaptations.id }),
    );
    return { ...f, itemId: item.id, adaptationId: adaptation.id };
  }
  async function claimed(f: Fixture): Promise<SendClaim> {
    expect(await repo.markPublishing(f.orgId, f.adaptationId, null)).toBe(1);
    const claim = await repo.claimSend(f.orgId, f.adaptationId, 1);
    if (!claim) throw new Error("Fixture claim was refused");
    return claim;
  }
  async function snapshot(f: Fixture) {
    return {
      adaptations: await db
        .select({
          id: schema.adaptations.id,
          status: schema.adaptations.status,
          attemptCount: schema.adaptations.attemptCount,
          error: schema.adaptations.lastError,
          failureReason: schema.adaptations.failureReason,
        })
        .from(schema.adaptations)
        .where(eq(schema.adaptations.orgId, f.orgId))
        .orderBy(schema.adaptations.id),
      receipts: await db
        .select({
          id: schema.publications.id,
          adaptationId: schema.publications.adaptationId,
          status: schema.publications.status,
          attempt: schema.publications.attempt,
          externalId: schema.publications.externalId,
          externalUrl: schema.publications.externalUrl,
          error: schema.publications.error,
          assertedAt: schema.publications.assertedAt,
        })
        .from(schema.publications)
        .where(eq(schema.publications.orgId, f.orgId))
        .orderBy(schema.publications.id),
      items: await db
        .select({ id: schema.contentItems.id, status: schema.contentItems.status })
        .from(schema.contentItems)
        .where(eq(schema.contentItems.orgId, f.orgId))
        .orderBy(schema.contentItems.id),
      notifications: await db
        .select({
          id: schema.notificationEvents.id,
          attempt: schema.notificationEvents.attempt,
          event: schema.notificationEvents.event,
          subjectId: schema.notificationEvents.subjectId,
          targetId: schema.notificationEvents.targetId,
        })
        .from(schema.notificationEvents)
        .where(eq(schema.notificationEvents.orgId, f.orgId))
        .orderBy(schema.notificationEvents.id),
    };
  }
  const record = (f: Fixture, claim: SendClaim) =>
    repo.markAcceptedPublication(f.orgId, f.adaptationId, reason, fence, receipt, claim);

  it("loads the exact saved content title for publication", async () => {
    const f = await fixture();
    const title = 'Reviewed — <title> & "special"';
    await db
      .update(schema.contentItems)
      .set({ title })
      .where(and(eq(schema.contentItems.orgId, f.orgId), eq(schema.contentItems.id, f.itemId)));
    expect((await repo.load(f.orgId, f.adaptationId))?.itemTitle).toBe(title);
  });

  it("resolves the exact claim to unknown with its remote ID/link and makes replay a no-op", async () => {
    const f = await fixture();
    const claim = await claimed(f);
    expect(await record(f, claim)).toBe(true);
    const after = await snapshot(f);
    expect(after.receipts).toEqual([
      {
        id: claim.id,
        adaptationId: f.adaptationId,
        status: "unknown",
        attempt: 1,
        ...receipt,
        error: reason,
        assertedAt: null,
      },
    ]);
    expect(first(after.adaptations)).toMatchObject({
      status: "failed",
      attemptCount: 1,
      failureReason: "outcome_unknown",
      error: reason,
    });
    expect(first(after.items).status).toBe("failed");
    expect(after.notifications).toHaveLength(1);
    expect(first(after.notifications)).toMatchObject({
      attempt: 1,
      event: "delivery_unknown",
      subjectId: f.adaptationId,
      targetId: f.itemId,
    });
    expect(await record(f, claim)).toBe(true);
    expect(await snapshot(f)).toEqual(after);
  });

  it("records a late accepted reply without overwriting a newer adaptation and parent decision", async () => {
    const f = await fixture();
    const claim = await claimed(f);
    await db
      .update(schema.adaptations)
      .set({ status: "pending", attemptCount: 2, lastError: "Newer decision" })
      .where(and(eq(schema.adaptations.orgId, f.orgId), eq(schema.adaptations.id, f.adaptationId)));
    await db
      .update(schema.contentItems)
      .set({ status: "draft" })
      .where(and(eq(schema.contentItems.orgId, f.orgId), eq(schema.contentItems.id, f.itemId)));
    const before = await snapshot(f);
    expect(await record(f, claim)).toBe(true);
    const after = await snapshot(f);
    expect(after.adaptations).toEqual(before.adaptations);
    expect(after.items).toEqual(before.items);
    expect(after.notifications).toEqual(before.notifications);
    expect(first(after.receipts)).toMatchObject({ status: "unknown", attempt: 1, ...receipt });
  });

  it("advances a re-approved send once and keeps the old accepted reply behind its attempt fence", async () => {
    const f = await fixture();
    const original = await claimed(f);
    expect(await record(f, original)).toBe(true);
    // assertDelivery appends a human verdict for the finished attempt. Its
    // not-delivered decision leaves attempt_count intact; approve queues it.
    const human = first(
      await db
        .insert(schema.publications)
        .values({
          orgId: f.orgId,
          adaptationId: f.adaptationId,
          channelId: f.channelId,
          status: "failed",
          attempt: 1,
          assertedAt: new Date(),
        })
        .returning({ id: schema.publications.id }),
    );
    await db
      .update(schema.adaptations)
      .set({
        status: "queued",
        lastError: null,
        failureReason: null,
      })
      .where(and(eq(schema.adaptations.orgId, f.orgId), eq(schema.adaptations.id, f.adaptationId)));
    await db
      .update(schema.contentItems)
      .set({ status: "approved" })
      .where(and(eq(schema.contentItems.orgId, f.orgId), eq(schema.contentItems.id, f.itemId)));
    expect(await repo.markPublishing(f.orgId, f.adaptationId, null)).toBe(2);
    const next = await repo.claimSend(f.orgId, f.adaptationId, 2);
    if (!next) throw new Error("The re-approved send could not claim its new attempt");
    const before = await snapshot(f);
    expect(
      await repo.markAcceptedPublication(
        f.orgId,
        f.adaptationId,
        `${reason} Late provider status.`,
        fence,
        receipt,
        original,
      ),
    ).toBe(true);
    const after = await snapshot(f);
    expect(after.adaptations).toEqual(before.adaptations);
    expect(after.items).toEqual(before.items);
    expect(after.notifications).toEqual(before.notifications);
    expect(after.receipts.find((row) => row.id === human.id)).toEqual(
      before.receipts.find((row) => row.id === human.id),
    );
    expect(after.receipts.find((row) => row.id === next.id)).toEqual(
      before.receipts.find((row) => row.id === next.id),
    );
    expect(
      await repo.markAcceptedPublication(
        f.orgId,
        f.adaptationId,
        reason,
        { ...fence, attemptCount: 2 },
        { ...receipt, externalId: "72" },
        next,
      ),
    ).toBe(true);
    const finished = await snapshot(f);
    expect(first(finished.adaptations)).toMatchObject({
      status: "failed",
      attemptCount: 2,
    });
    expect(finished.notifications.map((row) => row.attempt).sort()).toEqual([1, 2]);
  });

  it.each(["published", "failed", "unknown"] as const)(
    "never overwrites a human %s resolution with a late reply",
    async (status) => {
      const f = await fixture();
      const claim = await claimed(f);
      await db
        .update(schema.publications)
        .set({
          status,
          assertedAt: new Date(),
          ...receipt,
          error: "Human resolution",
        })
        .where(and(eq(schema.publications.orgId, f.orgId), eq(schema.publications.id, claim.id)));
      const before = await snapshot(f);
      expect(await record(f, claim)).toBe(false);
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it.each(["published", "failed"] as const)(
    "never changes an unasserted terminal %s receipt back to unknown",
    async (status) => {
      const f = await fixture();
      const claim = await claimed(f);
      await db
        .update(schema.publications)
        .set({ status, ...receipt })
        .where(and(eq(schema.publications.orgId, f.orgId), eq(schema.publications.id, claim.id)));
      const before = await snapshot(f);
      expect(await record(f, claim)).toBe(false);
      expect(await snapshot(f)).toEqual(before);
    },
  );

  it("enriches an unasserted unknown claim without duplicating it or clearing known receipt fields", async () => {
    const f = await fixture();
    const claim = await claimed(f);
    await db
      .update(schema.publications)
      .set({ status: "unknown", error: "Interrupted send" })
      .where(and(eq(schema.publications.orgId, f.orgId), eq(schema.publications.id, claim.id)));
    expect(await record(f, claim)).toBe(true);
    const after = await snapshot(f);
    expect(
      await repo.markAcceptedPublication(
        f.orgId,
        f.adaptationId,
        reason,
        fence,
        { externalId: null, externalUrl: null },
        claim,
      ),
    ).toBe(true);
    expect(await snapshot(f)).toEqual(after);
    expect(
      await repo.markAcceptedPublication(
        f.orgId,
        f.adaptationId,
        reason,
        fence,
        { ...receipt, externalId: "Different record" },
        claim,
      ),
    ).toBe(false);
    expect(await snapshot(f)).toEqual(after);
  });

  it.each(["tenant", "adaptation", "attempt", "missing claim"] as const)(
    "refuses a mismatched %s without appending a receipt or changing any row",
    async (mismatch) => {
      const f = await fixture();
      const claim = await claimed(f);
      const other = await fixture();
      const otherAdaptation = mismatch === "adaptation" ? await sibling(f) : f;
      if (mismatch === "adaptation") await claimed(otherAdaptation);
      const before = await snapshot(f);
      const otherBefore = await snapshot(other);
      const result = await repo.markAcceptedPublication(
        mismatch === "tenant" ? other.orgId : f.orgId,
        mismatch === "adaptation" ? otherAdaptation.adaptationId : f.adaptationId,
        reason,
        mismatch === "attempt" ? { ...fence, attemptCount: 2 } : fence,
        receipt,
        mismatch === "attempt"
          ? { ...claim, attempt: 2 }
          : mismatch === "missing claim"
            ? { ...claim, id: randomUUID() }
            : claim,
      );
      expect(result).toBe(false);
      expect(await snapshot(f)).toEqual(before);
      expect(await snapshot(other)).toEqual(otherBefore);
    },
  );

  it("keeps an accepted receipt after channel deletion removed the adaptation", async () => {
    const f = await fixture();
    const claim = await claimed(f);
    await db
      .delete(schema.channels)
      .where(and(eq(schema.channels.orgId, f.orgId), eq(schema.channels.id, f.channelId)));
    expect(await record(f, claim)).toBe(true);
    const after = await snapshot(f);
    expect(after.adaptations).toEqual([]);
    expect(first(after.receipts)).toMatchObject({
      id: claim.id,
      adaptationId: null,
      status: "unknown",
      ...receipt,
    });
    expect(await record(f, claim)).toBe(true);
    expect(await snapshot(f)).toEqual(after);
  });

  it("survives an ambiguous recording commit and job replay without creating a second provider record", async () => {
    const f = await fixture();
    const { PublishService } = await import("./publish.service");
    const publish = vi
      .fn()
      .mockRejectedValue(
        new AcceptedPublicationError("Provider retained a pending record", receipt),
      );
    const publisher = {
      platform: "telegram",
      credentialsSchema: z.object({ botToken: z.string(), chatId: z.string() }),
      publish,
    };
    const real = repo.markAcceptedPublication.bind(repo);
    const write = vi
      .spyOn(repo, "markAcceptedPublication")
      .mockImplementationOnce(async (...args) => {
        await real(...args);
        throw new Error("Commit succeeded but acknowledgement was lost");
      });
    try {
      const service = new PublishService(repo, () => publisher as never, "https://api", 0);
      const job = { orgId: f.orgId, adaptationId: f.adaptationId };
      await expect(service.handle(job)).resolves.toBeUndefined();
      const after = await snapshot(f);
      expect(write).toHaveBeenCalledTimes(2);
      expect(after.receipts).toHaveLength(1);
      expect(first(after.receipts)).toMatchObject({ status: "unknown", attempt: 1, ...receipt });
      expect(first(after.receipts).error).toContain("Inspect the provider");
      await expect(service.handle(job)).resolves.toBeUndefined();
      expect(publish).toHaveBeenCalledOnce();
      expect(await snapshot(f)).toEqual(after);
    } finally {
      write.mockRestore();
    }
  });
});
