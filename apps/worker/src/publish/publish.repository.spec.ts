import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

// Type-only: avoids importing "./publish.repository" (which imports "../db" ->
// "../env", validated/connected eagerly at module load) before beforeAll()
// below has set DATABASE_URL. Same reasoning as apps/api/src/queue/queue.service.spec.ts.
type PublishRepositoryCtor = typeof import("./publish.repository").PublishRepository;
type PublishRepositoryInstance = InstanceType<PublishRepositoryCtor>;
type PublishServiceCtor = typeof import("./publish.service").PublishService;
type PublishServiceInstance = InstanceType<PublishServiceCtor>;
type Schema = typeof import("@pubrick/db").schema;

/**
 * Exercises PublishRepository's raw SQL (and PublishService.markExhausted on
 * top of a REAL repository, not a mock) against a real Postgres. The rest of
 * this app's suite mocks the repository entirely — the facts asserted here
 * (a publications row gets written, attempt_count actually advances, calling
 * markExhausted twice is a true no-op the second time) can only be proven
 * against real SQL, not a vi.fn() stub.
 */
describe.skipIf(!url)("PublishRepository + PublishService.markExhausted (real DB)", () => {
  let repo: PublishRepositoryInstance;
  let service: PublishServiceInstance;
  let db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
  let pool: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
  let schema: Schema;
  let eq: typeof import("drizzle-orm").eq;
  let orgId: string;
  let brandId: string;
  let channelId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    process.env.TELEGRAM_API_BASE_URL ??= "https://api.telegram.org";

    const dbModule = await import("@pubrick/db");
    schema = dbModule.schema;
    await dbModule.runMigrations(url as string);
    ({ db, pool } = dbModule.createDb(url as string));
    ({ eq } = await import("drizzle-orm"));
    const { encryptJson } = await import("@pubrick/shared");

    const { PublishRepository } = await import("./publish.repository");
    const { PublishService } = await import("./publish.service");
    repo = new PublishRepository();
    // No adapter lookup needed — these tests only call markFailed/markExhausted directly.
    service = new PublishService(repo, () => undefined, "https://api.telegram.org", 0);

    orgId = `publish-repo-test-org-${Date.now()}`;
    await db.insert(schema.organization).values({
      id: orgId,
      name: "Publish Repo Test Org",
      slug: `publish-repo-test-${Date.now()}`,
      createdAt: new Date(),
    });
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
        name: "Chan",
        credentialsEncrypted: encryptJson(
          { botToken: "1:a", chatId: "-1" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      })
      .returning({ id: schema.channels.id });
    channelId = channel?.id as string;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedAdaptation(
    status: "pending" | "queued" | "scheduled" | "publishing" | "published" = "queued",
  ) {
    const [item] = await db
      .insert(schema.contentItems)
      .values({ orgId, brandId, body: "Hello world" })
      .returning({ id: schema.contentItems.id });
    const itemId = item?.id as string;
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({ orgId, contentItemId: itemId, channelId, status })
      .returning({ id: schema.adaptations.id });
    return adaptation?.id as string;
  }

  it("markFailed on a fresh (queued) adaptation: attempt_count advances by exactly one and a failed publications row is written", async () => {
    const adaptationId = await seedAdaptation("queued");

    await repo.markFailed(orgId, adaptationId, "No adapter for platform vk");

    const [row] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(row?.status).toBe("failed");
    expect(row?.attemptCount).toBe(1);
    expect(row?.lastError).toBe("No adapter for platform vk");

    const pubs = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId));
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.status).toBe("failed");
    expect(pubs[0]?.attempt).toBe(1);
  });

  it("markFailed on a row already 'publishing' (markPublishing already bumped it): attempt_count does NOT bump a second time", async () => {
    const adaptationId = await seedAdaptation("queued");

    await repo.markPublishing(orgId, adaptationId);
    {
      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      expect(row?.status).toBe("publishing");
      expect(row?.attemptCount).toBe(1);
    }

    await repo.markFailed(orgId, adaptationId, "Forbidden");

    const [row] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(row?.status).toBe("failed");
    expect(row?.attemptCount).toBe(1); // stayed 1, not double-bumped to 2

    const pubs = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId));
    expect(pubs).toHaveLength(1);
  });

  it("the database itself refuses a second published publications row for one adaptation", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId);
    await repo.markPublished(orgId, adaptationId, { externalId: "1", externalUrl: "https://x/1" });

    // "Never post twice" must not depend on the application getting every
    // read-then-write right. The partial unique index
    // publications_one_published_per_adaptation is the backstop: two workers
    // that both slip past their guards still cannot both record a delivery.
    const error = await db
      .insert(schema.publications)
      .values({
        orgId,
        adaptationId,
        channelId,
        status: "published",
        externalId: "2",
        externalUrl: "https://x/2",
        attempt: 2,
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(error).not.toBeNull();
    // Drizzle wraps the driver error, so assert on the pg error underneath:
    // 23505 unique_violation, named by our index — not some other constraint.
    const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
    expect(cause?.code).toBe("23505");
    expect(cause?.constraint).toBe("publications_one_published_per_adaptation");

    const pubs = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId));
    expect(pubs).toHaveLength(1);
  });

  it("the index is PARTIAL: any number of failed publications rows for one adaptation are fine", async () => {
    const adaptationId = await seedAdaptation("queued");

    await repo.markFailed(orgId, adaptationId, "first");
    await repo.markFailed(orgId, adaptationId, "second");

    const pubs = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId));
    expect(pubs).toHaveLength(2);
    expect(pubs.every((p) => p.status === "failed")).toBe(true);
  });

  it("markAlreadyPublished converges a stranded row without writing a second publications record", async () => {
    // The state the duplicate-record path leaves behind: a correct published
    // publications row exists, but markPublished's transaction rolled back on
    // the unique violation, so the adaptation itself is still "publishing".
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId);
    await repo.markPublished(orgId, adaptationId, { externalId: "5", externalUrl: "https://x/5" });
    await db
      .update(schema.adaptations)
      .set({ status: "publishing", lastError: "connection reset" })
      .where(eq(schema.adaptations.id, adaptationId));

    await repo.markAlreadyPublished(orgId, adaptationId);

    const [row] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(row?.status).toBe("published");
    expect(row?.lastError).toBeNull();

    // Exactly one record, still the original one — convergence must not invent
    // a second delivery.
    const pubs = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId));
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.externalId).toBe("5");

    // The parent item is promoted too, exactly as markPublished would have.
    const [item] = await db
      .select()
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, row?.contentItemId as string));
    expect(item?.status).toBe("published");
  });

  it("markAlreadyPublished is org-scoped and a no-op for an unknown adaptation", async () => {
    const adaptationId = await seedAdaptation("publishing");
    await repo.markAlreadyPublished("some-other-org", adaptationId);

    const [row] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(row?.status).toBe("publishing");
  });

  it("hasPublished reads the durable record, not the adaptation status column", async () => {
    const adaptationId = await seedAdaptation("queued");
    expect(await repo.hasPublished(orgId, adaptationId)).toBe(false);

    // A failed attempt is not a delivery.
    await repo.markFailed(orgId, adaptationId, "nope");
    expect(await repo.hasPublished(orgId, adaptationId)).toBe(false);

    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markPublished(orgId, adaptationId, { externalId: "9", externalUrl: null });
    expect(await repo.hasPublished(orgId, adaptationId)).toBe(true);

    // Even after the api moves the adaptation back (re-approve), the delivery
    // that already happened is still on the record.
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    expect(await repo.hasPublished(orgId, adaptationId)).toBe(true);

    // Org-scoped, like every other repository method.
    expect(await repo.hasPublished("some-other-org", adaptationId)).toBe(false);
  });

  it("markPublishing claims only a publishable row: false (and no attempt_count movement) once the api has moved it", async () => {
    // This is what stops a reject that commits between load() and the claim
    // from being published anyway: both sides take the same row lock.
    const rejected = await seedAdaptation("pending");
    expect(await repo.markPublishing(orgId, rejected)).toBe(false);
    {
      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, rejected));
      expect(row?.status).toBe("pending");
      expect(row?.attemptCount).toBe(0);
    }

    const alreadyDone = await seedAdaptation("published");
    expect(await repo.markPublishing(orgId, alreadyDone)).toBe(false);

    // Claimable: freshly queued, scheduled, and a pg-boss retry of a
    // transiently failed attempt (which leaves the row at "publishing").
    for (const status of ["queued", "scheduled", "publishing"] as const) {
      const adaptationId = await seedAdaptation(status);
      expect(await repo.markPublishing(orgId, adaptationId)).toBe(true);
    }

    // Org-scoped: another org cannot claim this org's row.
    const mine = await seedAdaptation("queued");
    expect(await repo.markPublishing("some-other-org", mine)).toBe(false);
  });

  it("markExhausted: marks failed with a retries-exhausted reason, writes the publications row, and is idempotent on a second delivery", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId); // simulate an in-flight attempt before the DLQ fires

    await service.markExhausted({ adaptationId, orgId });

    const [afterFirst] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(afterFirst?.status).toBe("failed");
    expect(afterFirst?.lastError).toBe("Retries exhausted");
    expect(afterFirst?.attemptCount).toBe(1);

    const pubsAfterFirst = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId));
    expect(pubsAfterFirst).toHaveLength(1);
    expect(pubsAfterFirst[0]?.status).toBe("failed");

    // pg-boss DLQ delivery is at-least-once — a second delivery of the same
    // job must be a true no-op: no second publications row, no further
    // attempt_count movement.
    await service.markExhausted({ adaptationId, orgId });

    const [afterSecond] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(afterSecond?.attemptCount).toBe(1);

    const pubsAfterSecond = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId));
    expect(pubsAfterSecond).toHaveLength(1);
  });

  async function publicationsFor(adaptationId: string) {
    return db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId));
  }

  it("claimSend writes an in-flight row carrying the attempt that markPublishing just bumped", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId);

    expect(await repo.claimSend(orgId, adaptationId)).toBe(true);

    const pubs = await publicationsFor(adaptationId);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.status).toBe("in_flight");
    // Read from adaptations.attempt_count in the same statement, so it cannot
    // drift from the count the claim on the attempt just wrote.
    expect(pubs[0]?.attempt).toBe(1);
    expect(pubs[0]?.channelId).toBe(channelId);
  });

  // The guard behind findings (b) and (c): the second attempt is the
  // redelivered one, and it must find the claim rather than an empty table.
  it("claimSend refuses a second claim while one is unresolved, and writes nothing", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId);
    expect(await repo.claimSend(orgId, adaptationId)).toBe(true);

    await repo.markPublishing(orgId, adaptationId); // the redelivery re-claims the attempt
    expect(await repo.claimSend(orgId, adaptationId)).toBe(false);

    expect(await publicationsFor(adaptationId)).toHaveLength(1);
  });

  it("claimSend is org-scoped and reports false for an adaptation that is not there", async () => {
    const adaptationId = await seedAdaptation("queued");
    expect(await repo.claimSend("some-other-org", adaptationId)).toBe(false);
    expect(await publicationsFor(adaptationId)).toHaveLength(0);
  });

  it("releaseSend hands the claim back so an honest retry can take it again", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId);
    await repo.claimSend(orgId, adaptationId);

    await repo.releaseSend(orgId, adaptationId);
    expect(await publicationsFor(adaptationId)).toHaveLength(0);

    await repo.markPublishing(orgId, adaptationId);
    expect(await repo.claimSend(orgId, adaptationId)).toBe(true);
  });

  it("releaseSend takes only the in-flight claim, never a terminal record", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markFailed(orgId, adaptationId, "first attempt");
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markPublishing(orgId, adaptationId);
    await repo.claimSend(orgId, adaptationId);

    await repo.releaseSend(orgId, adaptationId);

    const pubs = await publicationsFor(adaptationId);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.status).toBe("failed");
  });

  it("markPublished resolves the claim in place: one row, not a claim plus a delivery", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId);
    await repo.claimSend(orgId, adaptationId);

    await repo.markPublished(orgId, adaptationId, {
      externalId: "77",
      externalUrl: "https://t.me/x/77",
    });

    const pubs = await publicationsFor(adaptationId);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]).toMatchObject({
      status: "published",
      externalId: "77",
      externalUrl: "https://t.me/x/77",
      attempt: 1,
      error: null,
    });
    // And the claim is gone as a claim, so the next legitimate attempt after a
    // re-approve is not blocked by it.
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markPublishing(orgId, adaptationId);
    expect(await repo.claimSend(orgId, adaptationId)).toBe(true);
  });

  it("markFailed resolves the claim to failed rather than leaving one behind", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId);
    await repo.claimSend(orgId, adaptationId);

    await repo.markFailed(orgId, adaptationId, "Forbidden");

    const pubs = await publicationsFor(adaptationId);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]).toMatchObject({ status: "failed", error: "Forbidden", attempt: 1 });
  });

  // The whole point of the new status. The adaptation column has no way to say
  // "we do not know" — it says `failed`, which is what every reader of it
  // already understands — so the publications row is where the difference
  // between "never went out" and "may be live" is kept.
  it("markFailed with the unknown outcome: adaptation failed, publication unknown", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId);
    await repo.claimSend(orgId, adaptationId);

    await repo.markFailed(orgId, adaptationId, "outcome unknown, check the channel", "unknown");

    const [row] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(row?.status).toBe("failed");
    expect(row?.lastError).toBe("outcome unknown, check the channel");
    expect(row?.attemptCount).toBe(1);

    const pubs = await publicationsFor(adaptationId);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.status).toBe("unknown");
    expect(pubs[0]?.error).toBe("outcome unknown, check the channel");

    // An unknown outcome is not a delivery on the record, so `hasPublished`
    // must not report one — a human re-approving is exactly how this is meant
    // to be resolved, and it has to be able to.
    expect(await repo.hasPublished(orgId, adaptationId)).toBe(false);
  });

  // Migration 0008, asserted by name and by shape rather than assumed. It is a
  // second PARTIAL index alongside the published one: terminal rows stay
  // unconstrained, so one adaptation can still accumulate a claim per attempt
  // once each is resolved.
  it("the database itself refuses a second in-flight claim for one adaptation", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId);
    await repo.claimSend(orgId, adaptationId);

    const error = await db
      .insert(schema.publications)
      .values({ orgId, adaptationId, channelId, status: "in_flight", attempt: 2 })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(error).not.toBeNull();
    const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
    expect(cause?.code).toBe("23505");
    expect(cause?.constraint).toBe("publications_one_in_flight_per_adaptation");

    // Partial: a resolved claim plus a fresh one is two rows and no violation.
    await repo.markFailed(orgId, adaptationId, "unknown outcome", "unknown");
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markPublishing(orgId, adaptationId);
    expect(await repo.claimSend(orgId, adaptationId)).toBe(true);
    const pubs = await publicationsFor(adaptationId);
    expect(pubs).toHaveLength(2);
    expect(pubs.map((row) => row.status).sort()).toEqual(["in_flight", "unknown"]);
  });

  it("0008 created the in-flight index as a partial unique index on adaptation_id", async () => {
    const { rows } = await db.execute(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'publications_one_in_flight_per_adaptation'",
    );
    expect(rows).toHaveLength(1);
    const definition = String(rows[0]?.indexdef);
    expect(definition).toContain("CREATE UNIQUE INDEX");
    expect(definition).toContain("(adaptation_id)");
    // The WHERE clause is what keeps it additive: no row written before 0008
    // could carry this status, so the index is empty at creation and cannot
    // fail on a populated table.
    expect(definition).toContain("'in_flight'");
  });
});
