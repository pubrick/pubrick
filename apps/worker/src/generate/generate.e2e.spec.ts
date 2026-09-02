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
  let preferredCredential: typeof import("@pubrick/shared").preferredCredential;
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
    ({ eq } = await import("drizzle-orm"));
    ({ encryptJson, preferredCredential } = await import("@pubrick/shared"));

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
    const queueModule = (await import("../queue.service")) as { QueueService: QueueServiceCtor };

    // The real wiring, registered exactly the way main.ts does — only the queue
    // names and the model factory differ.
    repo = new GenerateRepository();
    const generate = new GenerateService(repo, () => active.model as never, 0);
    const publish = new PublishService(new PublishRepository());
    await new queueModule.QueueService(publish, generate).registerAll(boss, {
      publish: TEST_PUBLISH_QUEUE,
      publishDeadLetter: TEST_PUBLISH_DLQ,
      generate: TEST_GENERATE_QUEUE,
      generateDeadLetter: TEST_GENERATE_DLQ,
    });

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
});
