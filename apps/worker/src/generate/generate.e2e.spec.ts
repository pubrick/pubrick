import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ScriptedModel, scriptedModel } from "../test/scripted-model";

const url = process.env.TEST_DATABASE_URL;

// Type-only: nothing that reads env at module load may be imported before
// beforeAll has set it. Same reasoning as publish.e2e.spec.ts.
type GenerateRepositoryCtor = typeof import("./generate.repository").GenerateRepository;
type GenerateServiceCtor = typeof import("./generate.service").GenerateService;
type PublishRepositoryCtor = typeof import("../publish/publish.repository").PublishRepository;
type PublishServiceCtor = typeof import("../publish/publish.service").PublishService;
type QueueServiceCtor = typeof import("../queue.service").QueueService;
type PgBossCtor = typeof import("pg-boss").PgBoss;
type PgBossInstance = InstanceType<PgBossCtor>;
type Schema = typeof import("@pubrick/db").schema;
type Db = Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
type Pool = Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];

/**
 * Private queue pair, for the same reason the publish e2e has one: this file
 * registers a LIVE consumer, turbo runs the api and worker suites concurrently
 * against one database, and a consumer on the real `generate` queue would pick
 * up the runs `runs.e2e.spec.ts` creates and execute them out from under it.
 * `registerAll` takes both pairs so neither can leak.
 */
const TEST_GENERATE_QUEUE = "generate-worker-e2e";
const TEST_GENERATE_DLQ = "generate-worker-e2e-dlq";
const TEST_PUBLISH_QUEUE = "publish-generate-e2e";
const TEST_PUBLISH_DLQ = "publish-generate-e2e-dlq";

const EDITED = "EDITED_MARKER the autumn menu lands on Monday.";

/**
 * A generation run driven through the REAL machinery: a real pg-boss queue
 * registered by `QueueService.registerAll`, a real repository against Postgres,
 * and a mock model — no test may call a provider.
 *
 * What only this file can show is the JOB's own fate. "The run says failed" and
 * "pg-boss will never touch this job again" are different claims, and the
 * difference is the whole failure policy: a permanent error must COMPLETE the
 * job, a transient one must leave it in `retry`. A row-only assertion cannot
 * tell them apart, because the retry lands a minute later.
 */
describe.skipIf(!url)("generate e2e (real DB + real pg-boss + mock model)", () => {
  let db: Db;
  let pool: Pool;
  let workerPool: Pool;
  let schema: Schema;
  let eq: typeof import("drizzle-orm").eq;
  let encryptJson: typeof import("@pubrick/shared").encryptJson;
  let boss: PgBossInstance;
  let repo: InstanceType<GenerateRepositoryCtor>;
  let service: InstanceType<GenerateServiceCtor>;
  let preferredCredential: typeof import("@pubrick/shared").preferredCredential;
  let sql: typeof import("drizzle-orm").sql;
  let queueOptions: typeof import("@pubrick/shared").GENERATE_QUEUE_OPTIONS;
  let graceSeconds: number;
  let seq = 0;

  /**
   * The script the next run will be answered with. One mutable slot rather than a
   * map, because the service is built once for the queue and its model factory
   * sees only the credential. Safe because vitest runs a file's tests
   * sequentially and each test below waits for its own job to settle.
   */
  let active: ScriptedModel = scriptedModel();

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";

    const dbModule = await import("@pubrick/db");
    schema = dbModule.schema;
    ({ db, pool } = dbModule.createDb(url as string));
    ({ eq, sql } = await import("drizzle-orm"));
    ({
      encryptJson,
      preferredCredential,
      GENERATE_QUEUE_OPTIONS: queueOptions,
    } = await import("@pubrick/shared"));

    const { PgBoss } = await import("pg-boss");
    boss = new (PgBoss as PgBossCtor)(url as string);
    boss.on("error", (err: Error) => console.error("pg-boss error (generate.e2e.spec)", err));
    await boss.start();

    const { GenerateRepository } = (await import("./generate.repository")) as {
      GenerateRepository: GenerateRepositoryCtor;
    };
    const { GenerateService } = (await import("./generate.service")) as {
      GenerateService: GenerateServiceCtor;
    };
    const { PublishRepository } = (await import("../publish/publish.repository")) as {
      PublishRepository: PublishRepositoryCtor;
    };
    const { PublishService } = (await import("../publish/publish.service")) as {
      PublishService: PublishServiceCtor;
    };
    const queueModule = (await import("../queue.service")) as {
      QueueService: QueueServiceCtor;
      sweepQueueOf: (generateQueue: string) => string;
    };

    // Nothing left over from an earlier, interrupted execution of THIS file.
    // The queues below are private to it, but the database is not: a run that
    // was killed mid-suite leaves a `created` or `retry` job behind, and the
    // next execution's `fetch` hands it to a test that sent a different one —
    // which answers from the wrong script and fails somewhere unrelated. The
    // file already cancels its one deliberate retry for exactly this reason;
    // this is that habit applied to the whole of its own queue space.
    await db.execute(
      sql`delete from pgboss.job where name in (${TEST_GENERATE_QUEUE}, ${TEST_GENERATE_DLQ}, ${TEST_PUBLISH_QUEUE}, ${TEST_PUBLISH_DLQ})`,
    );

    // The real wiring, registered exactly the way main.ts does — only the queue
    // names and the model factory differ.
    repo = new GenerateRepository();
    graceSeconds = ((await import("./generate.repository")) as { ABANDONED_GRACE_SECONDS: number })
      .ABANDONED_GRACE_SECONDS;
    const generate = new GenerateService(repo, () => active.model as never, 0);
    service = generate;
    const publish = new PublishService(new PublishRepository());
    await new queueModule.QueueService(publish, generate).registerAll(boss, {
      publish: TEST_PUBLISH_QUEUE,
      publishDeadLetter: TEST_PUBLISH_DLQ,
      generate: TEST_GENERATE_QUEUE,
      generateDeadLetter: TEST_GENERATE_DLQ,
    });
    // registerAll also puts the abandoned-run sweep on a cron. Unscheduled here
    // so nothing sweeps behind this file's back: the sweep tests below drive
    // `sweepAbandoned` directly, and an unattended tick landing between a
    // fixture's setup and its assertion would make them flaky for a reason that
    // has nothing to do with what they check. The consumer stays registered —
    // `queue.service.spec.ts` is where the wiring itself is pinned.
    await boss.unschedule(queueModule.sweepQueueOf(TEST_GENERATE_QUEUE));

    workerPool = ((await import("../db")) as { pool: Pool }).pool;
  }, 30_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 5_000 });
    await pool?.end();
    await workerPool?.end();
  });

  async function seed(channels = 2) {
    seq += 1;
    const stamp = `gen-e2e-${Date.now()}-${seq}`;
    await db
      .insert(schema.organization)
      .values({ id: stamp, name: "Generate E2E Org", slug: stamp, createdAt: new Date() });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId: stamp, name: "Kettle and Co", voice: "dry", contentLanguage: "en" })
      .returning({ id: schema.brands.id });
    const brandId = brand?.id as string;

    const channelIds: string[] = [];
    for (let i = 0; i < channels; i += 1) {
      const [channel] = await db
        .insert(schema.channels)
        .values({
          orgId: stamp,
          brandId,
          platform: "telegram",
          name: `Chan ${i}`,
          credentialsEncrypted: encryptJson(
            { botToken: "123:abc", chatId: "-100" },
            process.env.APP_ENCRYPTION_KEY as string,
          ),
        })
        .returning({ id: schema.channels.id });
      channelIds.push(channel?.id as string);
    }

    await db.insert(schema.aiCredentials).values({
      orgId: stamp,
      provider: "google",
      credentialsEncrypted: encryptJson(
        { apiKey: "test-key" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
      defaultModel: "gemini-3.7-flash",
    });

    const [run] = await db
      .insert(schema.pipelineRuns)
      .values({
        orgId: stamp,
        brandId,
        input: { kind: "brief", text: "Announce the autumn menu", channelIds },
      })
      .returning({ id: schema.pipelineRuns.id });

    return { orgId: stamp, brandId, runId: run?.id as string, channelIds };
  }

  /** The same job shape and group the api's `enqueueGenerate` sends. */
  async function enqueue(runId: string, orgId: string): Promise<string> {
    const jobId = await boss.send(TEST_GENERATE_QUEUE, { runId, orgId }, { group: { id: orgId } });
    if (!jobId) throw new Error("boss.send returned null (unexpected duplicate job id)");
    return jobId;
  }

  /**
   * Asserts the pg-boss JOB's own terminal state. Hard 20s timeout: a hang here
   * must fail loudly, never block the suite.
   */
  async function waitForJobState(jobId: string) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const job = await boss.getJobById(TEST_GENERATE_QUEUE, jobId);
      if (job && job.state !== "created" && job.state !== "active") return job;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out after 20s waiting for job ${jobId} to leave created/active`);
  }

  async function runRow(runId: string) {
    const [row] = await db
      .select()
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, runId));
    return row;
  }

  it("drives all five roles to a real draft, its adaptations and their first ai versions", async () => {
    const seeded = await seed(2);
    active = scriptedModel({
      editor: () => ({ body: EDITED, changes: ["Tightened the opening."] }),
    });

    const jobId = await enqueue(seeded.runId, seeded.orgId);
    const job = await waitForJobState(jobId);
    expect(job.state).toBe("completed");

    const run = await runRow(seeded.runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.contentItemId).not.toBeNull();
    // Four roles plus one adapter per channel — the per-channel key is what keeps
    // a crash mid-fan-out from re-running the channels that already succeeded.
    expect(Object.keys(run?.steps ?? {}).sort()).toEqual(
      [
        "editor",
        "factcheck",
        "researcher",
        "writer",
        ...seeded.channelIds.map((id) => `adapter:${id}`),
      ].sort(),
    );

    const [item] = await db
      .select()
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, run?.contentItemId as string));
    expect(item).toMatchObject({ body: EDITED, status: "draft", origin: "ai" });

    const adaptations = await db
      .select()
      .from(schema.adaptations)
      .where(eq(schema.adaptations.contentItemId, item?.id as string));
    expect(adaptations).toHaveLength(2);
    expect(adaptations.every((row) => row.origin === "ai")).toBe(true);

    const versions = await db
      .select()
      .from(schema.contentVersions)
      .where(eq(schema.contentVersions.contentItemId, item?.id as string));
    // One for the master body and one per adaptation: the provenance reference
    // the publish gate and the badge are both derived from.
    expect(versions).toHaveLength(3);
    expect(versions.every((row) => row.origin === "ai")).toBe(true);
    expect(versions.every((row) => row.runId === seeded.runId)).toBe(true);

    const ledger = await db
      .select()
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.runId, seeded.runId));
    expect(ledger).toHaveLength(6);
  }, 40_000);

  it("completes the job for a permanent failure instead of retrying a run that cannot succeed", async () => {
    const seeded = await seed(1);
    active = scriptedModel({ writer: () => "not json at all" });

    const jobId = await enqueue(seeded.runId, seeded.orgId);
    const job = await waitForJobState(jobId);

    // "completed", never "retry": each retry is another paid model call for an
    // error that will recur identically.
    expect(job.state).toBe("completed");
    const run = await runRow(seeded.runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("no_structured_output");
    expect(run?.contentItemId).toBeNull();
  }, 40_000);

  it("retries a transient provider failure instead of failing the run", async () => {
    const { APICallError } = await import("ai");
    const seeded = await seed(1);
    active = scriptedModel({
      writer: () => {
        throw new APICallError({
          message: "service unavailable",
          url: "https://example.test/v1",
          requestBodyValues: {},
          statusCode: 503,
          // The SDK's own verdict, not a status list of ours — `classifyAiError`
          // reads exactly this.
          isRetryable: true,
        });
      },
    });

    const jobId = await enqueue(seeded.runId, seeded.orgId);
    const job = await waitForJobState(jobId);

    expect(job.state).toBe("retry");
    const run = await runRow(seeded.runId);
    // Still running: only a PERMANENT error may write a terminal status, and the
    // retry will resume from the researcher's checkpoint rather than re-buy it.
    expect(run?.status).toBe("running");
    // The code, not the provider's sentence: `pipeline_runs.error` is handed to
    // a browser, and "service unavailable" is the polite end of what a provider
    // can put in that string.
    expect(run?.error).toBe("rate_limited");
    expect(Object.keys(run?.steps ?? {})).toEqual(["researcher"]);

    // Leave nothing armed: retryDelay is 60s, well past this file's lifetime,
    // and a retry firing during a later test would answer from the wrong script.
    await boss.cancel(TEST_GENERATE_QUEUE, jobId);
  }, 40_000);

  it("stops without throwing when the run is cancelled mid-flight", async () => {
    const seeded = await seed(1);
    active = scriptedModel({
      writer: async () => {
        // What `POST /api/runs/:id/cancel` writes. Its job cancellation is the
        // api's half; a job already fetched still reaches this handler, and the
        // status is what must stop it.
        await db
          .update(schema.pipelineRuns)
          .set({ status: "cancelled" })
          .where(eq(schema.pipelineRuns.id, seeded.runId));
        return { body: "A first draft." };
      },
    });

    const jobId = await enqueue(seeded.runId, seeded.orgId);
    const job = await waitForJobState(jobId);

    // Completed, not retried: the user said no, so there is nothing to retry.
    expect(job.state).toBe("completed");
    const run = await runRow(seeded.runId);
    expect(run?.status).toBe("cancelled");
    expect(run?.contentItemId).toBeNull();
    expect(active.callsFor("editor")).toBe(0);
    expect(
      await db
        .select()
        .from(schema.contentItems)
        .where(eq(schema.contentItems.orgId, seeded.orgId)),
    ).toHaveLength(0);
  }, 40_000);

  it("resumes from checkpoints on a redelivery without paying for the steps that finished", async () => {
    const seeded = await seed(1);
    await db
      .update(schema.pipelineRuns)
      .set({
        steps: {
          researcher: {
            status: "succeeded",
            output: { angle: "An angle", keyPoints: ["A key point"], avoid: [] },
          },
          writer: {
            status: "succeeded",
            output: { body: "RESUMED_MARKER a draft from attempt one." },
          },
          editor: {
            status: "succeeded",
            output: { body: EDITED, changes: ["Tightened the opening."] },
          },
        },
      })
      .where(eq(schema.pipelineRuns.id, seeded.runId));
    active = scriptedModel();

    const jobId = await enqueue(seeded.runId, seeded.orgId);
    expect((await waitForJobState(jobId)).state).toBe("completed");

    // The count, not the output: an implementation that re-ran these and got the
    // same answer would look identical and cost the org three calls.
    expect(active.callsFor("researcher")).toBe(0);
    expect(active.callsFor("writer")).toBe(0);
    expect(active.callsFor("editor")).toBe(0);
    expect(active.callsFor("factcheck")).toBe(1);
    expect(active.callsFor("adapter")).toBe(1);

    const run = await runRow(seeded.runId);
    expect(run?.status).toBe("succeeded");
    const [item] = await db
      .select()
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, run?.contentItemId as string));
    expect(item?.body).toBe(EDITED);
    // Only the two calls it actually made are billed to this run.
    const ledger = await db
      .select()
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.runId, seeded.runId));
    expect(ledger).toHaveLength(2);
  }, 40_000);

  /**
   * The provider a run reaches, against the real table.
   *
   * The rule is `preferredCredential` (`@pubrick/shared`), and the api's
   * `AiCredentialsRepository.credential` sorts with the same function — that
   * shared call is the only thing keeping a resumed run and an editor-side
   * refine on one vendor's bill. So the oracle is the comparator itself, over
   * the rows Postgres holds, rather than a literal provider name that would
   * stay green for a repository which had stopped consulting the ordering.
   */
  describe("credential", () => {
    async function seedOrg(): Promise<string> {
      seq += 1;
      const orgId = `gen-e2e-cred-${Date.now()}-${seq}`;
      await db
        .insert(schema.organization)
        .values({ id: orgId, name: "Credential E2E Org", slug: orgId, createdAt: new Date() });
      return orgId;
    }

    /** The key stored for `provider`, so a wrong CHOICE cannot look right. */
    function keyFor(provider: "google" | "openrouter") {
      return `key-for-${provider}`;
    }

    async function storeKey(
      orgId: string,
      provider: "google" | "openrouter",
      createdAt: Date,
    ): Promise<void> {
      await db.insert(schema.aiCredentials).values({
        orgId,
        provider,
        credentialsEncrypted: encryptJson(
          { apiKey: keyFor(provider) },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
        defaultModel: `${provider}-default`,
        createdAt,
      });
    }

    /**
     * What the shared rule says about the rows this org has, read back from the DB.
     *
     * Also asserts the answer does not depend on the ORDER the rows arrive in.
     * Neither repository orders its select — an org has at most two rows — so
     * Postgres is free to return them either way (an index scan on
     * `(org_id, provider)` yields provider order; a seq scan yields heap order),
     * and it does not have to make the same choice for both apps. A rule that
     * leaned on row order would leave the api and the worker agreeing by query
     * plan, which is not agreement at all.
     */
    async function ruleSays(orgId: string) {
      const rows = await db
        .select({
          provider: schema.aiCredentials.provider,
          createdAt: schema.aiCredentials.createdAt,
        })
        .from(schema.aiCredentials)
        .where(eq(schema.aiCredentials.orgId, orgId));
      const picked = preferredCredential(rows);
      expect(preferredCredential([...rows].reverse())).toBe(picked);
      return picked;
    }

    it("reaches the key the comparator picks — the oldest, not the newest", async () => {
      const orgId = await seedOrg();
      // Newest stored first, so "the last row inserted" is a distinct wrong answer.
      await storeKey(orgId, "google", new Date("2026-06-01T10:00:00.000Z"));
      await storeKey(orgId, "openrouter", new Date("2026-01-01T10:00:00.000Z"));

      const picked = await ruleSays(orgId);
      expect(picked?.provider).toBe("openrouter");

      const credential = await repo.credential(orgId);
      expect(credential?.provider).toBe(picked?.provider);
      // The chosen ROW was decrypted, not merely its provider name reported.
      expect(credential?.apiKey).toBe(keyFor("openrouter"));
      expect(credential?.defaultModel).toBe("openrouter-default");
    });

    it("breaks a tie exactly where the comparator does", async () => {
      const orgId = await seedOrg();
      // One instant for both rows: only the provider tie-break can decide, and
      // it is the branch a `created_at`-only ordering would leave to the planner.
      const sameInstant = new Date("2026-03-03T12:00:00.000Z");
      await storeKey(orgId, "openrouter", sameInstant);
      await storeKey(orgId, "google", sameInstant);

      const picked = await ruleSays(orgId);
      expect(picked?.provider).toBe("google");

      const credential = await repo.credential(orgId);
      expect(credential?.provider).toBe(picked?.provider);
      expect(credential?.apiKey).toBe(keyFor("google"));
    });

    it("returns undefined for an org with no key", async () => {
      const orgId = await seedOrg();
      expect(await ruleSays(orgId)).toBeUndefined();
      await expect(repo.credential(orgId)).resolves.toBeUndefined();
    });

    it("never reaches another org's key", async () => {
      const mine = await seedOrg();
      const theirs = await seedOrg();
      await storeKey(mine, "google", new Date("2026-01-01T10:00:00.000Z"));
      // Older than mine: an unscoped select would sort it to the front.
      await storeKey(theirs, "openrouter", new Date("2025-01-01T10:00:00.000Z"));

      expect((await repo.credential(mine))?.apiKey).toBe(keyFor("google"));
      expect((await repo.credential(theirs))?.apiKey).toBe(keyFor("openrouter"));
    });
  });

  /**
   * The state no other path can reach, and the sweep that ends it.
   *
   * pg-boss re-inserts a failed job under the SAME id (`failJobsBody`), so when
   * the supervisor's `failJobsByHeartbeat` re-dispatches a job whose handler is
   * merely stalled — not dead — handler B gets an id handler A is still using.
   * The fence holds: B claims, A's next fenced write matches nothing and A
   * returns normally, which is what the fence contract asks of it. But A returns
   * INTO pg-boss's wrapper, and `Manager#processJobs` then calls
   * `complete(name, [id])`, guarded `state = 'active'` — and the active
   * incarnation of that id is B's. B's live job goes `completed`. From that
   * moment B's own throw cannot fail it (`failJobsById` is guarded
   * `state < 'completed'`), so no retry fires, no dead letter is written, and
   * `markExhausted` never runs.
   *
   * Everything below drives the REAL machinery — a real pg-boss queue, the real
   * supervisor, the real repository, the real service, a mock model — so the
   * job-state transitions are pg-boss's own rather than a test's idea of them.
   */
  describe("abandoned-run sweep", () => {
    /**
     * A queue with no registered consumer, so this block can hand deliveries to
     * handlers itself and play the wrapper's part explicitly. `retryDelay: 0`
     * and no backoff are the only production values changed: a re-dispatch is
     * the mechanism under test, and production's 60s exponential floor would
     * mean waiting a minute to see it. Everything the race depends on — the
     * expiry, the heartbeat, the retry limit, the dead letter — is production's.
     */
    const RACE_QUEUE = "generate-race-e2e";
    const RACE_DLQ = "generate-race-e2e-dlq";

    beforeAll(async () => {
      // `retryDelayMax` is dropped with the backoff it belongs to — pg-boss
      // rejects the pair (`validateRetryConfig`).
      const { retryDelayMax: _unused, ...rest } = queueOptions;
      const options = { ...rest, retryDelay: 0, retryBackoff: false, deadLetter: RACE_DLQ };
      await boss.createQueue(RACE_DLQ);
      await boss.createQueue(RACE_QUEUE, options);
      await boss.updateQueue(RACE_QUEUE, options);
      // Same reason as the purge in the outer hook, and it matters more here:
      // every test below fetches, and a fetch that returns someone else's job
      // silently tests nothing.
      await db.execute(sql`delete from pgboss.job where name in (${RACE_QUEUE}, ${RACE_DLQ})`);
    });

    /** Where this run's lease ends, relative to now. Negative is in the past. */
    async function setLease(runId: string, secondsFromNow: number | null): Promise<void> {
      await db
        .update(schema.pipelineRuns)
        .set({
          leaseExpiresAt:
            secondsFromNow === null ? null : sql`now() + make_interval(secs => ${secondsFromNow})`,
        })
        .where(eq(schema.pipelineRuns.id, runId));
    }

    /** A run in the state a claimed, in-flight run is in, with a lease we choose. */
    async function claimedRun(leaseSecondsFromNow: number | null) {
      const seeded = await seed(1);
      await db
        .update(schema.pipelineRuns)
        .set({ status: "running", activeJobId: `${crypto.randomUUID()}#${crypto.randomUUID()}` })
        .where(eq(schema.pipelineRuns.id, seeded.runId));
      await setLease(seeded.runId, leaseSecondsFromNow);
      return seeded;
    }

    /**
     * The row itself is the oracle, never the sweep's return value: the sweep is
     * a global maintenance pass and the shared test database holds other
     * suites' rows, so "how many did it take" says nothing about this run.
     */
    async function statusOf(runId: string): Promise<string | undefined> {
      return (await runRow(runId))?.status;
    }

    it("leaves a run running when its live handler's job is completed out from under it, and the sweep is what ends it", async () => {
      const { APICallError } = await import("ai");
      const seeded = await seed(1);

      let parkA = (): void => {};
      let parkB = (): void => {};
      const aIsParked = new Promise<void>((resolve) => {
        parkA = resolve;
      });
      const bIsParked = new Promise<void>((resolve) => {
        parkB = resolve;
      });
      let releaseA = (): void => {};
      let releaseB = (): void => {};
      const aMayFinish = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const bMayFinish = new Promise<void>((resolve) => {
        releaseB = resolve;
      });

      let writerCalls = 0;
      active = scriptedModel({
        writer: async () => {
          writerCalls += 1;
          // A parks here, holding its fence, which is what lets a re-dispatch
          // reach a handler that is neither finished nor dead.
          if (writerCalls === 1) {
            parkA();
            await aMayFinish;
            return { body: "A's draft, paid for once." };
          }
          return { body: "B's draft, paid for a second time." };
        },
        // B alone gets this far; it is where B is holding when A completes B's
        // job, and it fails with an error that WOULD have been retried.
        editor: async () => {
          parkB();
          await bMayFinish;
          throw new APICallError({
            message: "service unavailable",
            url: "https://example.test/v1",
            requestBodyValues: {},
            statusCode: 503,
            isRetryable: true,
          });
        },
      });

      const jobId = await boss.send(RACE_QUEUE, { runId: seeded.runId, orgId: seeded.orgId });
      if (!jobId) throw new Error("boss.send returned null");
      const [jobA] = await boss.fetch<{ runId: string; orgId: string }>(RACE_QUEUE);
      if (!jobA) throw new Error("nothing to fetch for handler A");
      const handlerA = service.handle({ id: jobA.id, data: jobA.data });
      await aIsParked;

      // The supervisor's own path, not a hand-written UPDATE: age the heartbeat
      // past the queue's heartbeatSeconds and let pg-boss decide. A worker whose
      // event loop or database stalled for that long looks exactly like this.
      await db.execute(
        sql`update pgboss.job set heartbeat_on = now() - interval '10 minutes' where id = ${jobId}`,
      );
      // `supervise` throttles itself per queue on `queue.monitor_on` — the same
      // instance's own timer has usually just run — so clear the stamp and let
      // pg-boss's `failJobsByHeartbeat` actually fire. Nothing about the job row
      // or the transition is faked; only the clock the supervisor checks itself
      // against is.
      await db.execute(sql`update pgboss.queue set monitor_on = null where name = ${RACE_QUEUE}`);
      await boss.supervise(RACE_QUEUE);
      const [jobB] = await boss.fetch<{ runId: string; orgId: string }>(RACE_QUEUE);
      if (!jobB) throw new Error("the heartbeat re-dispatch produced nothing to fetch");
      // The same id. This is the whole defect in one assertion: pg-boss deletes
      // and re-inserts, it does not mint a new identity, so a fence built on the
      // job id ALONE would admit both handlers.
      expect(jobB.id).toBe(jobId);

      const handlerB = service.handle({ id: jobB.id, data: jobB.data });
      await bIsParked;

      // A finds its fence gone, stops, and returns normally — correct, and the
      // only correct thing: throwing here would route through `fail()`, guarded
      // `state < 'completed'`, and displace B's live job in turn.
      releaseA();
      await expect(handlerA).resolves.toBeUndefined();

      // pg-boss's wrapper, playing A's part. `completeJobs` is guarded
      // `state = 'active'`, and the active incarnation is B's.
      expect((await boss.getJobById(RACE_QUEUE, jobId))?.state).toBe("active");
      await boss.complete(RACE_QUEUE, jobId);
      // B's live job, completed by A's completion. `CommandResponse` carries no
      // count, so the row is the oracle — which is the better one anyway.
      expect((await boss.getJobById(RACE_QUEUE, jobId))?.state).toBe("completed");

      // And now B fails for a reason that deserves a retry.
      releaseB();
      await expect(handlerB).rejects.toThrow();
      await boss.fail(RACE_QUEUE, jobId, { message: "service unavailable" });
      // Nothing happened. Not a retry, not a dead letter — `failJobsById` is
      // guarded `state < 'completed'` and the job is already past that.
      expect((await boss.getJobById(RACE_QUEUE, jobId))?.state).toBe("completed");

      // The state the reviewer found, reproduced: a run that says it is running,
      // with an error on it, no draft, and one step bought twice.
      const stranded = await runRow(seeded.runId);
      expect(stranded?.status).toBe("running");
      expect(stranded?.error).toBe("rate_limited");
      expect(stranded?.contentItemId).toBeNull();
      const writerRows = await db
        .select()
        .from(schema.usageLedger)
        .where(eq(schema.usageLedger.runId, seeded.runId));
      expect(writerRows.filter((row) => row.step === "writer")).toHaveLength(2);

      // The sweep does NOT touch it yet, and that is the point: B's lease was
      // renewed seconds ago, and a fresh lease is indistinguishable from a
      // handler that is still working.
      await service.sweepAbandoned();
      expect(await statusOf(seeded.runId)).toBe("running");

      // Two lease periods later, with no job left anywhere that names this run,
      // there is nothing that could still be alive.
      await setLease(seeded.runId, -(graceSeconds + 60));
      await service.sweepAbandoned();
      const recovered = await runRow(seeded.runId);
      expect(recovered?.status).toBe("failed");
      expect(recovered?.error).toBe("retries_exhausted");
      // The fence never let a second draft through, before or after.
      expect(recovered?.contentItemId).toBeNull();
    }, 60_000);

    it("sweeps a run whose lease has been gone forty-five minutes with no job behind it", async () => {
      const seeded = await claimedRun(-45 * 60);
      await service.sweepAbandoned();
      expect(await statusOf(seeded.runId)).toBe("failed");
    });

    it("leaves a run whose lease has only been gone twenty minutes", async () => {
      // Absolute, not derived from ABANDONED_GRACE_SECONDS: a fixture computed
      // from the constant moves with it and pins nothing. This one and the
      // forty-five-minute case above bracket the grace to (20min, 45min], which
      // a refactor that rounds 30 minutes down to 15 or up to an hour breaks.
      const seeded = await claimedRun(-20 * 60);
      await service.sweepAbandoned();
      expect(await statusOf(seeded.runId)).toBe("running");
    });

    it("leaves a run whose lease is still live", async () => {
      const seeded = await claimedRun(15 * 60);
      await service.sweepAbandoned();
      expect(await statusOf(seeded.runId)).toBe("running");
    });

    it("leaves a running run that has no lease at all", async () => {
      // Nothing this repository writes produces this row, so there is no
      // evidence to reason from and the sweep must not guess. Without the
      // `is not null` guard the comparison would be NULL — not true — and this
      // would pass by accident; with a `coalesce` it would fail loudly instead.
      const seeded = await claimedRun(null);
      await service.sweepAbandoned();
      expect(await statusOf(seeded.runId)).toBe("running");
    });

    it.each(["queued", "succeeded", "cancelled", "failed"] as const)(
      "leaves a %s run however stale its lease",
      async (status) => {
        const seeded = await claimedRun(-45 * 60);
        await db
          .update(schema.pipelineRuns)
          .set({ status })
          .where(eq(schema.pipelineRuns.id, seeded.runId));
        await service.sweepAbandoned();
        expect(await statusOf(seeded.runId)).toBe(status);
      },
    );

    it.each(["created", "active", "retry"] as const)(
      "leaves a run a %s job still names, however stale its lease",
      async (state) => {
        const seeded = await claimedRun(-45 * 60);
        const jobId = await boss.send(RACE_QUEUE, { runId: seeded.runId, orgId: seeded.orgId });
        if (!jobId) throw new Error("boss.send returned null");
        if (state !== "created") {
          const [job] = await boss.fetch(RACE_QUEUE);
          expect(job?.id).toBe(jobId);
        }
        if (state === "retry") await boss.fail(RACE_QUEUE, jobId, { message: "transient" });
        expect((await boss.getJobById(RACE_QUEUE, jobId))?.state).toBe(state);

        try {
          await service.sweepAbandoned();
          // A run with a job still coming for it is waiting, not abandoned.
          expect(await statusOf(seeded.runId)).toBe("running");
        } finally {
          // In a `finally` so one failing case cannot leave a fetchable job
          // behind for the next one to pick up instead of its own.
          await boss.cancel(RACE_QUEUE, jobId);
        }
      },
    );

    it("leaves a run whose only live job is on the dead-letter queue", async () => {
      // A run whose retries have just run out is on its way to `markExhausted`,
      // which fails it properly. Sweeping it would be this code racing the DLQ
      // consumer to write a verdict the DLQ consumer already owns.
      const seeded = await claimedRun(-45 * 60);
      const jobId = await boss.send(RACE_DLQ, { runId: seeded.runId, orgId: seeded.orgId });
      if (!jobId) throw new Error("boss.send returned null");

      try {
        await service.sweepAbandoned();
        expect(await statusOf(seeded.runId)).toBe("running");
      } finally {
        await boss.cancel(RACE_DLQ, jobId);
      }
    });

    it("sweeps a run whose only job is already completed", async () => {
      // The defect's own shape, reduced: the job exists, it is terminal, and
      // nothing will ever deliver it again.
      const seeded = await claimedRun(-45 * 60);
      const jobId = await boss.send(RACE_QUEUE, { runId: seeded.runId, orgId: seeded.orgId });
      if (!jobId) throw new Error("boss.send returned null");
      await boss.fetch(RACE_QUEUE);
      await boss.complete(RACE_QUEUE, jobId);

      await service.sweepAbandoned();

      expect(await statusOf(seeded.runId)).toBe("failed");
    });

    it("loses the race to a live handler's write rather than winning it", async () => {
      // The case the fence exists for: a lease that has expired while its
      // handler is alive and mid-step. The sweep must lose, and it loses
      // structurally rather than by timing — it is ONE statement, so a
      // concurrent write that reaches the row first makes it block on the row
      // lock and then re-evaluate its whole WHERE against the version that
      // committed. A renewed lease fails the staleness test on that second look.
      const seeded = await claimedRun(-45 * 60);

      const handler = await pool.connect();
      try {
        await handler.query("begin");
        // What `beginStep` does at the top of every step, uncommitted.
        await handler.query(
          "update pipeline_runs set lease_expires_at = now() + interval '30 minutes', " +
            "current_step = 'writer', updated_at = now() where id = $1",
          [seeded.runId],
        );

        const sweeping = service.sweepAbandoned();
        // Long enough for the sweep to reach the row and block on the lock.
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(await statusOf(seeded.runId)).toBe("running");

        await handler.query("commit");
        await sweeping;
      } finally {
        handler.release();
      }

      expect(await statusOf(seeded.runId)).toBe("running");
    }, 30_000);

    it("does not overwrite a run another handler still holds — recordFailure is fenced", async () => {
      // A displaced handler's failure must not land on the run the winner is
      // still working. `recordFailure` is guarded on the fence AND on
      // `running`; drop either and A's verdict stamps B's live run, which is a
      // run killed at `failed` while its handler is mid-step and still spending.
      // A fresh, unclaimed run: `claim` is what puts it in `running`, exactly as
      // a delivery would, so the fence tokens below are the ones it really wrote.
      const seeded = await seed(1);
      const jobId = crypto.randomUUID();
      const fenceA = `${jobId}#${crypto.randomUUID()}`;
      const fenceB = `${jobId}#${crypto.randomUUID()}`;

      expect(await repo.claim(seeded.orgId, seeded.runId, fenceA, jobId)).toBeDefined();
      // The re-dispatch: same job id, later nonce, so B takes the run over.
      expect(await repo.claim(seeded.orgId, seeded.runId, fenceB, jobId)).toBeDefined();

      expect(await repo.recordFailure(seeded.orgId, seeded.runId, fenceA, "invalid_key")).toBe(
        "lost",
      );
      const row = await runRow(seeded.runId);
      expect(row?.status).toBe("running");
      expect(row?.error).toBeNull();
      expect(row?.activeJobId).toBe(fenceB);

      // And the winner's own write still lands, so the guard is a fence rather
      // than a wall.
      expect(await repo.recordFailure(seeded.orgId, seeded.runId, fenceB, "invalid_key")).toBe(
        "held",
      );
      expect((await runRow(seeded.runId))?.status).toBe("failed");
    });

    it("refuses a displaced handler's failure once the run is no longer running", async () => {
      // The other half of the same guard. A run the user cancelled, or one a
      // terminal write already finished, must not be reopened as `failed` by a
      // handler that is only now catching up — `cancelled` is the user's answer
      // and `succeeded` has a draft attached to it.
      const seeded = await seed(1);
      const jobId = crypto.randomUUID();
      const fence = `${jobId}#${crypto.randomUUID()}`;
      expect(await repo.claim(seeded.orgId, seeded.runId, fence, jobId)).toBeDefined();

      await db
        .update(schema.pipelineRuns)
        .set({ status: "cancelled" })
        .where(eq(schema.pipelineRuns.id, seeded.runId));

      expect(await repo.recordFailure(seeded.orgId, seeded.runId, fence, "internal")).toBe("lost");
      const row = await runRow(seeded.runId);
      expect(row?.status).toBe("cancelled");
      expect(row?.error).toBeNull();
    });
  });
});
