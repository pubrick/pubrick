import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

// Type-only: avoids importing anything under "./publish.repository" / "../queue.service"
// (both eventually import "../env", validated/connected eagerly at module load) before
// beforeAll() below has set DATABASE_URL/TELEGRAM_API_BASE_URL. Same reasoning as
// "./publish.repository.spec.ts" and "apps/api/src/queue/queue.service.spec.ts".
type PublishRepositoryCtor = typeof import("./publish.repository").PublishRepository;
type PublishServiceCtor = typeof import("./publish.service").PublishService;
type QueueServiceCtor = typeof import("../queue.service").QueueService;
type PgBossCtor = typeof import("pg-boss").PgBoss;
type PgBossInstance = InstanceType<PgBossCtor>;
type Schema = typeof import("@pubrick/db").schema;
type Db = Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
type Pool = Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];

type FakeTelegramResponse = { status: number; body: unknown };

/**
 * "Accept the request body, then kill the connection before replying" — a
 * socket reset AFTER the post has left this process. The counter below proves
 * the request arrived; the reset is what makes its outcome unknowable from
 * here. This is finding (a) reproduced with real sockets rather than a mocked
 * fetch.
 */
type FakeTelegramBehaviour = FakeTelegramResponse | "reset-after-request";

/**
 * The publish service's own unit tests mock PublishRepository entirely, so nothing
 * else drives a job through the REAL machinery: a real pg-boss queue created by
 * QueueService.registerAll(), a real PublishRepository hitting Postgres, and a real
 * (fake, but HTTP) Telegram on the other end of publisher.publish()'s fetch. Data is
 * seeded directly through the db, exactly like the api's own approve() would leave it
 * (org/brand/channel/content item/adaptation in "queued"), and the job is enqueued in
 * the same shape "{ adaptationId, orgId }" the api's QueueService.enqueuePublish sends.
 */
/**
 * This spec registers a LIVE consumer, so it must never share a queue with the
 * api's e2e suite: turbo runs both packages' `test` tasks concurrently against
 * the same TEST_DATABASE_URL, and a consumer on the real `publish` queue
 * happily fetches the jobs `content.e2e.spec.ts` enqueues there — publishing
 * them to this file's fake Telegram and mutating that suite's rows underneath
 * it. Own queue pair, own dead letter queue, no interference in either
 * direction.
 */
const TEST_PUBLISH_QUEUE = "publish-worker-e2e";
const TEST_PUBLISH_DLQ = "publish-worker-e2e-dlq";
const TEST_GENERATE_QUEUE = "generate-publish-e2e";
const TEST_GENERATE_DLQ = "generate-publish-e2e-dlq";

describe.skipIf(!url)("publish e2e (real DB + real pg-boss + fake Telegram)", () => {
  let db: Db;
  let pool: Pool;
  let workerPool: Pool;
  let schema: Schema;
  let eq: typeof import("drizzle-orm").eq;
  let boss: PgBossInstance;
  let server: http.Server;
  let orgId: string;
  let brandId: string;
  let service: InstanceType<PublishServiceCtor>;
  const fakeResponses = new Map<string, FakeTelegramResponse>();
  /** Per-chat script, consumed in order; falls back to `fakeResponses`. */
  const fakeScripts = new Map<string, FakeTelegramBehaviour[]>();
  /** sendMessage requests whose BODY the fake server actually received. */
  const sendCounts = new Map<string, number>();

  beforeAll(async () => {
    // Fake Telegram: a real HTTP server (not a mocked fetch) so the worker's own
    // network call — env.TELEGRAM_API_BASE_URL, set below — is genuinely exercised.
    // Keyed by chat_id so the two scenarios below (different channels, different
    // chat ids) can share one server instance for the whole describe block.
    server = http.createServer((req, res) => {
      if (req.method !== "POST" || !req.url?.endsWith("/sendMessage")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error_code: 404, description: "not found" }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let chatId = "";
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            chat_id?: unknown;
          };
          chatId = String(payload.chat_id);
        } catch {
          // Falls through to "no fake response configured" below.
        }
        sendCounts.set(chatId, (sendCounts.get(chatId) ?? 0) + 1);
        const behaviour = fakeScripts.get(chatId)?.shift() ??
          fakeResponses.get(chatId) ?? {
            status: 500,
            body: {
              ok: false,
              error_code: 500,
              description: `fake telegram: no response configured for chat ${chatId}`,
            },
          };
        if (behaviour === "reset-after-request") {
          req.socket.destroy();
          return;
        }
        res.writeHead(behaviour.status, { "content-type": "application/json" });
        res.end(JSON.stringify(behaviour.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    // Env BEFORE any dynamic import that reads env at module load. Migrations run once
    // for the whole suite in vitest.global-setup.ts (a single barrier), not here.
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${port}`;

    const dbModule = await import("@pubrick/db");
    schema = dbModule.schema;
    ({ db, pool } = dbModule.createDb(url as string));
    ({ eq } = await import("drizzle-orm"));

    const { PgBoss } = await import("pg-boss");
    boss = new (PgBoss as PgBossCtor)(url as string);
    boss.on("error", (err: Error) => console.error("pg-boss error (publish.e2e.spec)", err));
    await boss.start();

    // The real worker wiring: PublishRepository -> real Postgres, PublishService with
    // its DEFAULT publisher lookup (getPublisher, so "telegram" resolves to the real
    // telegramPublisher adapter) and its DEFAULT baseUrl (env.TELEGRAM_API_BASE_URL,
    // which now points at the fake server above), registered the same way main.ts does.
    const { PublishRepository } = (await import("./publish.repository")) as {
      PublishRepository: PublishRepositoryCtor;
    };
    const { PublishService } = (await import("./publish.service")) as {
      PublishService: PublishServiceCtor;
    };
    const queueModule = (await import("../queue.service")) as {
      QueueService: QueueServiceCtor;
    };
    const repo = new PublishRepository();
    // 0 backoff: the recording retries are budgeted in seconds by design (see
    // PUBLISH_RECORD_BUDGET_MS) and nothing here is testing that budget.
    service = new PublishService(repo, undefined, undefined, 0);
    // A no-op generate side: registerAll wires every queue the worker consumes,
    // and this file is about the publish path. Its generate consumer sits on the
    // private pair above, where nothing enqueues anything.
    const noGenerate = {
      handle: async () => {},
      markExhausted: async () => {},
    } as unknown as import("../generate/generate.service").GenerateService;
    const queueService = new queueModule.QueueService(service, noGenerate);
    await queueService.registerAll(boss, {
      publish: TEST_PUBLISH_QUEUE,
      publishDeadLetter: TEST_PUBLISH_DLQ,
      // This spec drives the publish path only, but registerAll registers every
      // queue the worker consumes — so its generate pair must be private too, or
      // this file's live consumer would eat the api suite's generation runs.
      generate: TEST_GENERATE_QUEUE,
      generateDeadLetter: TEST_GENERATE_DLQ,
    });

    // "../db" is the worker's own module-level pool (imported transitively by
    // PublishRepository above); grab a handle so afterAll can close it too.
    workerPool = ((await import("../db")) as { pool: Pool }).pool;

    orgId = `publish-e2e-org-${Date.now()}`;
    await db.insert(schema.organization).values({
      id: orgId,
      name: "Publish E2E Org",
      slug: `publish-e2e-${Date.now()}`,
      createdAt: new Date(),
    });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    brandId = brand?.id as string;
  }, 30_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 5_000 });
    await pool?.end();
    await workerPool?.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Rows seeded below are never cleaned up — safe by convention, same as the sibling
  // specs (publish.repository.spec.ts, queue.service.spec.ts): every run targets a
  // fresh, disposable database, never a long-lived shared one.
  async function seedQueuedAdaptation(
    chatId: string,
    itemStatus: "approved" | "rejected" = "approved",
  ): Promise<{ channelId: string; adaptationId: string }> {
    const { encryptJson } = await import("@pubrick/shared");
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "telegram",
        name: "Chan",
        credentialsEncrypted: encryptJson(
          { botToken: "123:abc", chatId },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      })
      .returning({ id: schema.channels.id });
    const channelId = channel?.id as string;

    const [item] = await db
      .insert(schema.contentItems)
      .values({ orgId, brandId, body: "Hello from the publish e2e test", status: itemStatus })
      .returning({ id: schema.contentItems.id });
    const itemId = item?.id as string;

    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({ orgId, contentItemId: itemId, channelId, status: "queued" })
      .returning({ id: schema.adaptations.id });
    return { channelId, adaptationId: adaptation?.id as string };
  }

  /** Hard 20s timeout: a hang here must fail loudly, never block the suite. */
  async function waitUntilLeftQueued(
    adaptationId: string,
  ): Promise<typeof schema.adaptations.$inferSelect> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      if (row && row.status !== "queued" && row.status !== "publishing") return row;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `Timed out after 20s waiting for adaptation ${adaptationId} to leave queued/publishing`,
    );
  }

  async function publicationFor(adaptationId: string) {
    const [row] = await db
      .select()
      .from(schema.publications)
      .where(eq(schema.publications.adaptationId, adaptationId));
    return row;
  }

  /**
   * Asserts the pg-boss JOB's own terminal state, not just the adaptation row.
   * markFailed's write and a rethrow that schedules a pg-boss retry can both
   * happen before the row is ever read as "failed" — the retry itself lands
   * ~30s+ later (retryDelay 30, backoff on), far past any reasonable row-poll
   * deadline, so a row-only assertion can NEVER observe whether a retry was
   * scheduled. The job's `state` flips out of "created"/"active" into either
   * "completed" or "retry" the instant pg-boss's work() wrapper sees the
   * handler's promise settle — no need to wait out the retry delay itself.
   * Hard 20s timeout: a hang here must fail loudly, never block the suite.
   */
  async function waitForJobState(jobId: string) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const job = await boss.getJobById(TEST_PUBLISH_QUEUE, jobId);
      if (job && job.state !== "created" && job.state !== "active") return job;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out after 20s waiting for job ${jobId} to leave created/active`);
  }

  it("publishes a queued adaptation and stores the message link", async () => {
    const chatId = `-100${Date.now()}1`;
    fakeResponses.set(chatId, {
      status: 200,
      body: {
        ok: true,
        result: { message_id: 4711, chat: { id: Number(chatId), username: "mychannel" } },
      },
    });
    const { adaptationId } = await seedQueuedAdaptation(chatId);

    // Same job shape the api's QueueService.enqueuePublish sends.
    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");

    const adaptation = await waitUntilLeftQueued(adaptationId);
    expect(adaptation.status).toBe("published");

    const publication = await publicationFor(adaptationId);
    expect(publication).toMatchObject({ status: "published", externalId: "4711" });
    expect(publication?.externalUrl).toBe("https://t.me/mychannel/4711");

    // A delivered post whose pg-boss job ended up in "retry" instead of
    // "completed" would resend on the next delivery — exactly the
    // duplicate-post scenario recordPublished/handle() are hardened
    // against. Assert the job itself, not just the row.
    const job = await waitForJobState(jobId);
    expect(job.state).toBe("completed");
  }, 25_000);

  it("never delivers a job whose content item was rejected", async () => {
    // The api cancels the pg-boss job when an approved item is rejected, but a
    // job that was already fetched (or one that outlived the cancel) reaches
    // this handler anyway. The fake Telegram below is deliberately configured
    // to ACCEPT the post: if the worker sent it, the adaptation would go
    // "published" and a publications row would appear. Both must stay absent.
    const chatId = `-100${Date.now()}3`;
    fakeResponses.set(chatId, {
      status: 200,
      body: {
        ok: true,
        result: { message_id: 999, chat: { id: Number(chatId), username: "rejectedchannel" } },
      },
    });
    const { adaptationId } = await seedQueuedAdaptation(chatId, "rejected");

    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");

    // The job itself must COMPLETE (nothing to retry — the user said no), so
    // wait on the job rather than on a row change that will never come.
    const job = await waitForJobState(jobId);
    expect(job.state).toBe("completed");

    const [adaptation] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(adaptation?.status).toBe("queued"); // untouched: never claimed, never failed
    expect(adaptation?.attemptCount).toBe(0);
    expect(await publicationFor(adaptationId)).toBeUndefined();
  }, 25_000);

  it("marks a permanently rejected post failed without retrying", async () => {
    const chatId = `-100${Date.now()}2`;
    fakeResponses.set(chatId, {
      status: 403,
      body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
    });
    const { adaptationId } = await seedQueuedAdaptation(chatId);

    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");

    const adaptation = await waitUntilLeftQueued(adaptationId);
    expect(adaptation.status).toBe("failed");
    // markPublishing bumped attempt_count to 1 before the send; the 403 is
    // permanent, so PublishService returns normally instead of throwing, and
    // pg-boss never retries the job — attempt_count must stay at exactly 1.
    expect(adaptation.attemptCount).toBe(1);

    // The row alone can't prove "no retry happened": it only shows what
    // markFailed wrote, and pg-boss's retry (if handle() had rethrown after
    // safeMarkFailed) lands ~30s+ later — far past this test's poll window.
    // Assert the JOB's own terminal state directly instead: "completed"
    // (handle() returned normally) never "retry" (handle() rethrew).
    const job = await waitForJobState(jobId);
    expect(job.state).toBe("completed");
  }, 25_000);

  /**
   * FINDING (a), end to end. The stub takes the whole request body — the
   * counter it bumps is the proof the post was EXECUTED — and then destroys
   * the socket instead of replying. Node's fetch rejects with
   * `UND_ERR_SOCKET`, which is not a connect-phase failure, so nothing here
   * can say whether a message is now sitting in the channel.
   *
   * Before the fix this was a `TransientPublishError`: the handler rethrew, the
   * pg-boss job went to "retry", and the redelivery sent a SECOND message that
   * the second stub call happily accepted — two posts, one `published` row,
   * `attempt_count` 2, `last_error` null, and nothing anywhere recording that
   * the channel had two copies. (Measured on the pre-fix code by driving
   * handle() twice: sends=2, publications=1/published.)
   *
   * The job must now COMPLETE, not retry. That is the assertion that makes the
   * second send impossible rather than merely unlikely: a completed job is
   * never redelivered.
   */
  it("does not retry — and so cannot post twice — when the reply is lost after the send", async () => {
    const chatId = `-100${Date.now()}4`;
    // A second call would be answered with a perfectly good success. If the
    // handler ever sends again, this test sees two sends and a published row.
    fakeScripts.set(chatId, ["reset-after-request"]);
    fakeResponses.set(chatId, {
      status: 200,
      body: {
        ok: true,
        result: { message_id: 8080, chat: { id: Number(chatId), username: "lostreply" } },
      },
    });
    const { adaptationId } = await seedQueuedAdaptation(chatId);

    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");

    const job = await waitForJobState(jobId);
    expect(job.state).toBe("completed");
    expect(sendCounts.get(chatId)).toBe(1);

    const publication = await publicationFor(adaptationId);
    // Not "published" (it might not be) and not "failed" (it might be) — the
    // record now holds the thing that is actually true.
    expect(publication?.status).toBe("unknown");

    const [adaptation] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(adaptation?.status).toBe("failed");
    expect(adaptation?.lastError).toContain("check the channel before re-approving");

    // Driving the handler again by hand — the redelivery pg-boss is no longer
    // going to make — still sends nothing.
    await service.handle({ adaptationId, orgId });
    expect(sendCounts.get(chatId)).toBe(1);
  }, 25_000);

  /**
   * The mechanism findings (b) and (c) share, executed rather than argued.
   *
   * Both end the same way: an attempt takes the claim, calls the platform, and
   * then stops running before it can resolve the claim — (b) because the
   * database is unreachable for longer than the heartbeat window and the
   * supervisor fails the job, (c) because a graceful stop's `failWip()` fails
   * it. Either way pg-boss redelivers, and the redelivery is what used to post
   * a second time: `hasPublished` found nothing, `markPublishing` re-claimed
   * from `publishing`, and the send went out again.
   *
   * What is executed here is exactly the state such a dead attempt leaves —
   * `publishing` with an unresolved `in_flight` claim — followed by a REAL
   * redelivery through the real queue. What is not executed is the dying: this
   * process cannot be its own killed pod, and pg-boss's internal `complete()`
   * failure and `failWip()` are not reachable from a test.
   */
  it("refuses to send when a redelivered job finds a claim its predecessor never resolved", async () => {
    const chatId = `-100${Date.now()}5`;
    // Configured to ACCEPT: if the handler sends, the post goes through and
    // this test sees it.
    fakeResponses.set(chatId, {
      status: 200,
      body: {
        ok: true,
        result: { message_id: 9090, chat: { id: Number(chatId), username: "interrupted" } },
      },
    });
    const { adaptationId } = await seedQueuedAdaptation(chatId);

    // The state a killed attempt leaves behind, written through the real
    // repository: the attempt claimed, sent, and never came back.
    const { PublishRepository } = (await import("./publish.repository")) as {
      PublishRepository: PublishRepositoryCtor;
    };
    const repo = new PublishRepository();
    expect(await repo.markPublishing(orgId, adaptationId)).toBe(true);
    expect(await repo.claimSend(orgId, adaptationId)).toBe(true);

    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");

    const job = await waitForJobState(jobId);
    expect(job.state).toBe("completed");
    expect(sendCounts.get(chatId) ?? 0).toBe(0);

    const publication = await publicationFor(adaptationId);
    expect(publication?.status).toBe("unknown");
    const [adaptation] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(adaptation?.status).toBe("failed");
    expect(adaptation?.lastError).toContain("check the channel before re-approving");
  }, 25_000);
});
