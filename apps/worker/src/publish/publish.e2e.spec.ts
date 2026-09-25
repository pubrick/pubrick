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
  let sql: typeof import("drizzle-orm").sql;
  let repo: InstanceType<PublishRepositoryCtor>;
  let boss: PgBossInstance;
  let server: http.Server;
  let orgId: string;
  let brandId: string;
  /**
   * The bound the worker was actually configured with, read from the real env
   * module so the numbers below track it rather than restating a default. Taken
   * in `beforeAll` like every other module here, because `../env` is evaluated
   * at import time and this file sets `DATABASE_URL` before it imports anything.
   */
  let boundHours: number;
  let service: InstanceType<PublishServiceCtor>;
  const fakeResponses = new Map<string, FakeTelegramResponse>();
  /** Per-chat script, consumed in order; falls back to `fakeResponses`. */
  const fakeScripts = new Map<string, FakeTelegramBehaviour[]>();
  /** sendMessage requests whose BODY the fake server actually received. */
  const sendCounts = new Map<string, number>();
  const sentTexts = new Map<string, string>();
  const vkRequests: URLSearchParams[] = [];
  const maxRequests: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];

  beforeAll(async () => {
    // Fake Telegram: a real HTTP server (not a mocked fetch) so the worker's own
    // network call — env.TELEGRAM_API_BASE_URL, set below — is genuinely exercised.
    // Keyed by chat_id so the two scenarios below (different channels, different
    // chat ids) can share one server instance for the whole describe block.
    server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/messages?chat_id=")) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          maxRequests.push({
            url: req.url ?? "",
            authorization: req.headers.authorization,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ message: { body: { mid: "max_88" }, url: "https://max.ru/c/88" } }),
          );
        });
        return;
      }
      if (req.method === "POST" && req.url === "/method/wall.post") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          vkRequests.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ response: { post_id: 88 } }));
        });
        return;
      }
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
            text?: unknown;
          };
          chatId = String(payload.chat_id);
          if (typeof payload.text === "string") sentTexts.set(chatId, payload.text);
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
    process.env.VK_API_BASE_URL = `http://127.0.0.1:${port}/method`;
    process.env.MAX_API_BASE_URL = `http://127.0.0.1:${port}`;

    const dbModule = await import("@pubrick/db");
    schema = dbModule.schema;
    ({ db, pool } = dbModule.createDb(url as string));
    ({ eq, sql } = await import("drizzle-orm"));

    boundHours = (await import("../env")).env.PUBLISH_MAX_LATENESS_HOURS;

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
      publishSweepQueueOf: (publishQueue: string) => string;
      sweepQueueOf: (generateQueue: string) => string;
    };
    repo = new PublishRepository();
    // 0 backoff: the recording retries are budgeted in seconds by design (see
    // PUBLISH_RECORD_BUDGET_MS) and nothing here is testing that budget.
    service = new PublishService(repo, undefined, undefined, 0);
    // A no-op generate side: registerAll wires every queue the worker consumes,
    // and this file is about the publish path. Its generate consumer sits on the
    // private pair above, where nothing enqueues anything.
    const noGenerate = {
      handle: async () => {},
      markExhausted: async () => {},
      sweepAbandoned: async () => {},
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
    // registerAll also puts both sweeps on a cron. Unscheduled here so nothing
    // sweeps behind this file's back: the sweep tests below drive
    // `sweepAbandoned` directly, and an unattended tick landing between a
    // fixture's write and its assertion would make them flaky in one direction
    // (a row swept early) and blind in the other. Same reasoning, same move, as
    // generate.e2e.spec.ts.
    await boss.unschedule(queueModule.publishSweepQueueOf(TEST_PUBLISH_QUEUE));
    await boss.unschedule(queueModule.sweepQueueOf(TEST_GENERATE_QUEUE));

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
    /**
     * The key the channel's credentials are encrypted under. Defaults to the
     * worker's own; a different value is what a rotated `APP_ENCRYPTION_KEY`
     * leaves behind, and the only way to drive this path with a blob that
     * genuinely will not open.
     */
    credentialKey: string = process.env.APP_ENCRYPTION_KEY as string,
  ): Promise<{ channelId: string; adaptationId: string }> {
    const { encryptJson } = await import("@pubrick/shared");
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "telegram",
        name: "Chan",
        credentialsEncrypted: encryptJson({ botToken: "123:abc", chatId }, credentialKey),
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

  it("publishes a VK community post through the real registry and records its wall link", async () => {
    const { encryptJson } = await import("@pubrick/shared");
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "vk",
        name: "VK community",
        credentialsEncrypted: encryptJson(
          { accessToken: "vk-e2e-token", groupId: "12345" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      })
      .returning({ id: schema.channels.id });
    const [item] = await db
      .insert(schema.contentItems)
      .values({ orgId, brandId, body: "Hello from VK", status: "approved" })
      .returning({ id: schema.contentItems.id });
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId,
        contentItemId: item?.id as string,
        channelId: channel?.id as string,
        status: "queued",
      })
      .returning({ id: schema.adaptations.id });
    const adaptationId = adaptation?.id as string;
    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null");

    expect((await waitUntilLeftQueued(adaptationId)).status).toBe("published");
    expect(await publicationFor(adaptationId)).toMatchObject({
      status: "published",
      externalId: "88",
      externalUrl: "https://vk.com/wall-12345_88",
    });
    expect((await waitForJobState(jobId)).state).toBe("completed");
    expect(vkRequests).toHaveLength(1);
    expect(vkRequests[0]?.get("owner_id")).toBe("-12345");
    expect(vkRequests[0]?.get("message")).toBe("Hello from VK");
  }, 25_000);

  it("publishes to MAX through the real registry and records its post link", async () => {
    const { encryptJson } = await import("@pubrick/shared");
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "max",
        name: "MAX channel",
        credentialsEncrypted: encryptJson(
          { accessToken: "max-e2e-token", chatId: "-12345" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      })
      .returning({ id: schema.channels.id });
    const [item] = await db
      .insert(schema.contentItems)
      .values({ orgId, brandId, body: "Hello from MAX", status: "approved" })
      .returning({ id: schema.contentItems.id });
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId,
        contentItemId: item?.id as string,
        channelId: channel?.id as string,
        status: "queued",
      })
      .returning({ id: schema.adaptations.id });
    const adaptationId = adaptation?.id as string;
    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null");

    expect((await waitUntilLeftQueued(adaptationId)).status).toBe("published");
    expect(await publicationFor(adaptationId)).toMatchObject({
      status: "published",
      externalId: "max_88",
      externalUrl: "https://max.ru/c/88",
    });
    expect((await waitForJobState(jobId)).state).toBe("completed");
    expect(maxRequests).toHaveLength(1);
    expect(maxRequests[0]?.url).toContain("chat_id=-12345");
    expect(maxRequests[0]?.authorization).toBe("max-e2e-token");
    expect(maxRequests[0]?.body).toEqual({ text: "Hello from MAX" });
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
    // The PLATFORM's own envelope said no, and the code says that and only
    // that. Its sibling below is the refusal the platform never made.
    expect(adaptation.failureReason).toBe("platform_rejected");
  }, 25_000);

  /**
   * A REFUSAL THE PLATFORM NEVER MADE, THROUGH THE REAL DATABASE.
   *
   * The adapter's own text-length guard throws before any fetch, so nothing
   * reaches Telegram and the sentence on the screen must not say Telegram
   * refused. Driven end to end rather than against a stub because the other
   * half of the claim is the `adaptations_failure_reason_check` constraint: a
   * reason the type system knows and the CHECK does not is a terminal write the
   * database refuses, leaving the row stuck in `publishing` with the post
   * neither sent nor failed.
   */
  it("records the adapter's own refusal as one the platform never made", async () => {
    const chatId = `-100${Date.now()}7`;
    fakeResponses.set(chatId, {
      status: 200,
      body: { ok: true, result: { message_id: 1, chat: { id: Number(chatId) } } },
    });
    const { adaptationId } = await seedQueuedAdaptation(chatId);
    // Past telegram's own 4096 limit: the guard is in the adapter, above fetch.
    await db
      .update(schema.adaptations)
      .set({ body: "x".repeat(5000) })
      .where(eq(schema.adaptations.id, adaptationId));

    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");

    const adaptation = await waitUntilLeftQueued(adaptationId);
    expect(adaptation.status).toBe("failed");
    expect(adaptation.failureReason).toBe("rejected_before_send");
    // Nothing left this process: the guard runs before the request is built.
    expect(sendCounts.get(chatId)).toBeUndefined();
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
  it("fails a post whose stored credentials will not decrypt with one answer, not the crypto library's", async () => {
    /**
     * The third of the four places one event used to be answered four ways.
     * `last_error` is printed verbatim on the content screens, so this line used
     * to put node's own "Unsupported state or unable to authenticate data" in
     * front of a reader — for the same event the AI credential Test answers with
     * a named verdict and the generate pipeline answers with a code.
     *
     * Driven with real ciphertext under a key this worker does not have, not by
     * stubbing the repository: the assertion is about what the whole path
     * produces, and a stub could agree with a helper that the path never
     * reaches.
     */
    const { UNREADABLE_CREDENTIALS_MESSAGE } = await import("@pubrick/shared");
    const foreignKey = Buffer.from(new Uint8Array(32).fill(11)).toString("base64");
    const chatId = `-100${Date.now()}9`;
    fakeResponses.set(chatId, {
      status: 200,
      body: { ok: true, result: { message_id: 1, chat: { id: Number(chatId) } } },
    });
    const { adaptationId } = await seedQueuedAdaptation(chatId, "approved", foreignKey);

    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");

    // Permanent, so the job completes rather than retrying a decrypt that will
    // fail identically every time.
    const job = await waitForJobState(jobId);
    expect(job.state).toBe("completed");
    // Nothing reached the platform: the credentials are read before the send.
    expect(sendCounts.get(chatId)).toBeUndefined();

    const row = await waitUntilLeftQueued(adaptationId);
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe(UNREADABLE_CREDENTIALS_MESSAGE);
    expect(row.lastError).not.toMatch(/unable to authenticate data/i);
    expect(row.lastError).not.toMatch(/Could not load credentials/);
    // The receipt says failed, not `unknown`: the credentials are read before
    // anything leaves this process, so there is no doubt about whether a post is
    // live in someone's channel.
    const publication = await publicationFor(adaptationId);
    expect(publication?.status).toBe("failed");
    expect(publication?.externalId).toBeNull();
  }, 25_000);

  /**
   * `credentials_missing` IS DEFENSIVE, AND THIS IS WHY NO SCREEN CAN SHOW IT.
   *
   * The reason says "the channel this post was for is no longer connected" and
   * the sentence tells the reader to add it again. It is now written on exactly
   * one path — `ChannelNotFoundError` out of `repo.credentials()` — and that
   * path cannot leave a row behind for anybody to read: `adaptations.channel_id`
   * is `ON DELETE CASCADE` and channels are hard-deleted, so the delete that
   * makes the channel missing takes the adaptation with it. The code stays
   * because a worker must still name what it hit; the SENTENCE is unreachable,
   * and that is a property of the schema, not of a comment.
   *
   * Asserted here rather than reasoned about in prose: if a future change makes
   * the adaptation survive its channel (a soft delete, `SET NULL`), this goes
   * red and the sentence has to be reconsidered before a reader is told to
   * re-add a channel they never lost.
   */
  it("cannot leave a row captioned 'the channel is gone': deleting the channel deletes the adaptation", async () => {
    const chatId = `-100${Date.now()}8`;
    const { channelId, adaptationId } = await seedQueuedAdaptation(chatId);

    await db.delete(schema.channels).where(eq(schema.channels.id, channelId));

    const rows = await db
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(rows).toEqual([]);
  });

  it("sends the saved hashtag body without adding the editorial CTA", async () => {
    const chatId = `-100${Date.now()}91`;
    fakeResponses.set(chatId, {
      status: 200,
      body: { ok: true, result: { message_id: 4712, chat: { id: Number(chatId) } } },
    });
    const { adaptationId } = await seedQueuedAdaptation(chatId);
    const canonical = "A reviewed channel post.\n\n#news #launch";
    await db
      .update(schema.adaptations)
      .set({ body: canonical, hashtags: ["news", "launch"], cta: "Ask a question" })
      .where(eq(schema.adaptations.id, adaptationId));

    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");
    expect((await waitUntilLeftQueued(adaptationId)).status).toBe("published");
    expect(sentTexts.get(chatId)).toBe(canonical);
    expect(sentTexts.get(chatId)).not.toContain("Ask a question");
  }, 25_000);

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
    expect(await repo.markPublishing(orgId, adaptationId, null)).toBe(1);
    expect(await repo.claimSend(orgId, adaptationId)).not.toBeNull();

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

  /**
   * FINDING 1, executed: a re-approval that lands between the dead-letter
   * handler's read and its write.
   *
   * `markExhausted` read `publishing` through `load()` and then called a write
   * whose UPDATE was unconditional. Reject and re-approve committing in that
   * gap left the freshly re-approved adaptation `failed` with "Retries
   * exhausted" and its count bumped a second time; the job the re-approve had
   * just enqueued then loaded a `failed` row, `markPublishing` refused the
   * claim, and the handler completed having sent nothing.
   *
   * MEASURED ON THE PRE-FIX CODE by running exactly this test against it: the
   * adaptation ended `failed` / attempt_count 3 / lastError "Retries
   * exhausted", the job went to `completed`, and the fake Telegram received
   * ZERO posts. No exception, no failed job, no post — the user's decision
   * simply gone. After the fix: `queued` / attempt_count 2 / lastError null,
   * and ONE post.
   *
   * The read is gated rather than raced, because a race that reproduces once in
   * a thousand runs is not a test. Everything else is real: the real
   * repository, the real service, the real queue, the real socket.
   */
  it("does not lose a re-approval that lands between the dead-letter read and its write", async () => {
    const chatId = `-100${Date.now()}6`;
    fakeResponses.set(chatId, {
      status: 200,
      body: {
        ok: true,
        result: { message_id: 6161, chat: { id: Number(chatId), username: "reapproved" } },
      },
    });
    const { adaptationId } = await seedQueuedAdaptation(chatId);

    // The attempt whose retries ran out: every one of them transient, so the
    // row is `publishing` and the dead-letter copy is on its way.
    expect(await repo.markPublishing(orgId, adaptationId, null)).toBe(1);

    const { PublishRepository } = (await import("./publish.repository")) as {
      PublishRepository: PublishRepositoryCtor;
    };
    const { PublishService } = (await import("./publish.service")) as {
      PublishService: PublishServiceCtor;
    };
    const gated = new PublishRepository();
    let readHappened = (): void => {};
    const hasRead = new Promise<void>((resolve) => {
      readHappened = resolve;
    });
    let releaseRead = (): void => {};
    const mayWrite = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const realLoad = gated.load.bind(gated);
    gated.load = async (loadOrgId, loadAdaptationId) => {
      const row = await realLoad(loadOrgId, loadAdaptationId);
      readHappened();
      await mayWrite;
      return row;
    };
    const deadLetter = new PublishService(gated, undefined, undefined, 0);

    const exhausting = deadLetter.markExhausted({ adaptationId, orgId });
    await hasRead;

    // The api's reject(), then its approve(): `pending` with the count bumped
    // and `last_error` cleared, then `queued` again with a fresh job to come.
    await db
      .update(schema.adaptations)
      .set({ status: "pending", attemptCount: 2, lastError: null })
      .where(eq(schema.adaptations.id, adaptationId));
    await db
      .update(schema.adaptations)
      .set({ status: "queued", lastError: null })
      .where(eq(schema.adaptations.id, adaptationId));

    releaseRead();
    await exhausting;

    // The user's decision, still standing. This is what the bug erased.
    const [afterExhaust] = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.id, adaptationId));
    expect(afterExhaust).toMatchObject({ status: "queued", attemptCount: 2, lastError: null });
    // And no corpse in the delivery log to confuse the screen either.
    expect(await publicationFor(adaptationId)).toBeUndefined();

    // And the post the re-approval was FOR actually goes out.
    const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
    if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");
    const adaptation = await waitUntilLeftQueued(adaptationId);
    expect(adaptation.status).toBe("published");
    expect(sendCounts.get(chatId)).toBe(1);
    expect((await waitForJobState(jobId)).state).toBe("completed");
  }, 25_000);

  /**
   * THE 26-HOUR OUTAGE, end to end — the failure this whole increment exists
   * for, through the real queue, the real repository and the real adapter.
   *
   * Approve Monday 17:00 for Tuesday 09:00; the worker dies Tuesday 08:00 and
   * comes back Wednesday 10:00. NOTHING expires a waiting pg-boss job in
   * between — `expireInSeconds` bounds a handler that has STARTED, and the only
   * other clock deletes the job after fourteen days — so the job is simply
   * fetched a day late and, before this, the post went out 25 hours late and
   * `published`, indistinguishable from on time.
   *
   * The row is inserted with its slot ALREADY IN THE PAST, directly, because
   * `approve` refuses a past time. That is what a real outage produces (the
   * clock moved, not the row), and it means no test here exercises approve →
   * `startAfter` → a job becoming due. Stated rather than hidden.
   */
  describe("a slot that came and went", () => {
    /**
     * A `scheduled` adaptation whose slot passed `hoursAgo` ago, with a live
     * pg-boss job for it — the shape a worker finds when it wakes up.
     *
     * The backdating is written straight onto `scheduled_at` with Postgres's own
     * `now()`: the comparison under test belongs to the database, so a test that
     * supplied a JavaScript `Date` would be measuring the two clocks this code
     * exists to keep apart.
     */
    async function scheduledInThePast(chatId: string, hoursAgo: number) {
      const { adaptationId, channelId } = await seedQueuedAdaptation(chatId);
      await db
        .update(schema.adaptations)
        .set({
          status: "scheduled",
          scheduledAt: sql`now() - make_interval(hours => ${hoursAgo})`,
        })
        .where(eq(schema.adaptations.id, adaptationId));
      return { adaptationId, channelId };
    }

    /** Hard 20s timeout: a hang here must fail loudly, never block the suite. */
    async function waitForTerminal(adaptationId: string) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const [row] = await db
          .select()
          .from(schema.adaptations)
          .where(eq(schema.adaptations.id, adaptationId));
        if (row && (row.status === "failed" || row.status === "published")) return row;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`Timed out after 20s waiting for adaptation ${adaptationId} to end`);
    }

    it("fails a post the outage made a day late, sends nothing, and completes the job", async () => {
      const chatId = `-100${Date.now()}20`;
      // Configured to ACCEPT: if the handler sends, the post goes through and
      // this test sees it.
      fakeResponses.set(chatId, {
        status: 200,
        body: { ok: true, result: { message_id: 2601, chat: { id: Number(chatId) } } },
      });
      const { adaptationId } = await scheduledInThePast(chatId, boundHours + 20);

      const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
      if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");

      const row = await waitForTerminal(adaptationId);
      expect(row.status).toBe("failed");
      expect(row.failureReason).toBe("schedule_missed");
      expect(row.lastError).toContain("Missed its scheduled slot");
      // The hours, frozen into the sentence at refusal — within a window,
      // because the seed and the read are separate statements.
      const hours = Number(/(\d+\.\d) h later/.exec(row.lastError ?? "")?.[1]);
      expect(hours).toBeGreaterThanOrEqual(boundHours + 19.9);
      expect(hours).toBeLessThanOrEqual(boundHours + 20.1);

      // NOTHING reached the platform.
      expect(sendCounts.get(chatId)).toBeUndefined();
      // The claim this attempt took became the `failed` receipt — not left
      // `in_flight` (which would block every future attempt for ever), and not
      // deleted (which would leave the delivery log silent about a refusal).
      const publication = await publicationFor(adaptationId);
      expect(publication?.status).toBe("failed");
      expect(publication?.externalId).toBeNull();
      // And the handler RETURNED: a rethrow here would have pg-boss retry a job
      // that can only ever reach this same line again.
      expect((await waitForJobState(jobId)).state).toBe("completed");
    }, 25_000);

    it("publishes a post that is late by less than the bound", async () => {
      const chatId = `-100${Date.now()}21`;
      fakeResponses.set(chatId, {
        status: 200,
        body: {
          ok: true,
          result: { message_id: 2602, chat: { id: Number(chatId), username: "stillfine" } },
        },
      });
      // A sixth of the bound — an hour at the default, and still an hour at any
      // other configured value, which is what keeps this test honest about the
      // BOUND rather than about the number six.
      const { adaptationId } = await scheduledInThePast(chatId, boundHours / 6);

      const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
      if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");

      const row = await waitForTerminal(adaptationId);
      expect(row.status).toBe("published");
      expect(row.failureReason).toBeNull();
      expect(sendCounts.get(chatId)).toBe(1);
      expect((await waitForJobState(jobId)).state).toBe("completed");
    }, 25_000);

    /**
     * THE OTHER SIDE: a human moved the slot FORWARD while the old job was
     * already active. Driven by hand rather than through the queue, because the
     * whole assertion is that this delivery is left EXACTLY as the person set
     * it — there is no state change to wait for.
     */
    it("touches nothing when the slot has been moved into the future", async () => {
      const chatId = `-100${Date.now()}22`;
      fakeResponses.set(chatId, {
        status: 200,
        body: { ok: true, result: { message_id: 2603, chat: { id: Number(chatId) } } },
      });
      const { adaptationId } = await scheduledInThePast(chatId, boundHours + 20);
      // The re-approve: a new time, in the future, and the count the api bumps.
      await db
        .update(schema.adaptations)
        .set({
          scheduledAt: sql`now() + interval '3 hours'`,
          attemptCount: 1,
          lastError: null,
          failureReason: null,
        })
        .where(eq(schema.adaptations.id, adaptationId));

      await expect(service.handle({ adaptationId, orgId })).resolves.toBeUndefined();

      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      // Still the person's row: their status, their count, no verdict of ours.
      expect(row).toMatchObject({ status: "scheduled", attemptCount: 1, failureReason: null });
      expect(sendCounts.get(chatId)).toBeUndefined();
      // AND NO CLAIM LEFT BEHIND. This is the half a "return without failing"
      // placed after `claimSend` would get wrong: the job for the new slot would
      // be refused the claim and would report an unknown outcome about a post
      // nobody ever sent.
      expect(await publicationFor(adaptationId)).toBeUndefined();
    }, 25_000);

    /**
     * THE RE-SEND THE SCREEN OFFERS, and the loop it must not become.
     *
     * "Publish now" writes `scheduled_at = null`. If it wrote the slot
     * conditionally instead, the re-approved row would carry the SAME overdue
     * slot, the worker would find itself past the bound again, and the post
     * could never be sent by any route. The api's own e2e kills that mutation
     * on `approve`; this is the worker half — a row re-approved the way
     * `approve` leaves it does go out.
     */
    it("sends a missed post when it is re-approved for now", async () => {
      const chatId = `-100${Date.now()}23`;
      fakeResponses.set(chatId, {
        status: 200,
        body: {
          ok: true,
          result: { message_id: 2604, chat: { id: Number(chatId), username: "resent" } },
        },
      });
      const { adaptationId } = await scheduledInThePast(chatId, boundHours + 20);
      await service.handle({ adaptationId, orgId });
      expect(await waitForTerminal(adaptationId)).toMatchObject({
        status: "failed",
        failureReason: "schedule_missed",
      });

      // Exactly what `approve(orgId, id, null)` leaves behind.
      await db
        .update(schema.adaptations)
        .set({
          status: "queued",
          scheduledAt: null,
          lastError: null,
          failureReason: null,
          attemptCount: 1,
        })
        .where(eq(schema.adaptations.id, adaptationId));

      const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
      if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");
      const row = await waitForTerminal(adaptationId);
      expect(row.status).toBe("published");
      expect(row.failureReason).toBeNull();
      expect(sendCounts.get(chatId)).toBe(1);
    }, 25_000);

    /**
     * THE REASON CONTRACT, over a row that fails twice for different causes.
     *
     * A nullable column written by one branch and cleared by none is a stale
     * flag: a later credentials failure would leave `schedule_missed` standing
     * beside a decryption sentence, and the screen would caption it "Missed its
     * slot". Both failures here go through the REAL path, so what is asserted is
     * what the product writes rather than what a helper agrees to.
     */
    it("moves the reason to the failure that actually happened", async () => {
      const chatId = `-100${Date.now()}24`;
      fakeResponses.set(chatId, {
        status: 403,
        body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
      });
      const { adaptationId } = await scheduledInThePast(chatId, boundHours + 20);

      await service.handle({ adaptationId, orgId });
      expect(await waitForTerminal(adaptationId)).toMatchObject({
        failureReason: "schedule_missed",
      });
      expect(sendCounts.get(chatId)).toBeUndefined();

      // Re-approved for now — and this time the platform is the one that says no.
      await db
        .update(schema.adaptations)
        .set({
          status: "queued",
          scheduledAt: null,
          lastError: null,
          failureReason: null,
          attemptCount: 1,
        })
        .where(eq(schema.adaptations.id, adaptationId));

      await service.handle({ adaptationId, orgId });
      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      expect(row?.status).toBe("failed");
      expect(row?.failureReason).toBe("platform_rejected");
      expect(row?.lastError).toContain("Forbidden");
      expect(sendCounts.get(chatId)).toBe(1);
    }, 25_000);
  });

  /**
   * FINDING 2: the publish queue's copy of the stuck-forever hole the generate
   * sweep closed, and the one place the two sweeps must NOT behave alike.
   *
   * The mechanism is identical and lives in `packages/shared/src/jobs.ts`: a
   * heartbeat re-dispatch hands handler B a job id handler A still holds, A
   * returns into pg-boss's wrapper, the wrapper's `complete()` lands on B's
   * live incarnation, and from then on nothing can retry or dead-letter it. The
   * adaptation stays `publishing` — a status `approve` deliberately does not
   * target, so not even a re-approve can move it.
   *
   * What differs is the VERDICT. A generation run that was abandoned delivered
   * nothing to anybody. A publish attempt may have put a post in a channel, and
   * nothing here can ask. The `in_flight` claim is the evidence, and it is what
   * these tests are about: with one, the sweep says "unknown, go look"; without
   * one, it says "nothing was delivered".
   *
   * Nothing here is faked except the passage of time: the rows are written
   * through the real repository, the jobs are real pg-boss jobs in real states,
   * and the sweep is the production statement.
   */
  describe("abandoned-publish sweep", () => {
    /**
     * A queue with no registered consumer, so this block can park a job in a
     * chosen state instead of having the live consumer eat it. `retryDelay: 0`
     * and no backoff are the only production values changed, and neither is
     * under test: what matters is the job's STATE, not when it would run.
     */
    const SWEEP_QUEUE = "publish-sweep-e2e";
    const SWEEP_DLQ = "publish-sweep-e2e-dlq";
    let seq = 0;

    beforeAll(async () => {
      const options = { retryLimit: 5, retryDelay: 0, deadLetter: SWEEP_DLQ };
      await boss.createQueue(SWEEP_DLQ);
      await boss.createQueue(SWEEP_QUEUE, options);
      await boss.updateQueue(SWEEP_QUEUE, options);
      // Every test below fetches or inspects; a job left over from an earlier
      // run would silently test something else.
      await db.execute(sql`delete from pgboss.job where name in (${SWEEP_QUEUE}, ${SWEEP_DLQ})`);
    });

    /**
     * An adaptation in `publishing` that has been silent for `secondsAgo`, with
     * or without the send claim its attempt would have taken.
     *
     * The silence is written onto `updated_at` directly, which is the one thing
     * a test cannot get by waiting. Everything before it — the claim on the
     * attempt, the claim on the send — goes through the real repository.
     */
    async function stuck(secondsAgo: number, claim: boolean) {
      seq += 1;
      const chatId = `-100${Date.now()}${seq}`;
      const { adaptationId } = await seedQueuedAdaptation(chatId);
      expect(await repo.markPublishing(orgId, adaptationId, null)).toBe(1);
      if (claim) expect(await repo.claimSend(orgId, adaptationId)).not.toBeNull();
      await db
        .update(schema.adaptations)
        .set({ updatedAt: sql`now() - make_interval(secs => ${secondsAgo})` })
        .where(eq(schema.adaptations.id, adaptationId));
      return { adaptationId, chatId };
    }

    /**
     * The row is the oracle, never the sweep's return value: the sweep is a
     * global maintenance pass and this database is shared with other suites, so
     * "how many did it take" says nothing about this adaptation.
     */
    async function statusOf(adaptationId: string): Promise<string | undefined> {
      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      return row?.status;
    }

    async function publicationsOf(adaptationId: string) {
      return db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.adaptationId, adaptationId));
    }

    it("sweeps an attempt whose send claim outlived it, and refuses to call the outcome a failure", async () => {
      const { adaptationId, chatId } = await stuck(40 * 60, true);

      await service.sweepAbandoned();

      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      expect(row?.status).toBe("failed");
      // The adaptation column has no way to say "we do not know" — it says
      // `failed`, which every reader of it already understands as
      // terminal-and-not-published — so the sentence is what carries the
      // distinction to the human, and the publications row carries it to the
      // machine.
      expect(row?.lastError).toContain("check the channel before re-approving");
      // And the same distinction as a CODE, decided against the same snapshot
      // as the sentence so the two on one row can never disagree.
      expect(row?.failureReason).toBe("outcome_unknown");
      // Counted once, by markPublishing, and not again here.
      expect(row?.attemptCount).toBe(1);

      const pubs = await publicationsOf(adaptationId);
      expect(pubs).toHaveLength(1);
      expect(pubs[0]).toMatchObject({ status: "unknown", attempt: 1 });
      // The claim was RESOLVED, not left standing: an in_flight row that
      // outlives everything blocks claimSend for ever, so an adaptation left
      // with one could never be published again by any route.
      expect(pubs[0]?.status).not.toBe("in_flight");
      // Nothing was sent by the sweep itself, obviously — but assert it, since
      // the whole subject is a post that may or may not exist.
      expect(sendCounts.get(chatId) ?? 0).toBe(0);
    });

    it("sweeps an attempt that never claimed the send, and says plainly that nothing was delivered", async () => {
      const { adaptationId } = await stuck(40 * 60, false);

      await service.sweepAbandoned();

      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      expect(row?.status).toBe("failed");
      expect(row?.lastError).toContain("nothing was delivered");
      expect(row?.lastError).not.toContain("check the channel");
      expect(row?.failureReason).toBe("send_abandoned");

      const pubs = await publicationsOf(adaptationId);
      expect(pubs).toHaveLength(1);
      expect(pubs[0]).toMatchObject({ status: "failed", attempt: 1 });

      // And the parent item goes with it: this adaptation is its only one, so
      // an item left at `approved` beside a dead delivery is the same stuck
      // screen one level up.
      const [item] = await db
        .select()
        .from(schema.contentItems)
        .where(eq(schema.contentItems.id, row?.contentItemId as string));
      expect(item?.status).toBe("failed");
    });

    it("leaves an adaptation whose attempt wrote ten minutes ago", async () => {
      // Absolute, not derived from PUBLISH_ABANDONED_AFTER_SECONDS: a fixture
      // computed from the constant moves with it and pins nothing. This and the
      // forty-minute cases above bracket the threshold to (10min, 40min], which
      // a refactor that rounds twenty minutes down to five or up to an hour
      // breaks.
      const { adaptationId } = await stuck(10 * 60, true);
      await service.sweepAbandoned();
      expect(await statusOf(adaptationId)).toBe("publishing");
      expect(await publicationsOf(adaptationId)).toHaveLength(1); // claim untouched
    });

    it.each(["pending", "queued", "scheduled", "published", "failed"] as const)(
      "leaves a %s adaptation however long it has been silent",
      async (status) => {
        const { adaptationId } = await stuck(40 * 60, false);
        await db
          .update(schema.adaptations)
          .set({ status, updatedAt: sql`now() - make_interval(secs => ${40 * 60})` })
          .where(eq(schema.adaptations.id, adaptationId));
        await service.sweepAbandoned();
        expect(await statusOf(adaptationId)).toBe(status);
      },
    );

    it.each(["created", "active", "retry"] as const)(
      "leaves an adaptation a %s job still names, however long it has been silent",
      async (state) => {
        const { adaptationId } = await stuck(40 * 60, true);
        const jobId = await boss.send(SWEEP_QUEUE, { adaptationId, orgId });
        if (!jobId) throw new Error("boss.send returned null");
        if (state !== "created") {
          const [job] = await boss.fetch(SWEEP_QUEUE);
          expect(job?.id).toBe(jobId);
        }
        if (state === "retry") await boss.fail(SWEEP_QUEUE, jobId, { message: "transient" });
        expect((await boss.getJobById(SWEEP_QUEUE, jobId))?.state).toBe(state);

        try {
          // A row with a job still coming for it is waiting, not abandoned —
          // and a `retry` job is exactly the transient chain the publish queue
          // spends up to an hour of backoff on.
          await service.sweepAbandoned();
          expect(await statusOf(adaptationId)).toBe("publishing");
        } finally {
          await boss.cancel(SWEEP_QUEUE, jobId);
        }
      },
    );

    it("leaves an adaptation whose only live job is on the dead-letter queue", async () => {
      // Retries just ran out and `markExhausted` is on its way, which writes a
      // verdict of its own. Sweeping would be this code racing that consumer.
      const { adaptationId } = await stuck(40 * 60, true);
      const jobId = await boss.send(SWEEP_DLQ, { adaptationId, orgId });
      if (!jobId) throw new Error("boss.send returned null");

      try {
        await service.sweepAbandoned();
        expect(await statusOf(adaptationId)).toBe("publishing");
      } finally {
        await boss.cancel(SWEEP_DLQ, jobId);
      }
    });

    it("sweeps an adaptation whose only job is already completed — the defect's own shape", async () => {
      const { adaptationId } = await stuck(40 * 60, true);
      const jobId = await boss.send(SWEEP_QUEUE, { adaptationId, orgId });
      if (!jobId) throw new Error("boss.send returned null");
      await boss.fetch(SWEEP_QUEUE);
      // What pg-boss's wrapper does to a re-dispatched id when the DISPLACED
      // handler returns: the completion lands on the live incarnation.
      await boss.complete(SWEEP_QUEUE, jobId);
      expect((await boss.getJobById(SWEEP_QUEUE, jobId))?.state).toBe("completed");

      await service.sweepAbandoned();

      expect(await statusOf(adaptationId)).toBe("failed");
    });

    it("loses the race to a live attempt's write rather than winning it", async () => {
      // The case this must never win: an attempt that is alive and mid-send
      // while its job has already gone terminal underneath it. The sweep loses
      // structurally, not by timing — it is ONE statement, so a concurrent
      // write that reaches the row first makes it block on the row lock and
      // then re-evaluate its whole WHERE against the version that committed.
      const { adaptationId } = await stuck(40 * 60, true);

      const attempt = await pool.connect();
      try {
        await attempt.query("begin");
        // What `recordTransient` does on a transient ending, uncommitted.
        await attempt.query(
          "update adaptations set last_error = $2, updated_at = now() where id = $1",
          [adaptationId, "Too Many Requests"],
        );

        const sweeping = service.sweepAbandoned();
        // Long enough for the sweep to reach the row and block on the lock.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await statusOf(adaptationId)).toBe("publishing");

        await attempt.query("commit");
        await sweeping;
      } finally {
        attempt.release();
      }

      expect(await statusOf(adaptationId)).toBe("publishing");
    }, 30_000);

    it("hands the claim back well enough that a deliberate re-approve can publish again", async () => {
      // The other half of the recovery, and the reason the sweep resolves the
      // claim rather than merely reading it. The operator does what the
      // sentence told them to — checks the channel, finds nothing, re-approves
      // — and that must actually send.
      const { adaptationId, chatId } = await stuck(40 * 60, true);
      fakeResponses.set(chatId, {
        status: 200,
        body: {
          ok: true,
          result: { message_id: 7272, chat: { id: Number(chatId), username: "recovered" } },
        },
      });

      await service.sweepAbandoned();
      expect(await statusOf(adaptationId)).toBe("failed");

      // approve() on a failed adaptation.
      await db
        .update(schema.adaptations)
        .set({ status: "queued", lastError: null })
        .where(eq(schema.adaptations.id, adaptationId));
      const jobId = await boss.send(TEST_PUBLISH_QUEUE, { adaptationId, orgId });
      if (!jobId) throw new Error("boss.send returned null");

      const adaptation = await waitUntilLeftQueued(adaptationId);
      expect(adaptation.status).toBe("published");
      expect(sendCounts.get(chatId)).toBe(1);
      const pubs = await publicationsOf(adaptationId);
      expect(pubs.map((row) => row.status).sort()).toEqual(["published", "unknown"]);
    }, 25_000);
  });

  /**
   * THE ROW NOBODY WILL EVER FAIL — the sweep for a job that no longer exists.
   *
   * The block above recovers an attempt that started and stopped. This one
   * recovers a delivery that never started at all. pg-boss DELETES a waiting
   * job once `keep_until = start_after + retention` passes (14 days by
   * default), so a post approved for a slot the worker slept through loses its
   * job outright — and the adaptation is left `scheduled`, or `queued` for a
   * "Publish now", with nothing anywhere that will ever move it. `scheduled` is
   * in `approve`'s target list, so a person who notices can re-approve it;
   * `queued` is not in any human path at all, which is the trap `publishing`
   * used to be.
   *
   * The verdict forks exactly as the sweep above forks, and for the same
   * reason: a `scheduled` row CAN hold a live `in_flight` claim (reject leaves
   * the claim standing, a re-approve puts the row back), and calling such a row
   * "never sent" is the invitation to re-approve into a duplicate.
   */
  describe("stranded-schedule sweep (no job left anywhere)", () => {
    /**
     * A queue with no registered consumer, so a job parked here stays parked in
     * whichever state this block puts it. `retryLimit` and `retryDelay: 0` are
     * the only production values changed, and neither is under test: what the
     * sweep reads is the job's STATE, and a failed job needs retries left to
     * land in `retry` rather than in `failed`.
     */
    const STRANDED_QUEUE = "publish-stranded-e2e";
    let seq = 0;

    beforeAll(async () => {
      const options = { retryLimit: 5, retryDelay: 0 };
      await boss.createQueue(STRANDED_QUEUE, options);
      // The queue survives between runs in a shared database, so a queue
      // created by an older version of this block is updated rather than left
      // with its old (retry-less) options.
      await boss.updateQueue(STRANDED_QUEUE, options);
      await db.execute(sql`delete from pgboss.job where name = ${STRANDED_QUEUE}`);
    });

    /**
     * A row the api left behind and the queue then lost: `scheduled` for a slot
     * `ageSeconds` ago, or `queued` and silent that long, with no job naming it.
     *
     * Only the clock is faked. The claim, when one is asked for, is taken
     * through the real repository in the real order — `markPublishing`,
     * `claimSend`, and then the status put back where a reject and a re-approve
     * would have left it, which is the one shape that produces a `scheduled`
     * row with a live claim on it.
     */
    async function stranded(
      status: "scheduled" | "queued",
      ageSeconds: number,
      claim = false,
      /**
       * How long ago the row was last WRITTEN, when that differs from its slot.
       * The two clocks are separable on purpose: a post approved yesterday for
       * a slot next month is silent and not late, and reading `updated_at` for
       * a `scheduled` row would fail it the moment the bound passed since the
       * approve.
       */
      silentForSeconds = ageSeconds,
      /**
       * Whether an EARLIER attempt already ended on this row, leaving its
       * resolved `failed` receipt behind. The ordinary shape of the population
       * — `approve` targets `failed` rows, so a re-approved delivery carries
       * the receipt of the one before it — and the shape that tells the
       * claimed fork's `p.status = 'in_flight'` apart from "this row has any
       * publications at all".
       */
      priorFailure = false,
    ): Promise<{ adaptationId: string; itemId: string; chatId: string }> {
      seq += 1;
      const chatId = `-200${Date.now()}${seq}`;
      const { adaptationId } = await seedQueuedAdaptation(chatId);
      if (priorFailure) {
        const attemptCount = await repo.markPublishing(orgId, adaptationId, null);
        expect(attemptCount).not.toBeNull();
        const priorClaim = await repo.claimSend(orgId, adaptationId);
        expect(priorClaim).not.toBeNull();
        expect(
          await repo.markFailed(
            orgId,
            adaptationId,
            "the platform refused the first attempt",
            "platform_rejected",
            { status: "publishing", attemptCount: attemptCount as number },
            "failed",
            priorClaim ?? undefined,
          ),
        ).toBe(true);
      }
      if (claim) {
        expect(await repo.markPublishing(orgId, adaptationId, null)).not.toBeNull();
        expect(await repo.claimSend(orgId, adaptationId)).not.toBeNull();
      }
      await db
        .update(schema.adaptations)
        .set({
          status,
          scheduledAt:
            status === "scheduled" ? sql`now() - make_interval(secs => ${ageSeconds})` : null,
          updatedAt: sql`now() - make_interval(secs => ${silentForSeconds})`,
        })
        .where(eq(schema.adaptations.id, adaptationId));
      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      return { adaptationId, itemId: row?.contentItemId as string, chatId };
    }

    async function rowOf(adaptationId: string) {
      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      return row;
    }

    async function itemStatusOf(itemId: string) {
      const [row] = await db
        .select()
        .from(schema.contentItems)
        .where(eq(schema.contentItems.id, itemId));
      return row?.status;
    }

    async function publicationsOf(adaptationId: string) {
      return db
        .select()
        .from(schema.publications)
        .where(eq(schema.publications.adaptationId, adaptationId));
    }

    /**
     * The queue's own table, named rather than assumed. `sweepStranded` reads
     * `pgboss.job` directly — `state` and `data->>'adaptationId'` — which is
     * pg-boss's public contract for this product (`cancelPublish` finds jobs by
     * the same payload, and the abandoned sweep has read the same two columns
     * since it shipped) but is still somebody else's schema. Pinned against a
     * REAL boss instance, so a pg-boss upgrade that renames either one fails
     * here, naming the column, instead of turning both sweeps into permanent
     * no-ops that quietly strand every row they were written to recover.
     */
    it("reads the two pgboss.job columns the sweep's predicate names", async () => {
      const { rows } = await db.execute(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'pgboss' AND table_name = 'job'
            AND column_name IN ('state', 'data')
          ORDER BY column_name`,
      );
      expect(rows.map((row) => (row as { column_name: string }).column_name)).toEqual([
        "data",
        "state",
      ]);
      expect((rows[1] as { data_type: string }).data_type).toBe("USER-DEFINED");
    });

    it("fails a scheduled row whose job retention deleted, and takes the item with it", async () => {
      const { adaptationId, itemId, chatId } = await stranded("scheduled", 26 * 3600);

      await service.sweepAbandoned();

      const row = await rowOf(adaptationId);
      expect(row?.status).toBe("failed");
      expect(row?.failureReason).toBe("schedule_missed");
      expect(row?.lastError).toContain("nothing was delivered");
      // The slot itself is NOT cleared: it is what the screen measures the
      // lateness from, and what makes "Publish now" a decision rather than a
      // guess.
      expect(row?.scheduledAt).not.toBeNull();
      // The parent item goes with it — this adaptation is its only one, so an
      // item left `approved` beside a delivery nothing will ever make is the
      // same stuck screen one level up.
      expect(await itemStatusOf(itemId)).toBe("failed");
      const pubs = await publicationsOf(adaptationId);
      expect(pubs).toHaveLength(1);
      expect(pubs[0]).toMatchObject({ status: "failed" });
      expect(sendCounts.get(chatId) ?? 0).toBe(0);
    });

    it("fails a stranded queued row as send_abandoned — it never had a slot to miss", async () => {
      const { adaptationId } = await stranded("queued", 26 * 3600);

      await service.sweepAbandoned();

      const row = await rowOf(adaptationId);
      expect(row?.status).toBe("failed");
      // NOT `schedule_missed`: "Publish now" writes `scheduled_at = null`, so
      // there is no slot, no lateness for the screen to print, and the sentence
      // "missed its slot by — h" would be a lie with a blank in it.
      expect(row?.failureReason).toBe("send_abandoned");
      expect(row?.scheduledAt).toBeNull();
    });

    it("leaves a scheduled row whose job is still waiting in the queue", async () => {
      const { adaptationId } = await stranded("scheduled", 26 * 3600);
      const jobId = await boss.send(STRANDED_QUEUE, { adaptationId, orgId });
      if (!jobId) throw new Error("boss.send returned null");

      try {
        await service.sweepAbandoned();
        expect((await rowOf(adaptationId))?.status).toBe("scheduled");
      } finally {
        await boss.cancel(STRANDED_QUEUE, jobId);
      }
    });

    /**
     * The other direction of the same predicate, and the one a wrong column
     * would pass without: a job that names SOME adaptation of this org must not
     * protect a different one. Keyed on `data->>'orgId'` — or on nothing at all
     * — this row survives, and the sweep never recovers anything on a database
     * with any live publish job on it.
     */
    it("is not protected by a job naming a different adaptation of the same org", async () => {
      const { adaptationId } = await stranded("scheduled", 26 * 3600);
      const other = await stranded("scheduled", 26 * 3600);
      const jobId = await boss.send(STRANDED_QUEUE, { adaptationId: other.adaptationId, orgId });
      if (!jobId) throw new Error("boss.send returned null");

      try {
        await service.sweepAbandoned();
        expect((await rowOf(adaptationId))?.status).toBe("failed");
        expect((await rowOf(other.adaptationId))?.status).toBe("scheduled");
      } finally {
        await boss.cancel(STRANDED_QUEUE, jobId);
      }
    });

    /**
     * The grace, bracketed with absolute numbers rather than derived from
     * `boundHours`: a fixture computed from the constant moves with it and pins
     * nothing. One hour past a six-hour bound is a post that is merely late and
     * whose job is between `startAfter` and the handler's first write; a second
     * ago is a post approved a second ago. Neither is stranded, and a sweep
     * with no grace at all takes both.
     */
    it.each([
      ["a slot one hour ago", -3600],
      ["a slot one second ago", -1],
    ])("leaves a scheduled row with %s", async (_label, offsetSeconds) => {
      expect(boundHours).toBe(6);
      const { adaptationId } = await stranded("scheduled", -offsetSeconds);
      await service.sweepAbandoned();
      expect((await rowOf(adaptationId))?.status).toBe("scheduled");
    });

    /**
     * WHICH CLOCK A SCHEDULED ROW IS MEASURED BY, which no fixture that
     * backdates both columns together can say. This is a post approved a day
     * ago for a slot a month out — silent for far longer than the bound, and
     * not late by a second. Measured by `updated_at`, as its `queued` sibling
     * correctly is, the sweep fails a delivery whose slot has not arrived: the
     * worst thing in this file, since `failed` is what the screen shows and
     * nothing will put the post back.
     */
    it("leaves a scheduled row approved long ago whose slot is still ahead", async () => {
      const { adaptationId } = await stranded("scheduled", -30 * 24 * 3600, false, 24 * 3600);
      await service.sweepAbandoned();
      expect((await rowOf(adaptationId))?.status).toBe("scheduled");
    });

    it("leaves a queued row approved a second ago", async () => {
      const { adaptationId } = await stranded("queued", 1);
      await service.sweepAbandoned();
      expect((await rowOf(adaptationId))?.status).toBe("queued");
    });

    /**
     * The claimed arm, on the row §2 of the design says produces it: an attempt
     * claimed the send and was killed, a human rejected (which touches no
     * publications row), and they re-approved with a time. The row is
     * `scheduled` with a live claim standing on it — and the one thing this
     * sweep must never say about it is "never sent".
     */
    it("records outcome_unknown for a stranded row that still holds an in-flight claim", async () => {
      const { adaptationId } = await stranded("scheduled", 26 * 3600, true);

      await service.sweepAbandoned();

      const row = await rowOf(adaptationId);
      expect(row?.status).toBe("failed");
      expect(row?.failureReason).toBe("outcome_unknown");
      expect(row?.lastError).toContain("check the channel before re-approving");
      const pubs = await publicationsOf(adaptationId);
      expect(pubs).toHaveLength(1);
      expect(pubs[0]?.status).toBe("unknown");
      // Resolved, not left standing: an in-flight row that outlives everything
      // blocks `claimSend` for ever.
      expect(pubs[0]?.status).not.toBe("in_flight");
    });

    /**
     * THE OTHER SIDE OF THAT FORK, and the one every other fixture here leaves
     * unsaid: a stranded row whose publications are all TERMINAL. It is the
     * ordinary shape of the population rather than an edge — `approve` targets
     * `failed` rows, so a re-approved delivery arrives carrying the receipt of
     * the attempt before it — and with the claimed arm keyed on "has any
     * publications row" instead of on `p.status = 'in_flight'` this row is
     * recorded `outcome_unknown`. That is not a cosmetic mislabel: `approve`
     * skips a delivery with an unknown outcome and refuses a timed approve
     * outright, so the post becomes unsendable except through the manual
     * delivery resolver.
     */
    it("says schedule_missed for a stranded row carrying only a PRIOR failed receipt", async () => {
      const { adaptationId } = await stranded("scheduled", 26 * 3600, false, 26 * 3600, true);
      const before = await publicationsOf(adaptationId);
      expect(before).toHaveLength(1);
      expect(before[0]?.status).toBe("failed");

      await service.sweepAbandoned();

      const row = await rowOf(adaptationId);
      expect(row?.status).toBe("failed");
      // The old receipt says nothing about THIS delivery: no attempt claimed
      // the send this time, so nothing can have reached the platform.
      expect(row?.failureReason).toBe("schedule_missed");
      expect(row?.lastError).toContain("nothing was delivered");
      expect(row?.lastError).not.toContain("check the channel before re-approving");
      const pubs = await publicationsOf(adaptationId);
      expect(pubs).toHaveLength(2);
      expect(pubs.map((pub) => pub.status).sort()).toEqual(["failed", "failed"]);
    });

    /**
     * The predicate that decides whether a row is stranded AT ALL, on the two
     * states no fixture in this block reaches on its own: a job waiting out its
     * retry backoff (up to an hour of it on the publish queue) and a job a
     * worker is holding right now. `created` is covered by the waiting-job case
     * above; these two are the difference between "not terminal" and "not yet
     * started", and they are reachable exactly in the outage this feature is
     * about, where a woken worker's first attempt fails transiently before it
     * can write anything.
     */
    it.each(["active", "retry"] as const)(
      "leaves a stranded-looking row whose job is in %s",
      async (state) => {
        const { adaptationId } = await stranded("scheduled", 26 * 3600);
        const jobId = await boss.send(STRANDED_QUEUE, { adaptationId, orgId });
        if (!jobId) throw new Error("boss.send returned null");
        const [job] = await boss.fetch(STRANDED_QUEUE);
        expect(job?.id).toBe(jobId);
        if (state === "retry") await boss.fail(STRANDED_QUEUE, jobId, { message: "transient" });
        expect((await boss.getJobById(STRANDED_QUEUE, jobId))?.state).toBe(state);

        try {
          await service.sweepAbandoned();
          expect((await rowOf(adaptationId))?.status).toBe("scheduled");
        } finally {
          await boss.cancel(STRANDED_QUEUE, jobId);
        }
      },
    );
  });
});
