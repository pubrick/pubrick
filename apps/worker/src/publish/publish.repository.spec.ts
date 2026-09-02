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
/** The other tenant's bot token. A different value, so "whose row came back" is readable. */
const STRANGER_CREDENTIALS = { botToken: "9:z", chatId: "-9" };

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
  let secondChannelId: string;
  let strangerOrgId: string;
  let strangerChannelId: string;
  let strangerAdaptationId: string;

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
    // A second channel, because the races below are about a FAN-OUT: two
    // adaptations of one item finishing in different transactions at the same
    // moment. One channel twice would exercise the same SQL, but an item with
    // two adaptations pointing at one channel is not a shape this product
    // produces, and a fixture that cannot happen is a fixture nobody trusts.
    const [second] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "telegram",
        name: "Chan 2",
        credentialsEncrypted: encryptJson(
          { botToken: "1:b", chatId: "-2" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      })
      .returning({ id: schema.channels.id });
    secondChannelId = second?.id as string;

    // A whole second tenant, with a row of its own at every level the publish
    // path reads. Two reads below take an `org_id` and mask each other in the
    // service — `load` refuses first, so `credentials` is never asked — and a
    // stranger that owned nothing could not tell a correct filter from a query
    // that returns nothing to anybody.
    strangerOrgId = `publish-repo-test-stranger-${Date.now()}`;
    await db.insert(schema.organization).values({
      id: strangerOrgId,
      name: "Publish Repo Test Stranger",
      slug: `publish-repo-test-stranger-${Date.now()}`,
      createdAt: new Date(),
    });
    const [strangerBrand] = await db
      .insert(schema.brands)
      .values({ orgId: strangerOrgId, name: "Their brand" })
      .returning({ id: schema.brands.id });
    const [strangerChannel] = await db
      .insert(schema.channels)
      .values({
        orgId: strangerOrgId,
        brandId: strangerBrand?.id as string,
        platform: "telegram",
        name: "Their channel",
        credentialsEncrypted: encryptJson(
          STRANGER_CREDENTIALS,
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      })
      .returning({ id: schema.channels.id });
    strangerChannelId = strangerChannel?.id as string;
    const [strangerItem] = await db
      .insert(schema.contentItems)
      .values({ orgId: strangerOrgId, brandId: strangerBrand?.id as string, body: "Their post" })
      .returning({ id: schema.contentItems.id });
    const [strangerAdaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId: strangerOrgId,
        contentItemId: strangerItem?.id as string,
        channelId: strangerChannelId,
        status: "queued",
      })
      .returning({ id: schema.adaptations.id });
    strangerAdaptationId = strangerAdaptation?.id as string;
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

  /**
   * An APPROVED item and one adaptation per status given — the shape the worker
   * finds after the api approved a multi-channel item and the queue got to some
   * of the channels before others.
   */
  async function seedFanOut(statuses: readonly (typeof schema.ADAPTATION_STATUSES)[number][]) {
    const [item] = await db
      .insert(schema.contentItems)
      .values({ orgId, brandId, body: "Hello world", status: "approved" })
      .returning({ id: schema.contentItems.id });
    const itemId = item?.id as string;
    const adaptationIds: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const [adaptation] = await db
        .insert(schema.adaptations)
        .values({
          orgId,
          contentItemId: itemId,
          channelId: index === 0 ? channelId : secondChannelId,
          status,
        })
        .returning({ id: schema.adaptations.id });
      adaptationIds.push(adaptation?.id as string);
    }
    return { itemId, adaptationIds };
  }

  async function itemStatus(itemId: string): Promise<string> {
    const [row] = await db
      .select({ status: schema.contentItems.status })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, itemId));
    return String(row?.status);
  }

  async function adaptationStatus(adaptationId: string): Promise<string> {
    const [row] = await db
      .select({ status: schema.adaptations.status })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    return String(row?.status);
  }

  /**
   * Waits until `count` backends are parked on a lock inside the statement
   * `queryLike` matches — i.e. until the interleaving this test is about is a
   * FACT rather than a hope about how two promises happened to schedule.
   *
   * Scoped to the statement text on purpose: `wait_event_type = 'Lock'` alone
   * would also count a waiter belonging to whichever other spec file vitest is
   * running beside this one.
   */
  async function waitForLockWaiters(queryLike: string, count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await db.execute(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE '${queryLike}'`,
      );
      if ((rows[0] as { n: number }).n >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count} backend(s) blocked on ${queryLike}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** The adaptation row's mutable state — everything a writer of this table moves. */
  async function adaptationRow(adaptationId: string) {
    const [row] = await db
      .select({
        status: schema.adaptations.status,
        lastError: schema.adaptations.lastError,
        attemptCount: schema.adaptations.attemptCount,
        body: schema.adaptations.body,
      })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    return row;
  }

  /** Its delivery log, in a stable order. */
  async function publicationRows(adaptationId: string) {
    return db
      .select({
        status: schema.publications.status,
        attempt: schema.publications.attempt,
        externalId: schema.publications.externalId,
        error: schema.publications.error,
      })
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId))
      .orderBy(schema.publications.attempt);
  }

  /**
   * Every writer on this repository, called with an org that does not own the
   * row, must do NOTHING.
   *
   * One test rather than nine, because the finding is one shape rather than
   * nine bugs: each of these methods carries an `org_id` predicate that its
   * neighbouring `id` predicate hides — the id is a primary key, so in the
   * service the wrong org never gets this far (`load` refuses first) and every
   * one of these filters could be deleted with the whole suite still green. The
   * repository is where they are observable, so the repository is where they
   * are pinned.
   */
  it("a call carrying another org's id moves nothing: every writer is a no-op", async () => {
    const adaptationId = await seedAdaptation("queued");
    expect(await repo.markPublishing(orgId, adaptationId)).toBe(true);
    expect(await repo.claimSend(orgId, adaptationId)).toBe(true);

    const before = {
      adaptation: await adaptationRow(adaptationId),
      publications: await publicationRows(adaptationId),
    };

    await repo.markPublished(strangerOrgId, adaptationId, {
      externalId: "999",
      externalUrl: "https://t.me/theirs/999",
    });
    await repo.markAlreadyPublished(strangerOrgId, adaptationId);
    await repo.markFailed(strangerOrgId, adaptationId, "not your delivery");
    await repo.recordTransient(strangerOrgId, adaptationId, "not your retry");
    await repo.releaseSend(strangerOrgId, adaptationId);
    // The two that answer rather than write: a claim another org cannot take.
    expect(await repo.markPublishing(strangerOrgId, adaptationId)).toBe(false);
    expect(await repo.claimSend(strangerOrgId, adaptationId)).toBe(false);

    expect({
      adaptation: await adaptationRow(adaptationId),
      publications: await publicationRows(adaptationId),
    }).toEqual(before);

    // The control, without which "nothing changed" proves nothing: the SAME
    // calls under the owning org do move the row.
    await repo.markPublished(orgId, adaptationId, {
      externalId: "1",
      externalUrl: "https://t.me/mine/1",
    });
    expect(await adaptationStatus(adaptationId)).toBe("published");
    expect(await repo.hasPublished(orgId, adaptationId)).toBe(true);
    // ...and the delivery that just landed is still invisible to anyone else.
    expect(await repo.hasPublished(strangerOrgId, adaptationId)).toBe(false);
  });

  it("load answers for the org that owns the adaptation, and for no other", async () => {
    const mine = await seedAdaptation("queued");

    expect(await repo.load(orgId, mine)).toMatchObject({ id: mine, orgId, platform: "telegram" });
    // The stranger has an adaptation of its own and `load` finds it, so an
    // `undefined` below is this org's filter working rather than a join that
    // returns nothing to anybody.
    expect(await repo.load(strangerOrgId, strangerAdaptationId)).toMatchObject({
      id: strangerAdaptationId,
      orgId: strangerOrgId,
    });

    // A publish job whose payload names the wrong org — the shape a mis-routed
    // or replayed job has — sees nothing. Asserted HERE rather than through the
    // service, because in the service this filter is masked: `load` refusing is
    // exactly what stops `credentials` from ever being asked.
    expect(await repo.load(strangerOrgId, mine)).toBeUndefined();
  });

  it("credentials decrypt only for the org that owns the channel", async () => {
    expect(await repo.credentials(orgId, channelId)).toEqual({ botToken: "1:a", chatId: "-1" });
    // Again positively: the stranger's own token comes back, so the throw below
    // is the org predicate and not a channel nobody can read.
    expect(await repo.credentials(strangerOrgId, strangerChannelId)).toEqual(STRANGER_CREDENTIALS);

    // The other half of the pair, killed on its own. This is the last read
    // before a real send: a decrypt that ignored `org_id` would hand one org's
    // bot token to another org's post.
    await expect(repo.credentials(strangerOrgId, channelId)).rejects.toThrow(
      `Channel ${channelId} not found for org ${strangerOrgId}`,
    );
  });

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
  /**
   * Two channels of ONE item landing in the same instant.
   *
   * The interleaving is pinned rather than hoped for. Every `publications` row
   * has a foreign key to `organization`, and Postgres takes `FOR KEY SHARE` on
   * the referenced org row for the INSERT — so a third session holding
   * `FOR UPDATE` on that row parks BOTH `markPublished` transactions at exactly
   * the point this race is made of: each has already written its own adaptation
   * (uncommitted), and neither has read its siblings yet. One COMMIT releases
   * them together, because two `FOR KEY SHARE` waiters do not conflict with
   * each other. No trigger, no `pg_sleep`, and nothing left in the schema for
   * the next test to trip over.
   *
   * Without the item lock in `recomputeItemStatus`, each transaction then reads
   * the other's adaptation as still `publishing` — MVCC, the write is not
   * committed — decides "not everyone is done", and writes nothing. Both
   * commit, every channel is published, and the ITEM is left at `approved`
   * forever: nothing recomputes it afterwards. The item then reads "Approved"
   * beside two live posts, refuses to be edited, and can still be REJECTED —
   * flipping a fully published item to `rejected`.
   *
   * This test is also the proof that the fix does not deadlock. It is precisely
   * the shape that WOULD deadlock had `recomputeItemStatus` locked the siblings
   * instead of (only) the parent: each transaction already holds its own
   * adaptation row, so each would wait for the other's. Locking the parent —
   * AFTER the adaptation, the order every writer of this pair uses — makes the
   * second transaction wait for the first and then see its result.
   */
  it("two channels landing at once: the item is promoted, and the two transactions do not deadlock", async () => {
    const { itemId, adaptationIds } = await seedFanOut(["publishing", "publishing"]);
    const [first, second] = adaptationIds as [string, string];

    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM organization WHERE id = $1 FOR UPDATE", [orgId]);

    const landings = Promise.allSettled([
      repo.markPublished(orgId, first, { externalId: "1", externalUrl: "https://t.me/c/1" }),
      repo.markPublished(orgId, second, { externalId: "2", externalUrl: "https://t.me/c/2" }),
    ]);
    try {
      await waitForLockWaiters('insert into "publications"%', 2);
    } finally {
      await holder.query("COMMIT");
      holder.release();
    }

    // A deadlock (40P01) would surface HERE, as a rejected promise, rather than
    // as a wrong status below — so both endings are asserted, not just the one.
    const outcomes = await landings;
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);

    expect(await adaptationStatus(first)).toBe("published");
    expect(await adaptationStatus(second)).toBe("published");
    expect(await itemStatus(itemId)).toBe("published");
  });

  /**
   * The other half of the same function, and the one a mutation walked straight
   * through: `every` → `some` in `recomputeItemStatus` survived the whole suite.
   *
   * It marks the item `published` the moment the FIRST channel succeeds, so an
   * item reads delivered while its other channels are still sitting in the
   * queue — and, worse, the item is then pinned (`requireNotPublished` refuses
   * to approve or reject it) while a delivery is still outstanding.
   */
  it("a partial fan-out is not a publication: one channel done, one still queued leaves the item approved", async () => {
    const { itemId, adaptationIds } = await seedFanOut(["publishing", "queued"]);

    await repo.markPublished(orgId, adaptationIds[0] as string, {
      externalId: "1",
      externalUrl: "https://t.me/c/1",
    });

    expect(await adaptationStatus(adaptationIds[0] as string)).toBe("published");
    expect(await itemStatus(itemId)).toBe("approved");
  });
});
