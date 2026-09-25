import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

// Type-only: avoids importing "./publish.repository" (which imports "../db" ->
// "../env", validated/connected eagerly at module load) before beforeAll()
// below has set DATABASE_URL. Same reasoning as apps/api/src/queue/queue.service.spec.ts.
type PublishRepositoryCtor = typeof import("./publish.repository").PublishRepository;
type PublishRepositoryInstance = InstanceType<PublishRepositoryCtor>;
type PublishServiceCtor = typeof import("./publish.service").PublishService;
type PublishServiceInstance = InstanceType<PublishServiceCtor>;
type SendClaim = import("./publish.repository").SendClaim;
type Schema = typeof import("@pubrick/db").schema;
type AdaptationStatus = import("@pubrick/shared").AdaptationStatus;

/**
 * Exercises PublishRepository's raw SQL (and PublishService.markExhausted on
 * top of a REAL repository, not a mock) against a real Postgres. The rest of
 * this app's suite mocks the repository entirely — the facts asserted here
 * (a publications row gets written, attempt_count actually advances, calling
 * markExhausted twice is a true no-op the second time) can only be proven
 * against real SQL, not a vi.fn() stub.
 */
/**
 * WHOSE CLOCK MEASURES THE LATENESS — asserted against the source, because no
 * behavioural test on one machine can.
 *
 * The whole point of computing `now() - scheduled_at` in Postgres is that a
 * worker-side `new Date()` puts TWO MACHINES on the two sides of the
 * comparison that decides whether a post still belongs in somebody's channel:
 * a worker whose clock runs ahead fails posts that are on time, one that runs
 * behind sends posts that are a day late. On a developer's box, and in CI, the
 * two clocks are the same clock — so replacing the SQL with
 * `Date.now() - row.scheduledAt.getTime()` passes every test in this file, in
 * `publish.service.spec.ts` and in `publish.e2e.spec.ts`. Measured, not
 * assumed.
 *
 * `scheduled_at` is `timestamptz` since migration 0014, so the zone-shaped test
 * that would catch the OTHER clock defect (`packages/db/src/timestamp-zone.test.ts`)
 * cannot catch this one either: an instant is an instant from either side.
 * What is left to pin is the statement itself, which is what this does — the
 * same move `apps/api/src/env-declaration.guard.spec.ts` makes for a rule no
 * type and no runtime can hold. It runs without a database on purpose: the
 * property is about the code, and a guard that skipped itself on an unset
 * TEST_DATABASE_URL would be exactly the dark tier this repo already has a
 * lesson about.
 */
describe("the lateness of a slot is measured by the database", () => {
  it("computes lateBySeconds from Postgres's now(), never from the worker's clock", () => {
    // `process.cwd()` is this package's root under vitest, the same anchor
    // `apps/api/src/env-declaration.guard.spec.ts` uses; `import.meta` is not
    // available, because this package typechecks as CommonJS.
    const source = readFileSync(
      path.join(process.cwd(), "src", "publish", "publish.repository.ts"),
      "utf8",
    );
    const load = source.slice(source.indexOf("async load("), source.indexOf("async credentials("));
    expect(load).toContain("lateBySeconds");
    expect(load).toMatch(/lateBySeconds:[\s\S]*?extract\(epoch from now\(\)/);
    // And not from here. `Date.now()` and `new Date()` are both spellings of
    // the same mistake.
    expect(load).not.toMatch(/Date\.now\(\)|new Date\(/);
  });
});

/** The other tenant's bot token. A different value, so "whose row came back" is readable. */
const STRANGER_CREDENTIALS = { botToken: "9:z", chatId: "-9" };

describe.skipIf(!url)("PublishRepository + PublishService.markExhausted (real DB)", () => {
  let repo: PublishRepositoryInstance;
  let service: PublishServiceInstance;
  let db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
  let pool: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
  let schema: Schema;
  let eq: typeof import("drizzle-orm").eq;
  let sql: typeof import("drizzle-orm").sql;
  let orgId: string;
  let brandId: string;
  let channelId: string;
  let secondChannelId: string;
  let strangerOrgId: string;
  let strangerChannelId: string;
  let strangerAdaptationId: string;
  let ChannelNotFoundError: typeof import("./publish.repository").ChannelNotFoundError;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    process.env.TELEGRAM_API_BASE_URL ??= "https://api.telegram.org";

    const dbModule = await import("@pubrick/db");
    schema = dbModule.schema;
    await dbModule.runMigrations(url as string);
    ({ db, pool } = dbModule.createDb(url as string));
    ({ eq, sql } = await import("drizzle-orm"));
    const { encryptJson } = await import("@pubrick/shared");

    const { PublishRepository, ChannelNotFoundError: notFound } = await import(
      "./publish.repository"
    );
    ChannelNotFoundError = notFound;
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
    channel: string = channelId,
  ) {
    const [item] = await db
      .insert(schema.contentItems)
      .values({ orgId, brandId, body: "Hello world" })
      .returning({ id: schema.contentItems.id });
    const itemId = item?.id as string;
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({ orgId, contentItemId: itemId, channelId: channel, status })
      .returning({ id: schema.adaptations.id });
    return adaptation?.id as string;
  }

  /**
   * An APPROVED item and one adaptation per status given — the shape the worker
   * finds after the api approved a multi-channel item and the queue got to some
   * of the channels before others.
   */
  async function seedFanOut(statuses: readonly AdaptationStatus[]) {
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
  /**
   * Waits until `count` backends are parked on a row lock inside a query matching
   * `queryLike` — the interleaving the two tests below are built out of.
   *
   * `inFlight` is the operation that is SUPPOSED to be doing that blocking, and passing
   * it is what keeps a failure legible. An operation that REJECTS instead of blocking
   * (a missing relation, a renamed column) produces no waiter, ever, so without it this
   * loop spins until vitest kills the test at its own 5s timeout — and the real error
   * arrives afterwards, detached, as an "unhandled rejection" attributed to whichever
   * test happened to be running.
   *
   * That is not hypothetical: it is precisely how `relation "pgboss.job" does not exist`
   * reached CI wearing the words "the deadlock test timed out in 5000ms". A deadlock test
   * that times out reads like a locking regression or a loaded runner — so the build was
   * read as flaky rather than as the one-line schema fact it actually was (see
   * vitest.global-setup.ts). Racing the wait against the operation reports the cause here,
   * at the line that caused it.
   */
  async function waitForLockWaiters(
    queryLike: string,
    count: number,
    inFlight?: Promise<unknown>,
  ): Promise<void> {
    let settled: { rejected: true; error: unknown } | { rejected: false } | undefined;
    // Attaching a rejection handler also means `inFlight` is no longer unhandled while we
    // wait; the caller still awaits it afterwards for its own assertions.
    void inFlight?.then(
      () => {
        settled = { rejected: false };
      },
      (error: unknown) => {
        settled = { rejected: true, error };
      },
    );
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await db.execute(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE '${queryLike}'`,
      );
      if ((rows[0] as { n: number }).n >= count) return;
      if (settled) {
        if (settled.rejected) throw settled.error;
        throw new Error(
          `the operation that should have blocked on ${queryLike} finished without ever blocking`,
        );
      }
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

  /** The coded reason, read on its own: nullable, and both values matter. */
  async function failureReasonOf(adaptationId: string): Promise<string | null> {
    const [row] = await db
      .select({ failureReason: schema.adaptations.failureReason })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    return row?.failureReason ?? null;
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
    expect(await repo.markPublishing(orgId, adaptationId, null)).toBe(1);
    const claim = await repo.claimSend(orgId, adaptationId);
    expect(claim).not.toBeNull();

    const before = {
      adaptation: await adaptationRow(adaptationId),
      publications: await publicationRows(adaptationId),
    };

    await repo.markPublished(strangerOrgId, adaptationId, {
      externalId: "999",
      externalUrl: "https://t.me/theirs/999",
    });
    await repo.markAlreadyPublished(strangerOrgId, adaptationId);
    // The fence is the one this row's own attempt holds, so `org_id` is the
    // only thing left that can refuse these writes — which is the point.
    const fence = { status: "publishing", attemptCount: 1 } as const;
    await repo.markFailed(
      strangerOrgId,
      adaptationId,
      "not your delivery",
      "platform_rejected",
      fence,
    );
    await repo.recordTransient(strangerOrgId, adaptationId, "not your retry", fence);
    // Even naming the claim by its own primary key, a stranger cannot release
    // it: `org_id` is still in the predicate.
    expect(await repo.releaseSend(strangerOrgId, claim as SendClaim)).toBe(false);
    // The two that answer rather than write: a claim another org cannot take.
    expect(await repo.markPublishing(strangerOrgId, adaptationId, null)).toBeNull();
    expect(await repo.claimSend(strangerOrgId, adaptationId)).toBeNull();

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

  /**
   * HOW LATE THE SLOT IS, measured by the database in the same statement that
   * reads the row — the fact `handle()` could not previously ask, and the reason
   * a worker back from a day-long outage published yesterday's post.
   *
   * The clock is BACKDATED, never mocked: `now()` is not injectable in the
   * worker and must not become so, because the comparison belongs to the
   * database (two machines on the two sides of it is the defect `nowSql` exists
   * to prevent). So the seed writes a `scheduled_at` in the past and the
   * assertion is over a WINDOW — seed and read are separate statements, and a
   * rounded equality flakes on a slow box.
   */
  it("load says how late the slot is, on Postgres's clock", async () => {
    const adaptationId = await seedAdaptation("scheduled");
    await db
      .update(schema.adaptations)
      .set({ scheduledAt: sql`now() - interval '26 hours'` })
      .where(eq(schema.adaptations.id, adaptationId));

    const loaded = await repo.load(orgId, adaptationId);
    expect(loaded?.lateBySeconds).toBeGreaterThan(26 * 3600 - 60);
    expect(loaded?.lateBySeconds).toBeLessThan(26 * 3600 + 60);
    // And the slot itself, which the refusal sentence names.
    expect(loaded?.scheduledAt).toBeInstanceOf(Date);
  });

  it("load calls an hour-old slot an hour late, and a future one NEGATIVE", async () => {
    const hourOld = await seedAdaptation("scheduled");
    await db
      .update(schema.adaptations)
      .set({ scheduledAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.adaptations.id, hourOld));
    const late = (await repo.load(orgId, hourOld))?.lateBySeconds as number;
    expect(late).toBeGreaterThan(3600 - 60);
    expect(late).toBeLessThan(3600 + 60);

    // The arm that stops an old job publishing a re-scheduled row HOURS EARLY.
    const ahead = await seedAdaptation("scheduled");
    await db
      .update(schema.adaptations)
      .set({ scheduledAt: sql`now() + interval '1 hour'` })
      .where(eq(schema.adaptations.id, ahead));
    const early = (await repo.load(orgId, ahead))?.lateBySeconds as number;
    expect(early).toBeLessThan(-3600 + 60);
  });

  /**
   * NULL, not zero. "Publish now" has no slot to have missed, and a zero here
   * would make every unscheduled delivery exactly-on-time — which is the same
   * number an inclusive bound treats as sendable, so the bug would hide.
   */
  it("load reports no lateness at all for an unscheduled delivery", async () => {
    const adaptationId = await seedAdaptation("queued");
    const loaded = await repo.load(orgId, adaptationId);
    expect(loaded?.scheduledAt).toBeNull();
    expect(loaded?.lateBySeconds).toBeNull();
  });

  /**
   * THE CODED REASON, written by the writer that fails the row and cleared by
   * the writer that moves it on. Both halves, because a nullable column written
   * by one branch and cleared by none is a stale flag.
   */
  it("markFailed stores the reason code beside the sentence, and markPublished clears it", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markFailed(
      orgId,
      adaptationId,
      "Telegram 400: chat not found",
      "platform_rejected",
      {
        status: "queued",
        attemptCount: 0,
      },
    );
    expect(await failureReasonOf(adaptationId)).toBe("platform_rejected");

    // The re-approve the screen offers, then a successful send.
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markPublished(orgId, adaptationId, { externalId: "1", externalUrl: null });
    expect(await failureReasonOf(adaptationId)).toBeNull();
  });

  /** And the attempt that STARTS clears the previous attempt's verdict. */
  it("markPublishing clears the reason a previous attempt left", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markFailed(orgId, adaptationId, "missed", "schedule_missed", {
      status: "queued",
      attemptCount: 0,
    });
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));

    await repo.markPublishing(orgId, adaptationId, null);
    expect(await failureReasonOf(adaptationId)).toBeNull();
  });

  /**
   * The reason MOVES rather than accumulating: a row that missed its slot, was
   * re-approved and then failed for a different cause must read as that cause.
   * Leaving `schedule_missed` standing beside a credentials sentence is the
   * exact defect the column was added not to reproduce one column over.
   */
  it("replaces the previous reason rather than keeping it", async () => {
    const adaptationId = await seedAdaptation("scheduled");
    await repo.markFailed(orgId, adaptationId, "missed its slot", "schedule_missed", {
      status: "scheduled",
      attemptCount: 0,
    });
    expect(await failureReasonOf(adaptationId)).toBe("schedule_missed");

    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markFailed(orgId, adaptationId, "bad credentials", "credentials_invalid", {
      status: "queued",
      attemptCount: 1,
    });
    expect(await failureReasonOf(adaptationId)).toBe("credentials_invalid");
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
    // The CLASS, not only the sentence: `PublishService` reserves
    // `credentials_missing` — "the channel is no longer connected, add it
    // again" — for this throw alone and rethrows every other failure of this
    // statement as transient. A plain `Error` here would put that sentence back
    // on a dropped connection.
    await expect(repo.credentials(strangerOrgId, channelId)).rejects.toBeInstanceOf(
      ChannelNotFoundError,
    );
  });

  it("credentials open a blob written before the versioned envelope existed", async () => {
    // The worker reads rows the api wrote, and every install that has ever run
    // Pubrick has rows in the pre-envelope shape: `base64(iv || tag ||
    // ciphertext)`, no version, no key id. Written out by hand rather than
    // through a shared helper, because the question is whether TODAY'S reader
    // opens YESTERDAY'S bytes.
    const { createCipheriv, randomBytes } = await import("node:crypto");
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from(process.env.APP_ENCRYPTION_KEY as string, "base64"),
      iv,
    );
    const legacy = { botToken: "legacy:token", chatId: "-1" };
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(legacy), "utf8"),
      cipher.final(),
    ]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    expect(blob).not.toContain(".");

    const [row] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "telegram",
        name: "Legacy",
        credentialsEncrypted: blob,
      })
      .returning({ id: schema.channels.id });

    expect(await repo.credentials(orgId, row?.id as string)).toEqual(legacy);
  });

  it("credentials raise the one marker — not a bare Error — for a blob no configured key opens", async () => {
    // What a rotated APP_ENCRYPTION_KEY leaves behind. `PublishService` routes
    // on this marker to write ONE answer onto `last_error`, so the marker has to
    // survive the repository rather than be reworded here.
    const { encryptJson, isUnreadableCiphertext } = await import("@pubrick/shared");
    const foreign = Buffer.from(new Uint8Array(32).fill(11)).toString("base64");
    const [row] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "telegram",
        name: "Foreign",
        credentialsEncrypted: encryptJson({ botToken: "1:a", chatId: "-1" }, foreign),
      })
      .returning({ id: schema.channels.id });

    let thrown: unknown;
    try {
      await repo.credentials(orgId, row?.id as string);
    } catch (error) {
      thrown = error;
    }
    expect(isUnreadableCiphertext(thrown)).toBe(true);
    expect((thrown as Error).message).not.toMatch(/unable to authenticate data/i);
  });

  it("markFailed on a fresh (queued) adaptation: attempt_count advances by exactly one and a failed publications row is written", async () => {
    const adaptationId = await seedAdaptation("queued");

    await repo.markFailed(orgId, adaptationId, "No adapter for platform vk", "no_adapter", {
      status: "queued",
      attemptCount: 0,
    });

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

  /**
   * THE CHECK-THEN-ACT, closed. `markExhausted` read `publishing` through
   * `load()` and then wrote unconditionally; a reject and a re-approve landing
   * in between left the freshly re-approved adaptation `failed` with "Retries
   * exhausted" — and the live job the re-approve had just enqueued then found a
   * failed row, was refused the claim, and completed having sent nothing.
   *
   * Here the interleaving is not raced, it is simply performed: the fence is
   * built from the row as the DLQ handler read it, the api's two writes are
   * applied, and the write is then offered. It must be refused, and the row
   * must be exactly as the user left it.
   */
  it("markFailed is fenced: the verdict of an attempt the row has moved on from does not land", async () => {
    const adaptationId = await seedAdaptation("queued");
    const attempt = await repo.markPublishing(orgId, adaptationId, null);
    expect(attempt).toBe(1);
    const fence = { status: "publishing", attemptCount: attempt as number } as const;

    // reject(): back to pending, count bumped, last_error cleared.
    await db
      .update(schema.adaptations)
      .set({ status: "pending", attemptCount: 2, lastError: null })
      .where(eq(schema.adaptations.id, adaptationId));
    // approve(): queued again, with a fresh job of its own on the way.
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));

    expect(
      await repo.markFailed(orgId, adaptationId, "Retries exhausted", "retries_exhausted", fence),
    ).toBe(false);

    expect(await adaptationRow(adaptationId)).toMatchObject({
      status: "queued",
      attemptCount: 2,
      lastError: null,
    });
    // And no corpse in the delivery log either.
    expect(await publicationRows(adaptationId)).toHaveLength(0);
  });

  /**
   * The half of the fence a status check alone cannot do. A reject followed by
   * a re-approve puts the row back into a status the dead attempt also saw, so
   * `status` agrees and only the count disagrees — which is exactly why the
   * fence is the PAIR the api already keys a publish job on.
   */
  it("markFailed is fenced on the attempt COUNT too, not just the status", async () => {
    const adaptationId = await seedAdaptation("queued");
    // What the no-adapter path holds: the row exactly as `load()` returned it.
    const fence = { status: "queued", attemptCount: 0 } as const;
    // reject() + approve(): same status, one attempt further on.
    await db
      .update(schema.adaptations)
      .set({ attemptCount: 1 })
      .where(eq(schema.adaptations.id, adaptationId));

    expect(
      await repo.markFailed(orgId, adaptationId, "No adapter for platform vk", "no_adapter", fence),
    ).toBe(false);

    expect(await adaptationRow(adaptationId)).toMatchObject({
      status: "queued",
      attemptCount: 1,
      lastError: null,
    });
  });

  /**
   * And the other half of the pair. A dead-letter copy delivered after the
   * attempt it belongs to actually SUCCEEDED carries a fence whose count is
   * still right — `markPublished` does not touch `attempt_count` — so only the
   * status half can refuse it. Without that half a delivered post is recorded
   * as a failure, with a `failed` publications row filed next to the
   * `published` one.
   */
  it("markFailed is fenced on the STATUS too, not just the count", async () => {
    const adaptationId = await seedAdaptation("queued");
    const attempt = await repo.markPublishing(orgId, adaptationId, null);
    await repo.claimSend(orgId, adaptationId);
    await repo.markPublished(orgId, adaptationId, {
      externalId: "4242",
      externalUrl: "https://t.me/x/4242",
    });

    expect(
      await repo.markFailed(orgId, adaptationId, "Retries exhausted", "retries_exhausted", {
        status: "publishing",
        attemptCount: attempt as number,
      }),
    ).toBe(false);

    expect(await adaptationRow(adaptationId)).toMatchObject({
      status: "published",
      attemptCount: 1,
      lastError: null,
    });
    const pubs = await publicationRows(adaptationId);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.status).toBe("published");
  });

  /**
   * `reject()` clears `last_error` on its way to `pending` precisely so a
   * rejected adaptation does not read as a failed one. The transient path used
   * to stamp the dying attempt's platform error straight back onto it.
   */
  it("recordTransient is fenced: it cannot re-stamp an error a reject has just cleared", async () => {
    const adaptationId = await seedAdaptation("queued");
    const attempt = await repo.markPublishing(orgId, adaptationId, null);
    const fence = { status: "publishing", attemptCount: attempt as number } as const;

    await db
      .update(schema.adaptations)
      .set({ status: "pending", attemptCount: 2, lastError: null })
      .where(eq(schema.adaptations.id, adaptationId));

    expect(await repo.recordTransient(orgId, adaptationId, "Too Many Requests", fence)).toBe(false);
    expect(await adaptationRow(adaptationId)).toMatchObject({
      status: "pending",
      lastError: null,
    });
  });

  /** The same write, offered to the row it does belong to, still lands. */
  it("recordTransient lands on the attempt that owns the row, and renews its updated_at", async () => {
    const adaptationId = await seedAdaptation("queued");
    const attempt = await repo.markPublishing(orgId, adaptationId, null);
    await db
      .update(schema.adaptations)
      .set({ updatedAt: sql`now() - interval '1 hour'` })
      .where(eq(schema.adaptations.id, adaptationId));

    expect(
      await repo.recordTransient(orgId, adaptationId, "Too Many Requests", {
        status: "publishing",
        attemptCount: attempt as number,
      }),
    ).toBe(true);

    const [row] = await db
      .select({ lastError: schema.adaptations.lastError, updatedAt: schema.adaptations.updatedAt })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(row?.lastError).toBe("Too Many Requests");
    // The renewal is not cosmetic: it is what keeps a live retry chain out of
    // sweepAbandoned's candidate set.
    const updatedAt = row?.updatedAt as Date;
    expect(Date.now() - updatedAt.getTime()).toBeLessThan(60_000);
  });

  it("markFailed on a row already 'publishing' (markPublishing already bumped it): attempt_count does NOT bump a second time", async () => {
    const adaptationId = await seedAdaptation("queued");

    await repo.markPublishing(orgId, adaptationId, null);
    {
      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      expect(row?.status).toBe("publishing");
      expect(row?.attemptCount).toBe(1);
    }

    await repo.markFailed(orgId, adaptationId, "Forbidden", "platform_rejected", {
      status: "publishing",
      attemptCount: 1,
    });

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
    await repo.markPublishing(orgId, adaptationId, null);
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

    await repo.markFailed(orgId, adaptationId, "first", "platform_rejected", {
      status: "queued",
      attemptCount: 0,
    });
    // A re-approve between the two attempts, which is the only way one
    // adaptation legitimately fails twice — and the fence follows the row.
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markFailed(orgId, adaptationId, "second", "platform_rejected", {
      status: "queued",
      attemptCount: 1,
    });

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
    await repo.markPublishing(orgId, adaptationId, null);
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
    await repo.markFailed(orgId, adaptationId, "nope", "platform_rejected", {
      status: "queued",
      attemptCount: 0,
    });
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

  /**
   * A RECEIPT A PERSON WROTE STOPS A RE-SEND EXACTLY AS A PLATFORM'S DOES.
   *
   * When an attempt's answer never comes back, the api lets somebody open the
   * channel, find the post there, and file a `published` receipt carrying
   * `asserted_by` (`ContentRepository.assertDelivery`). This guard is what has
   * to honour it: the whole reason a human verdict is recorded in the ORDINARY
   * shape is that nothing downstream should need teaching about it.
   *
   * The mutation this kills is narrowing the query to receipts no human
   * asserted. Under it a job redelivered for an adaptation whose post a person
   * has already found live sails past the cheap guard and posts a second copy —
   * which is the outcome the entire unknown-delivery design exists to prevent,
   * reintroduced one table over.
   */
  it("hasPublished honours a delivery a person asserted, not only one a platform answered for", async () => {
    const adaptationId = await seedAdaptation("queued");
    const [row] = await db
      .select({ channelId: schema.adaptations.channelId })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    const personId = `publish-repo-test-person-${Date.now()}`;
    await db.insert(schema.user).values({
      id: personId,
      name: "A person who looked",
      email: `${personId}@example.com`,
    });

    await db.insert(schema.publications).values({
      orgId,
      adaptationId,
      channelId: row?.channelId as string,
      status: "published",
      // No id and no link: nobody ever had one. That absence is exactly why a
      // query could be tempted to treat this receipt as less than a delivery.
      externalId: null,
      externalUrl: null,
      attempt: 1,
      assertedBy: personId,
    });

    expect(await repo.hasPublished(orgId, adaptationId)).toBe(true);
  });

  it("markPublishing claims only a publishable row: false (and no attempt_count movement) once the api has moved it", async () => {
    // This is what stops a reject that commits between load() and the claim
    // from being published anyway: both sides take the same row lock.
    const rejected = await seedAdaptation("pending");
    expect(await repo.markPublishing(orgId, rejected, null)).toBeNull();
    {
      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, rejected));
      expect(row?.status).toBe("pending");
      expect(row?.attemptCount).toBe(0);
    }

    const alreadyDone = await seedAdaptation("published");
    expect(await repo.markPublishing(orgId, alreadyDone, null)).toBeNull();

    // Claimable: freshly queued, scheduled, and a pg-boss retry of a
    // transiently failed attempt (which leaves the row at "publishing").
    for (const status of ["queued", "scheduled", "publishing"] as const) {
      const adaptationId = await seedAdaptation(status);
      // The answer is the attempt's own number, which is what every later
      // write of it is fenced on — not a bare true.
      expect(await repo.markPublishing(orgId, adaptationId, null)).toBe(1);
    }

    // Org-scoped: another org cannot claim this org's row.
    const mine = await seedAdaptation("queued");
    expect(await repo.markPublishing("some-other-org", mine, null)).toBeNull();
  });

  it("refuses a stale queued job whose parent has been archived", async () => {
    const adaptationId = await seedAdaptation("queued");
    const [adaptation] = await db
      .select({ contentItemId: schema.adaptations.contentItemId })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    await db
      .update(schema.contentItems)
      .set({ status: "archived", archivedFromStatus: "approved" })
      .where(eq(schema.contentItems.id, adaptation?.contentItemId as string));

    expect(await repo.markPublishing(orgId, adaptationId, null)).toBeNull();
    expect(await adaptationRow(adaptationId)).toMatchObject({
      status: "queued",
      attemptCount: 0,
    });
  });

  /**
   * THE `load()` → CLAIM WINDOW, which is the one the future-slot arm cannot
   * close by itself.
   *
   * `PublishService.handle` decides "this slot has been moved into the future,
   * touch nothing" from `load()`'s snapshot, and then claims. A re-approve that
   * commits in between leaves the old job holding a snapshot that says the post
   * is merely overdue — and `scheduled` is claimable, so without this predicate
   * the old job would claim the row the new time lives on and post it HOURS
   * EARLY, which is the same injury the arm exists to prevent.
   *
   * So the claim is fenced on the slot the decision was made about. Two
   * connections, interleaved by hand in the order the race puts them: the
   * worker reads, the api writes and commits, the worker claims.
   */
  it("markPublishing refuses the claim when the slot moved between the read and it", async () => {
    const adaptationId = await seedAdaptation("scheduled");
    await db
      .update(schema.adaptations)
      .set({ scheduledAt: new Date(Date.now() - 26 * 3600 * 1000) })
      .where(eq(schema.adaptations.id, adaptationId));

    // The worker's snapshot, taken through the same statement the handler uses.
    const loaded = await repo.load(orgId, adaptationId);
    expect(loaded?.scheduledAt).toBeInstanceOf(Date);

    // The api, on a connection of its own, moving the slot into the future and
    // committing — the re-approve this window is about.
    const moved = new Date(Date.now() + 3600 * 1000);
    const api = await pool.connect();
    try {
      await api.query("update adaptations set scheduled_at = $1 where id = $2", [
        moved,
        adaptationId,
      ]);
    } finally {
      api.release();
    }

    expect(await repo.markPublishing(orgId, adaptationId, loaded?.scheduledAt ?? null)).toBeNull();

    const [row] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(row?.status).toBe("scheduled");
    expect(row?.attemptCount).toBe(0);
    expect(row?.scheduledAt?.getTime()).toBe(moved.getTime());

    // And the job that DOES hold the new time claims it, on the same snapshot
    // its own load() would take — the fence bounds the stale job, not every job.
    const fresh = await repo.load(orgId, adaptationId);
    expect(await repo.markPublishing(orgId, adaptationId, fresh?.scheduledAt ?? null)).toBe(1);
  });

  /**
   * The other half of the same predicate: a slot that did NOT move must not
   * cost the claim. `null` (a "publish now" row) and a real timestamp both have
   * to compare equal to themselves — which is why the predicate is
   * `is not distinct from` rather than `=`, and why the comparison is made at
   * the precision the worker's snapshot actually carries.
   */
  it("markPublishing claims a row whose slot is exactly what was read", async () => {
    const unscheduled = await seedAdaptation("queued");
    const loadedNull = await repo.load(orgId, unscheduled);
    expect(loadedNull?.scheduledAt).toBeNull();
    expect(await repo.markPublishing(orgId, unscheduled, null)).toBe(1);

    const scheduled = await seedAdaptation("scheduled");
    await db
      .update(schema.adaptations)
      .set({ scheduledAt: sql`now() - interval '3 hours'` })
      .where(eq(schema.adaptations.id, scheduled));
    const loaded = await repo.load(orgId, scheduled);
    expect(await repo.markPublishing(orgId, scheduled, loaded?.scheduledAt ?? null)).toBe(1);
  });

  it("markExhausted: marks failed with a retries-exhausted reason, writes the publications row, and is idempotent on a second delivery", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId, null); // simulate an in-flight attempt before the DLQ fires

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

  it("markExhausted preserves an accepted Telegram photo as an unresolved partial delivery", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId, null);
    const claim = (await repo.claimSend(orgId, adaptationId)) as SendClaim;
    expect(
      await repo.markTelegramPhotoAccepted(orgId, adaptationId, claim, {
        photoId: "4711",
        photoUrl: "https://t.me/mychannel/4711",
        followupText: "Frozen missing reply",
        followupOutcome: "pending",
      }),
    ).toBe(true);

    await service.markExhausted({ adaptationId, orgId });
    const [adaptation] = await db
      .select({
        status: schema.adaptations.status,
        failureReason: schema.adaptations.failureReason,
        lastError: schema.adaptations.lastError,
      })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(adaptation).toMatchObject({
      status: "failed",
      failureReason: "outcome_unknown",
      lastError: expect.stringContaining("accepted the cover"),
    });
    const receipts = await publicationsFor(adaptationId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: "unknown",
      partialPhotoId: "4711",
      partialPhotoUrl: "https://t.me/mychannel/4711",
      partialFollowupText: "Frozen missing reply",
      partialFollowupOutcome: "pending",
    });
    await service.markExhausted({ adaptationId, orgId });
    expect(await publicationsFor(adaptationId)).toHaveLength(1);
  });

  /**
   * A channel of its own, for the tests that DELETE one. The shared fixtures
   * above are used by every other test in this file, so a delete of either
   * would make this suite order-dependent.
   */
  async function seedDisposableChannel(name: string): Promise<string> {
    const { encryptJson } = await import("@pubrick/shared");
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "telegram",
        name,
        credentialsEncrypted: encryptJson(
          { botToken: "9:disposable", chatId: "-99" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      })
      .returning({ id: schema.channels.id });
    return channel?.id as string;
  }

  /** One publications row by its own primary key — the only pointer a delete cannot null. */
  async function publicationById(id: string) {
    const [row] = await db.select().from(schema.publications).where(eq(schema.publications.id, id));
    return row;
  }

  /**
   * One item, two stale `publishing` adaptations, inserted so that HEAP order is
   * the reverse of ID order — the premise of the deadlock the sweep's missing
   * `ORDER BY` caused. Written with explicit ids because that is the only way to
   * make the two orders disagree on purpose.
   */
  async function seedReversedHeapOrder(status: AdaptationStatus = "publishing") {
    const [item] = await db
      .insert(schema.contentItems)
      .values({ orgId, brandId, body: "Two channels", status: "approved" })
      .returning({ id: schema.contentItems.id });
    const itemId = item?.id as string;
    const run = randomUUID().slice(0, 8);
    const ids = [2, 1].map((n) => `${run}-0000-4000-8000-${String(n).padStart(12, "0")}`);
    const channels = [
      await seedDisposableChannel(`Heap A ${run}`),
      await seedDisposableChannel(`Heap B ${run}`),
    ];
    for (const [index, id] of ids.entries()) {
      await db.insert(schema.adaptations).values({
        id,
        orgId,
        contentItemId: itemId,
        channelId: channels[index] as string,
        status,
        attemptCount: 1,
      });
    }
    // Older than one whole attempt window plus its grace: candidates for
    // `sweepAbandoned`. A day is also past `PUBLISH_MAX_LATENESS_HOURS`, so a
    // `scheduled` set seeded here is a candidate for `sweepStranded` too — and
    // the slot has to move with the silence, since that sweep measures a
    // scheduled row by `scheduled_at` and not by `updated_at`.
    await db.execute(
      `UPDATE adaptations SET updated_at = now() - interval '1 day',
              scheduled_at = CASE WHEN status = 'scheduled' THEN now() - interval '1 day' END
        WHERE content_item_id = '${itemId}'`,
    );
    return { itemId, adaptationIds: ids };
  }

  async function publicationsFor(adaptationId: string) {
    return db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId));
  }

  it("claimSend writes an in-flight row carrying the attempt that markPublishing just bumped", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId, null);

    const claim = await repo.claimSend(orgId, adaptationId);

    const pubs = await publicationsFor(adaptationId);
    expect(pubs).toHaveLength(1);
    // The claim it hands back names the row it just wrote — the address every
    // later write of this attempt uses, and the only one a channel delete
    // cannot null out.
    expect(claim).toEqual({ id: pubs[0]?.id, attempt: 1 });
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
    await repo.markPublishing(orgId, adaptationId, null);
    expect(await repo.claimSend(orgId, adaptationId)).not.toBeNull();

    await repo.markPublishing(orgId, adaptationId, null); // the redelivery re-claims the attempt
    expect(await repo.claimSend(orgId, adaptationId)).toBeNull();

    expect(await publicationsFor(adaptationId)).toHaveLength(1);
  });

  it("claimSend is org-scoped and reports false for an adaptation that is not there", async () => {
    const adaptationId = await seedAdaptation("queued");
    expect(await repo.claimSend("some-other-org", adaptationId)).toBeNull();
    expect(await publicationsFor(adaptationId)).toHaveLength(0);
  });

  it("releaseSend hands the claim back so an honest retry can take it again", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId, null);
    const claim = (await repo.claimSend(orgId, adaptationId)) as SendClaim;

    expect(await repo.releaseSend(orgId, claim)).toBe(true);
    expect(await publicationsFor(adaptationId)).toHaveLength(0);

    await repo.markPublishing(orgId, adaptationId, null);
    expect(await repo.claimSend(orgId, adaptationId)).not.toBeNull();
  });

  it("durably freezes an accepted Telegram photo and tail on this tenant's claim", async () => {
    const adaptationId = await seedAdaptation("queued");
    const attempt = await repo.markPublishing(orgId, adaptationId, null);
    const claim = (await repo.claimSend(orgId, adaptationId)) as SendClaim;
    const partial = {
      photoId: "4711",
      photoUrl: "https://t.me/mychannel/4711",
      followupText: "Frozen missing reply",
      followupOutcome: "pending" as const,
    };

    expect(await repo.markTelegramPhotoAccepted(strangerOrgId, adaptationId, claim, partial)).toBe(
      false,
    );
    expect(await repo.markTelegramPhotoAccepted(orgId, adaptationId, claim, partial)).toBe(true);
    const [checkpoint] = await db
      .select({
        status: schema.publications.status,
        photoId: schema.publications.partialPhotoId,
        photoUrl: schema.publications.partialPhotoUrl,
        followup: schema.publications.partialFollowupText,
        outcome: schema.publications.partialFollowupOutcome,
      })
      .from(schema.publications)
      .where(eq(schema.publications.id, claim.id));
    expect(checkpoint).toEqual({
      status: "in_flight",
      photoId: "4711",
      photoUrl: "https://t.me/mychannel/4711",
      followup: "Frozen missing reply",
      outcome: "pending",
    });

    expect(
      await repo.markFailed(
        orgId,
        adaptationId,
        "Reply refused",
        "outcome_unknown",
        { status: "publishing", attemptCount: attempt as number },
        "unknown",
        claim,
        { ...partial, followupOutcome: "rejected" },
      ),
    ).toBe(true);
    const [finished] = await db
      .select({
        status: schema.publications.status,
        photoId: schema.publications.partialPhotoId,
        followup: schema.publications.partialFollowupText,
        outcome: schema.publications.partialFollowupOutcome,
      })
      .from(schema.publications)
      .where(eq(schema.publications.id, claim.id));
    expect(finished).toEqual({
      status: "unknown",
      photoId: "4711",
      followup: "Frozen missing reply",
      outcome: "rejected",
    });
    expect(await repo.markTelegramPhotoAccepted(orgId, adaptationId, claim, partial)).toBe(false);
  });

  it("releaseSend takes only the in-flight claim, never a terminal record", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markFailed(orgId, adaptationId, "first attempt", "platform_rejected", {
      status: "queued",
      attemptCount: 0,
    });
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markPublishing(orgId, adaptationId, null);
    const claim = (await repo.claimSend(orgId, adaptationId)) as SendClaim;

    expect(await repo.releaseSend(orgId, claim)).toBe(true);

    const pubs = await publicationsFor(adaptationId);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]?.status).toBe("failed");
  });

  it("markPublished resolves the claim in place: one row, not a claim plus a delivery", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId, null);
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
    await repo.markPublishing(orgId, adaptationId, null);
    expect(await repo.claimSend(orgId, adaptationId)).not.toBeNull();
  });

  it("markFailed resolves the claim to failed rather than leaving one behind", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId, null);
    await repo.claimSend(orgId, adaptationId);

    await repo.markFailed(orgId, adaptationId, "Forbidden", "platform_rejected", {
      status: "publishing",
      attemptCount: 1,
    });

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
    await repo.markPublishing(orgId, adaptationId, null);
    await repo.claimSend(orgId, adaptationId);

    await repo.markFailed(
      orgId,
      adaptationId,
      "outcome unknown, check the channel",
      "outcome_unknown",
      { status: "publishing", attemptCount: 1 },
      "unknown",
    );

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
    await repo.markPublishing(orgId, adaptationId, null);
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
    await repo.markFailed(
      orgId,
      adaptationId,
      "unknown outcome",
      "outcome_unknown",
      { status: "publishing", attemptCount: 1 },
      "unknown",
    );
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markPublishing(orgId, adaptationId, null);
    expect(await repo.claimSend(orgId, adaptationId)).not.toBeNull();
    const pubs = await publicationsFor(adaptationId);
    expect(pubs).toHaveLength(2);
    expect(pubs.map((row) => row.status).sort()).toEqual(["in_flight", "unknown"]);
  });

  /**
   * I2: an attempt that has been overtaken must not be able to delete the claim
   * of the attempt that overtook it.
   *
   * The sequence is the one the product actually produces. A claims and hangs
   * mid-send. The heartbeat supervisor redelivers; B is refused the claim and
   * resolves A's row to `unknown`, which frees the in-flight slot. The operator
   * checks the channel and re-approves. C claims and sends. THEN A finally comes
   * back with a transient error and hands "the claim" back — and before the
   * fence, the only claim in flight was C's. If C dies before recording, the
   * redelivery finds no claim and posts a second time, which is exactly what
   * the in-flight index exists to prevent.
   */
  it("releaseSend gives back only THIS attempt's claim, never the one that overtook it", async () => {
    const adaptationId = await seedAdaptation("queued");
    expect(await repo.markPublishing(orgId, adaptationId, null)).toBe(1);
    const hung = (await repo.claimSend(orgId, adaptationId)) as SendClaim;

    // The redelivered attempt B: refused the claim, records an unknown outcome,
    // and in doing so RESOLVES the hung attempt's row — the slot is free again.
    await repo.markFailed(
      orgId,
      adaptationId,
      "outcome unknown",
      "outcome_unknown",
      {
        status: "publishing",
        attemptCount: 1,
      },
      "unknown",
    );
    // The operator checks the channel and re-approves; attempt C claims and sends.
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    expect(await repo.markPublishing(orgId, adaptationId, null)).toBe(2);
    const live = (await repo.claimSend(orgId, adaptationId)) as SendClaim;
    expect(live.id).not.toBe(hung.id);

    // A comes back at last. Its release must match its own row — which is no
    // longer in flight — and nothing else.
    expect(await repo.releaseSend(orgId, hung)).toBe(false);

    const pubs = await publicationsFor(adaptationId);
    const stillClaimed = pubs.find((row) => row.id === live.id);
    expect(stillClaimed?.status, "a live attempt's send claim was deleted by a dead one").toBe(
      "in_flight",
    );
    // ...and a second send is still refused, which is the property that matters.
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markPublishing(orgId, adaptationId, null);
    expect(await repo.claimSend(orgId, adaptationId)).toBeNull();
  });

  /**
   * The same fence as `releaseSend`, one method over — and this one needs it
   * MORE, because `markPublished` is deliberately unfenced on the adaptation: a
   * post that went out is a fact, and it is recorded whatever the row says now.
   *
   * So an overtaken attempt DOES reach `resolveClaim` here. Addressing the claim
   * by "whatever is in flight for this adaptation" would have it stamp its own
   * delivery onto a live successor's claim, freeing the in-flight slot the
   * successor is relying on. Its own row, by primary key, or a fresh record —
   * never somebody else's claim.
   */
  it("markPublished resolves its OWN claim, never a successor's, when it comes back late", async () => {
    const adaptationId = await seedAdaptation("queued");
    await repo.markPublishing(orgId, adaptationId, null);
    const hung = (await repo.claimSend(orgId, adaptationId)) as SendClaim;
    // The redelivery reports an unknown outcome, resolving the hung claim.
    await repo.markFailed(
      orgId,
      adaptationId,
      "outcome unknown",
      "outcome_unknown",
      {
        status: "publishing",
        attemptCount: 1,
      },
      "unknown",
    );
    await db
      .update(schema.adaptations)
      .set({ status: "queued" })
      .where(eq(schema.adaptations.id, adaptationId));
    await repo.markPublishing(orgId, adaptationId, null);
    const live = (await repo.claimSend(orgId, adaptationId)) as SendClaim;

    await repo.markPublished(
      orgId,
      adaptationId,
      { externalId: "11", externalUrl: "https://t.me/x/11" },
      hung,
    );

    expect(
      (await publicationById(live.id))?.status,
      "a live attempt's send claim was consumed by an overtaken one",
    ).toBe("in_flight");
    expect(await publicationById(hung.id)).toMatchObject({ status: "unknown" });
    const published = (await publicationsFor(adaptationId)).filter(
      (row) => row.status === "published",
    );
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ externalId: "11" });
  });

  /**
   * I4: the post went live and the channel was deleted before the attempt could
   * record it. The adaptation cascades away, both of the claim's pointers are
   * nulled, and the adaptation-scoped write matches nothing — so the receipt
   * used to be stranded at `in_flight` with no id and no link, for ever, about a
   * post that is live in someone's channel. Both the changelog and the schema
   * comment promise the opposite.
   */
  it("markPublished still records the delivery when the channel — and so the adaptation — was deleted mid-send", async () => {
    const disposable = await seedDisposableChannel("Deleted mid-send");
    const adaptationId = await seedAdaptation("queued", disposable);
    await repo.markPublishing(orgId, adaptationId, null);
    const claim = (await repo.claimSend(orgId, adaptationId)) as SendClaim;

    // The user deletes the channel while the request is in flight. The cascade
    // takes the adaptation; `SET NULL` takes both of the claim's pointers; the
    // BEFORE DELETE trigger stamps the tombstone.
    await db.delete(schema.channels).where(eq(schema.channels.id, disposable));

    await repo.markPublished(
      orgId,
      adaptationId,
      { externalId: "4242", externalUrl: "https://t.me/gone/4242" },
      claim,
    );

    const receipt = await publicationById(claim.id);
    expect(receipt).toMatchObject({
      status: "published",
      externalId: "4242",
      externalUrl: "https://t.me/gone/4242",
      attempt: 1,
      adaptationId: null,
      channelId: null,
      // What the tombstone is for: the receipt can still say where the post went.
      channelName: "Deleted mid-send",
      channelPlatform: "telegram",
    });
  });

  /**
   * The other half of I4: the attempt never comes back at all. Nothing can
   * resolve such a claim from the adaptation side — `sweepAbandoned` drives off
   * `adaptations` and there is no adaptation left to be `publishing` — so
   * without this pass the row says "an attempt is out there right now" for ever.
   */
  it("sweepOrphanedClaims resolves a claim whose adaptation was deleted, and leaves a fresh one alone", async () => {
    const stale = await seedDisposableChannel("Long gone");
    const staleAdaptation = await seedAdaptation("queued", stale);
    await repo.markPublishing(orgId, staleAdaptation, null);
    const staleClaim = (await repo.claimSend(orgId, staleAdaptation)) as SendClaim;
    const fresh = await seedDisposableChannel("Just now");
    const freshAdaptation = await seedAdaptation("queued", fresh);
    await repo.markPublishing(orgId, freshAdaptation, null);
    const freshClaim = (await repo.claimSend(orgId, freshAdaptation)) as SendClaim;
    await db.delete(schema.channels).where(eq(schema.channels.id, stale));
    await db.delete(schema.channels).where(eq(schema.channels.id, fresh));
    // Only one of them is older than a whole attempt window plus its grace.
    await db.execute(
      `UPDATE publications SET created_at = now() - interval '1 day' WHERE id = '${staleClaim.id}'`,
    );

    const swept = await repo.sweepOrphanedClaims();

    expect(swept.map((row) => row.id)).toContain(staleClaim.id);
    expect(swept.map((row) => row.id)).not.toContain(freshClaim.id);
    const resolved = await publicationById(staleClaim.id);
    expect(resolved).toMatchObject({ status: "unknown", channelName: "Long gone" });
    expect(String(resolved?.error)).toContain("DELIVERY OUTCOME UNKNOWN");
    // A live attempt's claim is not somebody else's to resolve.
    expect((await publicationById(freshClaim.id))?.status).toBe("in_flight");
    // Nor is an OLD claim whose adaptation still exists: that one is still
    // reachable from the adaptation side, and `sweepAbandoned` owns it —
    // including its check that no pg-boss job could still finish the attempt.
    // This pass is only for the rows that side can never see.
    const reachable = await seedAdaptation("queued");
    await repo.markPublishing(orgId, reachable, null);
    const reachableClaim = (await repo.claimSend(orgId, reachable)) as SendClaim;
    await db.execute(
      `UPDATE publications SET created_at = now() - interval '1 day' WHERE id = '${reachableClaim.id}'`,
    );
    expect((await repo.sweepOrphanedClaims()).map((row) => row.id)).not.toContain(
      reachableClaim.id,
    );
    expect((await publicationById(reachableClaim.id))?.status).toBe("in_flight");
  });

  /**
   * I8: the sweep walks `adaptations` in the same order as everybody else.
   *
   * `ContentRepository.lockAdaptations` takes an item's adaptations
   * `ORDER BY id FOR UPDATE`, and its own comment says why: two transactions
   * must not walk one set in opposite orders. The sweep was one bulk UPDATE with
   * no ORDER BY, so it locked in heap order — which reverses freely — and
   * `reject` targets `publishing`, exactly the sweep's candidate set. The two
   * rows below are inserted high-id-first so that heap order IS the reverse of
   * id order, which is the whole premise.
   *
   * Both transactions must commit. Before the fix one of them died with 40P01,
   * and when it was the api's, a person cancelling a delivery got a 500.
   */
  it("sweepAbandoned locks in id order, so it cannot deadlock against an item's ordered lock", async () => {
    const { itemId, adaptationIds } = await seedReversedHeapOrder();
    const [low, high] = [...adaptationIds].sort() as [string, string];

    const rejecting = await pool.connect();
    let sweptOutcome: PromiseSettledResult<unknown>;
    let rejectError: string | null = null;
    try {
      // The api's `reject`, mid-scan: it has locked the first row of its ordered
      // walk and has not yet reached the second.
      await rejecting.query("BEGIN");
      await rejecting.query("SELECT id FROM adaptations WHERE id = $1 FOR UPDATE", [low]);

      const sweeping = repo.sweepAbandoned();
      // The sweeper is now parked on a row lock — on `high` before the fix, on
      // `low` after it. Either way the interleaving is a fact, not a hope. Passing
      // `sweeping` makes "the sweep rejected instead of blocking" say so, rather
      // than time out five seconds later as if the lock were merely slow.
      await waitForLockWaiters("%make_interval%", 1, sweeping);

      // ...and now `reject` walks on to the rest of its ordered set.
      rejectError = await rejecting
        .query(
          `SELECT id FROM adaptations
            WHERE content_item_id = $1 AND status IN ('queued','scheduled','publishing')
            ORDER BY id FOR UPDATE`,
          [itemId],
        )
        .then(
          () => null,
          (error: { code?: string }) => String(error.code),
        );
      await rejecting.query("COMMIT");
      [sweptOutcome] = await Promise.allSettled([sweeping]);
    } finally {
      await rejecting.query("ROLLBACK").catch(() => {});
      rejecting.release();
    }

    expect(
      rejectError,
      "reject was the deadlock victim — a 500 for cancelling a delivery",
    ).toBeNull();
    expect(sweptOutcome.status, "the sweep was the deadlock victim").toBe("fulfilled");
    // Nothing was swept: `reject` held `low` throughout, so the sweep's own
    // re-check under the lock is what decides — and `high` is genuinely stale.
    expect(await adaptationStatus(high)).toBe("failed");
  });

  /**
   * THE NEW COUNTERPARTY, and the reason `docs/lock-order.md` grew an edge with
   * this change rather than the one before it.
   *
   * `sweepStranded` is a bulk write over `scheduled` and `queued` rows — a
   * candidate set `ContentRepository.approve` walks as well as `reject`, since
   * `lockAdaptations(…, ["pending","failed","scheduled"])` is approve's own
   * ordered walk. `sweepAbandoned` never contended with approve at all: nothing
   * re-approves a `publishing` row. So this pass has a counterparty its sibling
   * did not, and an unordered bulk UPDATE against approve's ascending walk is
   * the same cycle this project has already closed twice.
   *
   * The two rows are inserted high-id-first so heap order IS the reverse of id
   * order — the premise, exactly as in the sweep test above. Both transactions
   * must commit; before the ordering, one of them dies with 40P01, and when it
   * is the api's, a person approving a post gets a 500.
   */
  it("sweepStranded locks in id order, so it cannot deadlock against approve's ordered lock", async () => {
    const { itemId, adaptationIds } = await seedReversedHeapOrder("scheduled");
    const [low, high] = [...adaptationIds].sort() as [string, string];

    const approving = await pool.connect();
    let sweptOutcome: PromiseSettledResult<unknown>;
    let approveError: string | null = null;
    try {
      // The api's `approve`, mid-scan: it holds the first row of its ordered
      // walk and has not yet reached the second.
      await approving.query("BEGIN");
      await approving.query("SELECT id FROM adaptations WHERE id = $1 FOR UPDATE", [low]);

      const sweeping = repo.sweepStranded();
      // The sweeper is now parked on a row lock — on `high` before the
      // ordering, on `low` after it. Passing `sweeping` makes "the sweep
      // rejected instead of blocking" say so at this line, rather than time out
      // as if the lock were merely slow.
      await waitForLockWaiters("%make_interval%", 1, sweeping);

      // ...and approve walks on to the rest of its ordered set.
      approveError = await approving
        .query(
          `SELECT id FROM adaptations
            WHERE content_item_id = $1 AND status IN ('pending','failed','scheduled')
            ORDER BY id FOR UPDATE`,
          [itemId],
        )
        .then(
          () => null,
          (error: { code?: string }) => String(error.code),
        );
      await approving.query("COMMIT");
      [sweptOutcome] = await Promise.allSettled([sweeping]);
    } finally {
      await approving.query("ROLLBACK").catch(() => {});
      approving.release();
    }

    expect(approveError, "approve was the deadlock victim — a 500 for approving a post").toBeNull();
    expect(sweptOutcome.status, "the sweep was the deadlock victim").toBe("fulfilled");
    // Nothing more is asserted about `low`: `approve` held it throughout, so
    // the sweep's own re-check under the lock decides it. `high` was never
    // contended and is genuinely stranded.
    expect(await adaptationStatus(high)).toBe("failed");
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
      await waitForLockWaiters('insert into "publications"%', 2, landings);
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

  /**
   * THE FAILING ARM OF THE SAME `every`, which the test above does not reach.
   *
   * It pins `rows.every(published)` and nothing else, so `every` → `some` on
   * the NEXT line — `rows.every((r) => r.status === "failed")` — walks through
   * the whole suite untouched. Under it, one channel Telegram refused marks the
   * WHOLE item `failed` while its other channels are still sitting in the
   * queue, waiting to go out perfectly well.
   *
   * That is not a wrong word on a screen. `failed` is a terminal item status
   * the queue offers as re-approvable, so the reader is invited to approve an
   * item whose other deliveries are already on their way — and `approve`
   * targets `failed` adaptations, so the one that genuinely failed is
   * re-enqueued alongside them.
   *
   * The second half is the other direction, and it is what stops this test
   * being satisfied by deleting the arm: once the LAST channel fails, the item
   * does become `failed`.
   */
  it("a partial fan-out is not a failure: the item fails only when its last channel does", async () => {
    const { itemId, adaptationIds } = await seedFanOut(["queued", "queued"]);
    const [first, second] = adaptationIds as [string, string];

    expect(
      await repo.markFailed(orgId, first, "Telegram: chat not found", "platform_rejected", {
        status: "queued",
        attemptCount: 0,
      }),
    ).toBe(true);

    expect(await adaptationStatus(first)).toBe("failed");
    expect(await adaptationStatus(second)).toBe("queued");
    expect(await itemStatus(itemId)).toBe("approved");

    expect(
      await repo.markFailed(orgId, second, "Telegram: chat not found", "platform_rejected", {
        status: "queued",
        attemptCount: 0,
      }),
    ).toBe(true);

    expect(await itemStatus(itemId)).toBe("failed");
  });
  /**
   * THE THIRD VERDICT: both deliveries are over and they did not agree.
   *
   * Until this arm existed the recompute wrote NOTHING here — neither `every`
   * was satisfied — and the item kept `approve`'s `approved` for ever: the
   * colour of work in flight, filed under the queue's "Approved" heading,
   * beside one channel that is live and one that never will be. Nothing else
   * in the product recomputes an item, so "for ever" is literal.
   *
   * The second half is what stops the test being satisfied by an arm that
   * answers `partially_published` and stays there: the status is TERMINAL, not
   * final. A retry of the failed half lands through the same function and the
   * first arm promotes the item to `published`, with nothing here to undo.
   */
  it("a fan-out whose channels disagree leaves the item partly published — and a retry finishes it", async () => {
    const { itemId, adaptationIds } = await seedFanOut(["publishing", "queued"]);
    const [live, refused] = adaptationIds as [string, string];

    await repo.markPublished(orgId, live, {
      externalId: "1",
      externalUrl: "https://t.me/c/1",
    });
    expect(await itemStatus(itemId)).toBe("approved");

    expect(
      await repo.markFailed(orgId, refused, "Telegram: message is too long", "platform_rejected", {
        status: "queued",
        attemptCount: 0,
      }),
    ).toBe(true);

    expect(await adaptationStatus(live)).toBe("published");
    expect(await adaptationStatus(refused)).toBe("failed");
    expect(await itemStatus(itemId)).toBe("partially_published");

    // The person fixes the text and presses Publish now; this time the channel
    // takes it.
    await repo.markPublished(orgId, refused, {
      externalId: "2",
      externalUrl: "https://t.me/c/2",
    });
    expect(await itemStatus(itemId)).toBe("published");
  });

  /**
   * THE FOURTH CALLER, which the recompute's docstring used to leave out and
   * which reaches the new verdict in batches at 3am.
   *
   * `sweepAbandoned` loops the recompute over every row it swept, inside one
   * transaction — so an item with one live channel and one attempt that never
   * came back is promoted by the SWEEP, not by a delivery. Nothing about the
   * verdict is the sweep's own: it asks the same fold through the same
   * function, which is why this test is here rather than a second rule being
   * written for maintenance.
   */
  it("sweepAbandoned promotes a mixed fan-out to the same verdict a landing delivery would", async () => {
    const { itemId, adaptationIds } = await seedFanOut(["publishing", "publishing"]);
    const [live, abandoned] = adaptationIds as [string, string];

    await repo.markPublished(orgId, live, {
      externalId: "1",
      externalUrl: "https://t.me/c/1",
    });
    expect(await itemStatus(itemId)).toBe("approved");

    // Older than a whole attempt window plus its grace, with no pg-boss job
    // left that could still finish it.
    await db.execute(
      `UPDATE adaptations SET updated_at = now() - interval '1 day' WHERE id = '${abandoned}'`,
    );

    const swept = await repo.sweepAbandoned();

    expect(swept.map((row) => row.id)).toContain(abandoned);
    expect(await adaptationStatus(abandoned)).toBe("failed");
    expect(await itemStatus(itemId)).toBe("partially_published");
  });
});
