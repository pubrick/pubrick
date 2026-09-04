import { Logger } from "@nestjs/common";
import type { UsageRecord } from "@pubrick/ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { channelOf, type ScriptedUsage, scriptedModel } from "../test/scripted-model";

const url = process.env.TEST_DATABASE_URL;

// Type-only: nothing under "./generate.repository" (which imports "../db" and
// "../env", both validated/connected at module load) may be imported before
// beforeAll has set DATABASE_URL. Same reasoning as publish.e2e.spec.ts.
type GenerateRepositoryCtor = typeof import("./generate.repository").GenerateRepository;
type GenerateRepository = InstanceType<GenerateRepositoryCtor>;
type GenerateServiceCtor = typeof import("./generate.service").GenerateService;
type GenerateService = InstanceType<GenerateServiceCtor>;
type Schema = typeof import("@pubrick/db").schema;
type Db = Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
type Pool = Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];

const BRIEF = "BRIEF_MARKER announce the autumn menu";
const EDITED = "EDITED_MARKER the autumn menu lands on Monday.";

/** Lets one handler be pinned inside a model call while another one runs. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * The worker's generation handler, against a REAL database and a mock model.
 *
 * No pg-boss here — `generate.e2e.spec.ts` covers the queue wiring. What needs a
 * real Postgres is every claim in the design that is a SQL claim: that the fence
 * is a fence, that `updated_at` moves, that a lease is compared against the
 * database's clock and not the worker's, and that a deleted brand taking its run
 * with it is an ordinary outcome rather than a crash.
 *
 * Rows seeded here are never cleaned up, by the same convention as the sibling
 * specs: every run targets a fresh, disposable database.
 */
describe.skipIf(!url)("GenerateService (real DB + mock model)", () => {
  let db: Db;
  let pool: Pool;
  let workerPool: Pool;
  let schema: Schema;
  let eq: typeof import("drizzle-orm").eq;
  let sql: typeof import("drizzle-orm").sql;
  let encryptJson: typeof import("@pubrick/shared").encryptJson;
  /** The queue's own expiry — the number the lease is required to match. */
  let queueOptions: typeof import("@pubrick/shared").GENERATE_QUEUE_OPTIONS;
  let Repository: GenerateRepositoryCtor;
  let Service: GenerateServiceCtor;
  let seq = 0;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";

    const dbModule = await import("@pubrick/db");
    schema = dbModule.schema;
    ({ db, pool } = dbModule.createDb(url as string));
    ({ eq, sql } = await import("drizzle-orm"));
    ({ encryptJson, GENERATE_QUEUE_OPTIONS: queueOptions } = await import("@pubrick/shared"));
    ({ GenerateRepository: Repository } = await import("./generate.repository"));
    ({ GenerateService: Service } = await import("./generate.service"));
    workerPool = ((await import("../db")) as { pool: Pool }).pool;
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
  });

  type Seeded = {
    orgId: string;
    brandId: string;
    runId: string;
    channelIds: string[];
    channelNames: string[];
  };

  type SeedOptions = {
    channels?: number;
    credential?: boolean;
    /** Distinct per org where a test has to see WHOSE key was read. */
    apiKey?: string;
    defaultModel?: string;
    /** Distinct per org where a test has to see WHOSE brand was read. */
    brandName?: string;
  };

  async function seed(options: SeedOptions = {}): Promise<Seeded> {
    seq += 1;
    const stamp = `gen-${Date.now()}-${seq}`;
    const orgId = stamp;
    await db.insert(schema.organization).values({
      id: orgId,
      name: "Generate Spec Org",
      slug: stamp,
      createdAt: new Date(),
    });
    const [brand] = await db
      .insert(schema.brands)
      .values({
        orgId,
        name: options.brandName ?? "Kettle and Co",
        voice: "dry and concrete",
        audience: "independent cafe owners",
        contentLanguage: "en",
      })
      .returning({ id: schema.brands.id });
    const brandId = brand?.id as string;

    const channelIds: string[] = [];
    const channelNames: string[] = [];
    for (let i = 0; i < (options.channels ?? 2); i += 1) {
      const name = `Chan ${i}`;
      const [channel] = await db
        .insert(schema.channels)
        .values({
          orgId,
          brandId,
          platform: "telegram",
          name,
          credentialsEncrypted: encryptJson(
            { botToken: "123:abc", chatId: "-100" },
            process.env.APP_ENCRYPTION_KEY as string,
          ),
        })
        .returning({ id: schema.channels.id });
      channelIds.push(channel?.id as string);
      channelNames.push(name);
    }

    if (options.credential !== false) {
      await db.insert(schema.aiCredentials).values({
        orgId,
        provider: "google",
        credentialsEncrypted: encryptJson(
          { apiKey: options.apiKey ?? "test-key" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
        defaultModel: options.defaultModel ?? "gemini-3.7-flash",
      });
    }

    const [run] = await db
      .insert(schema.pipelineRuns)
      .values({ orgId, brandId, input: { kind: "brief", text: BRIEF, channelIds } })
      .returning({ id: schema.pipelineRuns.id });

    return { orgId, brandId, runId: run?.id as string, channelIds, channelNames };
  }

  /** The service, wired to a real repository and the given mock model. */
  function serviceFor(
    model: ReturnType<typeof scriptedModel>,
    repo: GenerateRepository = new Repository(),
  ): GenerateService {
    return new Service(repo, () => model.model as never, 0);
  }

  async function runRow(runId: string) {
    const [row] = await db
      .select()
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, runId));
    return row;
  }

  async function itemsOf(orgId: string) {
    return db.select().from(schema.contentItems).where(eq(schema.contentItems.orgId, orgId));
  }

  async function ledgerOf(orgId: string) {
    return db.select().from(schema.usageLedger).where(eq(schema.usageLedger.orgId, orgId));
  }

  /** Give the run to somebody else, with a lease that has NOT expired. */
  async function claimedByAnother(runId: string, fence: string) {
    await db
      .update(schema.pipelineRuns)
      .set({
        status: "running",
        activeJobId: fence,
        // Arithmetic in SQL, never a JavaScript Date: `lease_expires_at` is a
        // `timestamp` WITHOUT time zone, so a Date from a non-UTC test runner
        // would seed a lease hours away from the clock the fence compares it to
        // and this test would pass or fail by geography.
        leaseExpiresAt: sql`now() + interval '30 minutes'`,
      })
      .where(eq(schema.pipelineRuns.id, runId));
  }

  describe("the fence", () => {
    it("writes nothing and calls no model when another handler holds a live lease", async () => {
      const seeded = await seed();
      await claimedByAnother(seeded.runId, "another-job#1111");
      const script = scriptedModel();

      // Must not throw: a rethrow would make pg-boss retry a job that can only
      // lose the same race again.
      await expect(
        serviceFor(script).handle({
          id: "my-job",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();

      expect(script.calls).toHaveLength(0);
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
      expect(await ledgerOf(seeded.orgId)).toHaveLength(0);
      const run = await runRow(seeded.runId);
      expect(run?.steps).toEqual({});
      // The loser must not even touch the fence it failed to take.
      expect(run?.activeJobId).toBe("another-job#1111");
      expect(run?.status).toBe("running");
    }, 20_000);

    it("treats a run row that no longer exists as fence loss, not an error", async () => {
      const seeded = await seed();
      const script = scriptedModel();
      await db.delete(schema.pipelineRuns).where(eq(schema.pipelineRuns.id, seeded.runId));

      await expect(
        serviceFor(script).handle({
          id: "job-gone",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();
      expect(script.calls).toHaveLength(0);
    }, 20_000);

    it("stops mid-run when the brand is deleted under it, and keeps the spend record", async () => {
      // `DELETE /api/brands/:id` is an unconditional hard delete that cascades to
      // pipeline_runs. A step must never assume its own row still exists.
      const seeded = await seed();
      const script = scriptedModel({
        writer: async () => {
          await db.delete(schema.brands).where(eq(schema.brands.id, seeded.brandId));
          return { body: "A first draft." };
        },
      });

      await expect(
        serviceFor(script).handle({
          id: "job-cascade",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();

      expect(await runRow(seeded.runId)).toBeUndefined();
      expect(script.callsFor("editor")).toBe(0);
      // usage_ledger.run_id and channel_id are ON DELETE SET NULL exactly so the
      // record of money already spent outlives the brand — which is also why an
      // org's spend must never be summed through a join on either column. Two
      // rows, not one: the researcher's was written before the delete and had its
      // run_id nulled by the cascade, and the writer's was written AFTER it, when
      // the insert could no longer satisfy the foreign key at all. Both are
      // present, because a call the provider billed must leave a record whatever
      // happened to the run it belonged to.
      const ledger = await ledgerOf(seeded.orgId);
      expect(ledger).toHaveLength(2);
      expect(ledger.map((row) => row.step).sort()).toEqual(["researcher", "writer"]);
      expect(ledger.every((row) => row.runId === null)).toBe(true);
      expect(ledger.every((row) => row.costUsd !== null)).toBe(true);
    }, 20_000);

    it("lets a later delivery of the SAME pg-boss job take the run over, and stops the earlier one", async () => {
      // pg-boss's failJobs DELETEs a job row and re-INSERTs it under the SAME id,
      // so an expiry re-dispatch and the handler it is racing carry the identical
      // `job.id`. A fence written as `active_job_id = $jobId` would admit both,
      // and both would spend to the end. The per-delivery nonce is what makes the
      // newer delivery the owner.
      const seeded = await seed();
      const takeover = new Repository();
      const script = scriptedModel({
        writer: async () => {
          // A second delivery of job "job-same" claims the run mid-call.
          const claimed = await takeover.claim(
            seeded.orgId,
            seeded.runId,
            "job-same#second",
            "job-same",
          );
          expect(claimed).toBeDefined();
          return { body: "A first draft." };
        },
      });

      await expect(
        serviceFor(script).handle({
          id: "job-same",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();

      // The first handler paid for the call it had already started and then
      // stopped: no editor, no fact-check, no adaptations, no draft.
      expect(script.callsFor("editor")).toBe(0);
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
      const run = await runRow(seeded.runId);
      expect(run?.activeJobId).toBe("job-same#second");
      // Its checkpoint was refused too: the winner owns the checkpoint map.
      expect(Object.keys(run?.steps ?? {})).toEqual(["researcher"]);
    }, 20_000);

    it("refuses to re-run a finished run, so a redelivery cannot write a second draft", async () => {
      // The ambiguous-commit case in the open: the terminal write landed, and the
      // same job is delivered again. Nothing about the job id distinguishes this
      // from a legitimate retry — the run's own status is what does.
      const seeded = await seed();
      await serviceFor(scriptedModel()).handle({
        id: "job-twice",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      expect(await itemsOf(seeded.orgId)).toHaveLength(1);

      const second = scriptedModel();
      await expect(
        serviceFor(second).handle({
          id: "job-twice",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();

      expect(second.calls).toHaveLength(0);
      expect(await itemsOf(seeded.orgId)).toHaveLength(1);
    }, 25_000);

    it("does not let two OVERLAPPING deliveries of one job id both pay for the whole run", async () => {
      // The scenario the nonce exists for, driven through `handle` rather than
      // through the repository — so it pins the token `handle` MINTS, not one a
      // test handed it.
      //
      // Both handlers are alive at once and neither has finished, so the run is
      // still `running` and the claim's status guard cannot help; the terminal
      // write's guard still keeps the content item unique, so the damage is
      // invisible in every row and shows up only on the bill. Without the
      // per-delivery nonce both deliveries carry the identical token, every guard
      // admits both, and the first one pays for all five steps instead of one.
      const seeded = await seed({ channels: 1 });
      const firstInResearcher = deferred();
      const releaseFirst = deferred();
      const secondInWriter = deferred();
      const releaseSecond = deferred();

      const first = scriptedModel({
        researcher: async () => {
          firstInResearcher.resolve();
          await releaseFirst.promise;
          return { angle: "An angle", keyPoints: ["A key point"], avoid: [] };
        },
      });
      const second = scriptedModel({
        writer: async () => {
          secondInWriter.resolve();
          await releaseSecond.promise;
          return { body: "A second draft." };
        },
      });

      const job = { id: "job-nonce", data: { runId: seeded.runId, orgId: seeded.orgId } };
      const firstRun = serviceFor(first).handle(job);
      await firstInResearcher.promise;
      // A second delivery of the SAME job id — what pg-boss produces when a job
      // expires, because `failJobs` re-inserts the row under its original id.
      const secondRun = serviceFor(second).handle(job);
      await secondInWriter.promise;
      releaseFirst.resolve();
      await firstRun;
      releaseSecond.resolve();
      await secondRun;

      expect(first.calls.map((call) => call.role)).toEqual(["researcher"]);
      expect(await itemsOf(seeded.orgId)).toHaveLength(1);
    }, 30_000);

    it("re-takes the fence BEFORE the next model call, not only after it", async () => {
      // The takeover lands BETWEEN two steps, so the loser is not inside a model
      // call and its checkpoint write has already succeeded. Nothing but
      // `beginStep` can stop it before it buys the next step — delete that guard
      // and this handler pays for all five while the winner pays again.
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      const write = repo.writeCheckpoint.bind(repo);
      let takenOver = false;
      vi.spyOn(repo, "writeCheckpoint").mockImplementation(async (...args) => {
        const outcome = await write(...(args as Parameters<typeof write>));
        if (!takenOver) {
          takenOver = true;
          await new Repository().claim(seeded.orgId, seeded.runId, "job-pre#two", "job-pre");
        }
        return outcome;
      });

      const loser = scriptedModel();
      await serviceFor(loser, repo).handle({
        id: "job-pre",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      vi.restoreAllMocks();

      expect(loser.calls.map((call) => call.role)).toEqual(["researcher"]);
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
    }, 25_000);

    it("stops at the step boundary when pg-boss aborts the delivery", async () => {
      // `job.signal` is aborted at exactly the expiry that lets a second handler
      // be dispatched — `Manager#handleWork` wraps the handler in
      // `resolveWithinSeconds(…, expireInSeconds, ac)`, which stops waiting and
      // aborts but cannot stop the promise. It is earlier notice than the fence,
      // which stays ours until the re-dispatched handler actually claims.
      const seeded = await seed({ channels: 1 });
      const controller = new AbortController();
      const script = scriptedModel({
        researcher: () => {
          controller.abort();
          return { angle: "An angle", keyPoints: ["A key point"], avoid: [] };
        },
      });

      await expect(
        serviceFor(script).handle({
          id: "job-abort",
          data: { runId: seeded.runId, orgId: seeded.orgId },
          signal: controller.signal,
        }),
      ).resolves.toBeUndefined();

      expect(script.calls.map((call) => call.role)).toEqual(["researcher"]);
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
      // The step it DID pay for is checkpointed, so the retry resumes past it.
      expect(Object.keys((await runRow(seeded.runId))?.steps ?? {})).toEqual(["researcher"]);
      // And the run is left alone: the retry, not this delivery, decides its fate.
      expect((await runRow(seeded.runId))?.status).toBe("running");
    }, 25_000);
  });

  /**
   * The lease is the half of the fence that decides WHEN a run may be taken from
   * a handler that never said anything. `active_job_id` answers "is this still
   * mine"; `lease_expires_at` answers "has whoever holds it gone quiet long
   * enough that somebody else may have it" — the only thing standing between a
   * worker killed with `SIGKILL` and a run nobody can ever touch again.
   *
   * Everything here reads the timestamp PRODUCTION wrote. The fence tests above
   * seed a lease themselves, which pins the fixture: make `leaseExpiry()` return
   * a time in the past and every one of them still passes, while in production
   * every claim writes a dead lease and the first redelivery displaces a handler
   * that is mid-run.
   */
  describe("the lease", () => {
    /** Seconds until the lease lapses, measured by the DATABASE's clock. */
    async function leaseSecondsLeft(runId: string): Promise<number> {
      const rows = await db.execute<{ left: string }>(
        sql`select extract(epoch from (${schema.pipelineRuns.leaseExpiresAt} - now())) as left
            from ${schema.pipelineRuns} where ${eq(schema.pipelineRuns.id, runId)}`,
      );
      return Number(rows.rows[0]?.left ?? Number.NaN);
    }

    /** Wind the lease down to almost nothing, the way a long step would. */
    async function ageLease(runId: string) {
      await db
        .update(schema.pipelineRuns)
        .set({ leaseExpiresAt: sql`now() + interval '10 seconds'` })
        .where(eq(schema.pipelineRuns.id, runId));
    }

    const checkpoint = {
      status: "succeeded" as const,
      output: { body: "x" },
      usage: [],
      finishedAt: "",
    };

    it("claims for exactly as long as pg-boss will wait before re-dispatching", async () => {
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      expect(
        await repo.claim(seeded.orgId, seeded.runId, "job-lease#1", "job-lease"),
      ).toBeDefined();

      // Compared against the QUEUE's number, not a literal 1800: the lease and
      // `expireInSeconds` are two names for one moment — the instant pg-boss is
      // willing to hand the run to somebody else — and this is what stops them
      // from being two hand-maintained copies that drift.
      const left = await leaseSecondsLeft(seeded.runId);
      expect(left).toBeGreaterThan(queueOptions.expireInSeconds - 60);
      expect(left).toBeLessThanOrEqual(queueOptions.expireInSeconds);
    }, 20_000);

    it("renews on every fenced write, so a long run is never displaced by its own age", async () => {
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      const fence = "job-renew#1";
      expect(await repo.claim(seeded.orgId, seeded.runId, fence, "job-renew")).toBeDefined();

      // Without the renewal a run whose steps take longer than one lease would
      // lose itself to the next redelivery while still working — and pay twice.
      await ageLease(seeded.runId);
      expect(await repo.beginStep(seeded.orgId, seeded.runId, fence, "writer")).toBe(true);
      expect(await leaseSecondsLeft(seeded.runId)).toBeGreaterThan(
        queueOptions.expireInSeconds - 60,
      );

      await ageLease(seeded.runId);
      expect(
        await repo.writeCheckpoint(seeded.orgId, seeded.runId, fence, "writer", checkpoint),
      ).toBe("held");
      expect(await leaseSecondsLeft(seeded.runId)).toBeGreaterThan(
        queueOptions.expireInSeconds - 60,
      );
    }, 20_000);

    it("refuses a DIFFERENT job's claim while the lease a real claim wrote is live", async () => {
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      expect(await repo.claim(seeded.orgId, seeded.runId, "job-live#1", "job-live")).toBeDefined();

      // Not the same job re-delivered — a different job entirely, which may only
      // have the run once the holder's lease has lapsed. A lease already dead
      // when it was written admits this claim instantly.
      expect(
        await repo.claim(seeded.orgId, seeded.runId, "other-job#1", "other-job"),
      ).toBeUndefined();
      expect((await runRow(seeded.runId))?.activeJobId).toBe("job-live#1");

      // And once it HAS lapsed, the run is takeable — otherwise a killed worker
      // would strand it forever.
      await db
        .update(schema.pipelineRuns)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(schema.pipelineRuns.id, seeded.runId));
      expect(
        await repo.claim(seeded.orgId, seeded.runId, "other-job#1", "other-job"),
      ).toBeDefined();
    }, 20_000);
  });

  /**
   * Two organizations, one worker, one database.
   *
   * Every method here takes `orgId` first and every statement carries it, but
   * with a single-org fixture that predicate can be deleted from any of them and
   * the whole suite stays green — the run id is a UUID, so nothing else in the
   * test notices. `credential` is the one where the org predicate is the ONLY
   * thing selecting the row: lose it and a run is paid for with whichever key
   * happens to be oldest in the table, which is another org's money.
   */
  describe("org scoping", () => {
    const VICTIM_KEY = "victim-key";
    const INTRUDER_KEY = "intruder-key";

    /** The victim is seeded FIRST, so it owns the older credential row. */
    async function twoOrgs() {
      const victim = await seed({
        channels: 1,
        apiKey: VICTIM_KEY,
        defaultModel: "gemini-3.7-flash",
        brandName: "Victim Coffee",
      });
      const intruder = await seed({
        channels: 1,
        apiKey: INTRUDER_KEY,
        defaultModel: "gemini-3.6-pro",
        brandName: "Intruder Tea",
      });
      return { victim, intruder };
    }

    const checkpoint = {
      status: "succeeded" as const,
      output: { body: "x" },
      usage: [],
      finishedAt: "",
    };

    it("cannot claim, begin, checkpoint, fail or exhaust another org's run", async () => {
      const { victim, intruder } = await twoOrgs();
      const repo = new Repository();

      expect(
        await repo.claim(intruder.orgId, victim.runId, "job-cross#1", "job-cross"),
      ).toBeUndefined();
      // The same call with the right org succeeds, so the refusal above was
      // about the org and not about some unrelated predicate being broken.
      expect(await repo.claim(victim.orgId, victim.runId, "job-own#1", "job-own")).toBeDefined();

      const fence = "job-own#1";
      expect(await repo.beginStep(intruder.orgId, victim.runId, fence, "editor")).toBe(false);
      // "gone", not "lost": the run row is invisible to the wrong org, so the
      // locking SELECT never finds it and the UPDATE is never reached.
      expect(
        await repo.writeCheckpoint(intruder.orgId, victim.runId, fence, "editor", checkpoint),
      ).toBe("gone");
      expect(await repo.explain(intruder.orgId, victim.runId, fence)).toBe("gone");
      expect(await repo.recordFailure(intruder.orgId, victim.runId, fence, "internal")).toBe(
        "lost",
      );
      await repo.recordTransient(intruder.orgId, victim.runId, fence, "internal");
      expect(await repo.markExhausted(intruder.orgId, victim.runId, "internal")).toBe(false);

      // Nothing the intruder did left a mark of any kind.
      const run = await runRow(victim.runId);
      expect(run?.status).toBe("running");
      expect(run?.activeJobId).toBe(fence);
      expect(run?.currentStep).toBeNull();
      expect(run?.error).toBeNull();
      expect(run?.steps).toEqual({});
    }, 25_000);

    it("never reads another org's brand or channels into a run's prompt", async () => {
      const { victim, intruder } = await twoOrgs();
      const repo = new Repository();

      // The brand carries the voice and audience that become the run's
      // instructions; reading it across orgs puts one org's positioning into
      // another org's post.
      expect(await repo.context(intruder.orgId, victim.brandId, victim.channelIds)).toBeUndefined();

      const own = await repo.context(victim.orgId, victim.brandId, [
        ...victim.channelIds,
        ...intruder.channelIds,
      ]);
      expect(own?.brand.name).toBe("Victim Coffee");
      // The channel list is scoped by brand as well as org — the brand predicate
      // alone would already exclude these — so this pins the pair, not either
      // predicate on its own.
      expect(own?.channels.map((channel) => channel.id)).toEqual(victim.channelIds);
    }, 25_000);

    it("spends the run's OWN org's provider key, never the oldest key in the table", async () => {
      const { victim, intruder } = await twoOrgs();
      const repo = new Repository();

      // `credential` is keyed by org and NOTHING else, ordered oldest-first: drop
      // the predicate and every run in the database bills the first key ever
      // configured, in an org that never asked for it.
      expect(await repo.credential(victim.orgId)).toMatchObject({
        apiKey: VICTIM_KEY,
        defaultModel: "gemini-3.7-flash",
      });
      expect(await repo.credential(intruder.orgId)).toMatchObject({
        apiKey: INTRUDER_KEY,
        defaultModel: "gemini-3.6-pro",
      });
    }, 25_000);

    it("writes no draft against another org's run", async () => {
      const { victim, intruder } = await twoOrgs();
      const repo = new Repository();
      const fence = "job-cross-finish#1";
      expect(await repo.claim(victim.orgId, victim.runId, fence, "job-cross-finish")).toBeDefined();

      const outcome = await repo.finish(intruder.orgId, victim.runId, fence, victim.brandId, {
        body: "A draft nobody asked for.",
        adaptations: [{ channelId: victim.channelIds[0] as string, body: "An adaptation." }],
      });
      // Stops at the locking SELECT — the run does not exist for this org. (The
      // org predicate on the terminal UPDATE itself is redundant while that lock
      // is held, and is kept as the belt to this transaction's braces.)
      expect(outcome).toBe("gone");
      expect(await itemsOf(victim.orgId)).toHaveLength(0);
      expect(await itemsOf(intruder.orgId)).toHaveLength(0);
      expect((await runRow(victim.runId))?.status).toBe("running");
    }, 25_000);

    it("does nothing, and bills nobody, for a job that names the wrong org", async () => {
      // The whole cross-tenant path in one call: a job payload pairing one org's
      // id with another org's run. The claim is what refuses it, and everything
      // downstream — the brand it would have read, the KEY it would have spent —
      // is never reached.
      const { victim, intruder } = await twoOrgs();
      const script = scriptedModel();

      await expect(
        serviceFor(script).handle({
          id: "job-tenant",
          data: { runId: victim.runId, orgId: intruder.orgId },
        }),
      ).resolves.toBeUndefined();

      expect(script.calls).toHaveLength(0);
      expect(await ledgerOf(intruder.orgId)).toHaveLength(0);
      expect(await ledgerOf(victim.orgId)).toHaveLength(0);
      expect(await itemsOf(victim.orgId)).toHaveLength(0);
      const run = await runRow(victim.runId);
      expect(run?.status).toBe("queued");
      expect(run?.activeJobId).toBeNull();
    }, 25_000);
  });

  describe("checkpoints", () => {
    it("skips a checkpointed step without invoking its model again", async () => {
      const seeded = await seed({ channels: 1 });
      const CHECKPOINTED = "CHECKPOINT_MARKER a draft written on the first attempt.";
      await db
        .update(schema.pipelineRuns)
        .set({
          steps: {
            researcher: {
              status: "succeeded",
              output: { angle: "An angle", keyPoints: ["A key point"], avoid: [] },
            },
            writer: { status: "succeeded", output: { body: CHECKPOINTED } },
          },
        })
        .where(eq(schema.pipelineRuns.id, seeded.runId));

      const script = scriptedModel();
      await serviceFor(script).handle({
        id: "job-resume",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      // The assertion that matters is the CALL COUNT, not the output: an
      // implementation that re-ran the writer and happened to get the same answer
      // would look identical from the outside and cost the org a call.
      expect(script.callsFor("researcher")).toBe(0);
      expect(script.callsFor("writer")).toBe(0);
      expect(script.callsFor("editor")).toBe(1);
      // And the checkpointed VALUE was the one carried forward.
      expect(script.calls.find((call) => call.role === "editor")?.user).toContain(CHECKPOINTED);
    }, 25_000);

    it("re-runs a step whose stored output no longer matches its schema", async () => {
      // A cache that cannot be read is a cache miss. Failing the run instead
      // would brick every in-flight run on the deploy that changed a schema.
      const seeded = await seed({ channels: 1 });
      await db
        .update(schema.pipelineRuns)
        .set({ steps: { writer: { status: "succeeded", output: { headline: "wrong shape" } } } })
        .where(eq(schema.pipelineRuns.id, seeded.runId));

      const script = scriptedModel();
      await serviceFor(script).handle({
        id: "job-badckpt",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      expect(script.callsFor("writer")).toBe(1);
      expect((await runRow(seeded.runId))?.status).toBe("succeeded");
    }, 25_000);

    it("stamps updated_at from the DATABASE clock on every checkpoint write", async () => {
      // Asserting only that the timestamp ADVANCES cannot fail: these are
      // query-builder updates, so deleting `updatedAt: now()` just lets drizzle's
      // `$onUpdate` fire and the value moves anyway. What actually differs is
      // WHOSE clock wrote it. `now()` has microsecond resolution; a JavaScript
      // `Date` has milliseconds and is serialised with three fractional digits,
      // so `$onUpdate` can only ever store a sub-millisecond remainder of zero —
      // which is also why it is the wrong writer for a `timestamp` WITHOUT time
      // zone column read back against `now()` on a non-UTC deployment.
      //
      // node-postgres parses the column into a millisecond `Date`, so the digits
      // that carry the proof have to be extracted in SQL.
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      const fence = "job-clock#1";
      expect(await repo.claim(seeded.orgId, seeded.runId, fence, "job-clock")).toBeDefined();

      const checkpoint = {
        status: "succeeded" as const,
        output: { body: "x" },
        usage: [],
        finishedAt: "",
      };
      const subMillisecond = async () => {
        const rows = await db.execute<{ sub: number }>(
          sql`select (extract(microseconds from ${schema.pipelineRuns.updatedAt})::int % 1000) as sub
              from ${schema.pipelineRuns} where ${eq(schema.pipelineRuns.id, seeded.runId)}`,
        );
        return Number(rows.rows[0]?.sub ?? 0);
      };

      await repo.writeCheckpoint(seeded.orgId, seeded.runId, fence, "one", checkpoint);
      const first = (await runRow(seeded.runId))?.updatedAt as Date;
      const firstSub = await subMillisecond();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await repo.writeCheckpoint(seeded.orgId, seeded.runId, fence, "two", checkpoint);
      const second = (await runRow(seeded.runId))?.updatedAt as Date;
      const secondSub = await subMillisecond();

      expect(second.getTime()).toBeGreaterThan(first.getTime());
      // Two samples: `now()` lands exactly on a millisecond boundary about one
      // time in a thousand, so requiring BOTH to be non-zero would flake, while
      // requiring neither proves nothing. One in a million is the failure rate of
      // this form, and a client-written Date makes it certain.
      expect([firstSub, secondSub].some((sub) => sub !== 0)).toBe(true);
      // And the second write composed with the first rather than replacing it.
      expect(Object.keys((await runRow(seeded.runId))?.steps ?? {}).sort()).toEqual(["one", "two"]);
    }, 20_000);
  });

  describe("cancellation", () => {
    it("stops before the next model call and leaves the spend on the record", async () => {
      const seeded = await seed();
      const script = scriptedModel({
        writer: async () => {
          // What `POST /api/runs/:id/cancel` writes, minus the job cancellation
          // (there is no queue in this spec). A job already fetched still reaches
          // the handler, which is exactly the case this covers.
          await db
            .update(schema.pipelineRuns)
            .set({ status: "cancelled" })
            .where(eq(schema.pipelineRuns.id, seeded.runId));
          return { body: "A first draft." };
        },
      });

      await expect(
        serviceFor(script).handle({
          id: "job-cancel",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();

      expect(script.callsFor("editor")).toBe(0);
      expect(script.callsFor("adapter")).toBe(0);
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("cancelled");
      // Ledger rows already written are KEPT and still displayed: the money was
      // spent, and a cancellation that erased the record would misreport the bill.
      expect(await ledgerOf(seeded.orgId)).toHaveLength(2);
    }, 20_000);

    it("stops before the next paid call when the cancel lands BETWEEN two steps", async () => {
      // The other cancellation test cancels DURING a model call, where the
      // checkpoint write also refuses and would stop the run on its own. Here the
      // checkpoint lands first and the user presses Cancel a moment later, so the
      // only thing standing between them and a call they already refused is
      // `beginStep`'s status guard.
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      const write = repo.writeCheckpoint.bind(repo);
      let cancelled = false;
      vi.spyOn(repo, "writeCheckpoint").mockImplementation(async (...args) => {
        const outcome = await write(...(args as Parameters<typeof write>));
        if (!cancelled) {
          cancelled = true;
          await db
            .update(schema.pipelineRuns)
            .set({ status: "cancelled" })
            .where(eq(schema.pipelineRuns.id, seeded.runId));
        }
        return outcome;
      });

      const script = scriptedModel();
      await serviceFor(script, repo).handle({
        id: "job-cancel-between",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      vi.restoreAllMocks();

      expect(script.calls.map((call) => call.role)).toEqual(["researcher"]);
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
      expect((await runRow(seeded.runId))?.status).toBe("cancelled");
    }, 25_000);

    it("does not resurrect a run cancelled before its job was ever delivered", async () => {
      const seeded = await seed();
      await db
        .update(schema.pipelineRuns)
        .set({ status: "cancelled" })
        .where(eq(schema.pipelineRuns.id, seeded.runId));

      const script = scriptedModel();
      await serviceFor(script).handle({
        id: "job-late",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      expect(script.calls).toHaveLength(0);
      expect((await runRow(seeded.runId))?.status).toBe("cancelled");
    }, 20_000);
  });

  describe("failure", () => {
    it("records a permanent failure and returns normally, so the job completes", async () => {
      const seeded = await seed({ credential: false });
      const script = scriptedModel();

      await expect(
        serviceFor(script).handle({
          id: "job-nokey",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();

      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("failed");
      // A code the four locales can translate, not a provider 401 in English.
      expect(run?.error).toBe("no_api_key");
      expect(script.calls).toHaveLength(0);
    }, 20_000);

    it("fails the run permanently when the model cannot satisfy a schema twice", async () => {
      const seeded = await seed({ channels: 1 });
      const script = scriptedModel({ writer: () => "not json at all" });

      await expect(
        serviceFor(script).handle({
          id: "job-schema",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();

      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("no_structured_output");
      // One repair retry, then permanent — never a third paid call.
      expect(script.callsFor("writer")).toBe(2);
    }, 25_000);

    it("rethrows an unclassified failure so pg-boss retries from the last checkpoint", async () => {
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      vi.spyOn(repo, "writeCheckpoint").mockRejectedValueOnce(
        new Error("Connection terminated unexpectedly"),
      );
      const script = scriptedModel();

      await expect(
        serviceFor(script, repo).handle({
          id: "job-flaky",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).rejects.toThrow("Connection terminated unexpectedly");

      const run = await runRow(seeded.runId);
      // Status untouched: a retry is coming, and only a PERMANENT error may write
      // a terminal status.
      expect(run?.status).toBe("running");
      // The database's own words are not the provider's, but they are still
      // prose on a path that ends in a browser: the row gets the generic code
      // and the sentence goes to the log.
      expect(run?.error).toBe("internal");
      vi.restoreAllMocks();
    }, 20_000);

    it("reports a stored key that will not decrypt as its own code, not as a crypto stack", async () => {
      // The key predates a rotated APP_ENCRYPTION_KEY, or the row was tampered
      // with. Deterministic, so permanent — and a verdict about the KEY, which
      // is why it gets a code of its own rather than the generic one.
      const seeded = await seed({ channels: 1 });
      const otherKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
      await db
        .update(schema.aiCredentials)
        .set({ credentialsEncrypted: encryptJson({ apiKey: "unreadable" }, otherKey) })
        .where(eq(schema.aiCredentials.orgId, seeded.orgId));
      const script = scriptedModel();

      await serviceFor(script).handle({
        id: "job-badkey",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("unreadable_key");
      expect(script.calls).toHaveLength(0);
    }, 20_000);

    it("reports a stored blob that opens but holds no API key as unreadable_key too — with the ring cleared, not blamed", async () => {
      // Same code on the strip, because the reader's sentence ("could not be
      // read, save it again") is true and the remedy is the same. The log line
      // is where it differs: it must say the ring is fine, not send an operator
      // to rotate a key that opened this very blob.
      const seeded = await seed({ channels: 1 });
      await db
        .update(schema.aiCredentials)
        .set({
          credentialsEncrypted: encryptJson(
            { token: "not-an-api-key" },
            process.env.APP_ENCRYPTION_KEY as string,
          ),
        })
        .where(eq(schema.aiCredentials.orgId, seeded.orgId));
      const script = scriptedModel();
      const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});

      await serviceFor(script).handle({
        id: "job-badshape",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("unreadable_key");
      expect(script.calls).toHaveLength(0);
      const logged = errorLog.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("do not hold an API key");
      expect(logged).toContain("The encryption key is fine");
      expect(logged).not.toContain("Add the old key to APP_ENCRYPTION_KEY");
      vi.restoreAllMocks();
    }, 20_000);

    it("does not call a decrypt that threw for some other reason a verdict about the key", async () => {
      // The only plain `Error` the decrypt can throw is a ring that does not
      // parse — impossible past boot, so it stands in for a bug in the decrypt
      // code. That is a broken instance: `internal`, transient, retried — the
      // treatment every unclassified throw gets — and NOT a permanent
      // `unreadable_key` that would tell the user their key is the problem.
      const seeded = await seed({ channels: 1 });
      const script = scriptedModel();
      const workerEnv = ((await import("../env")) as { env: { APP_ENCRYPTION_KEY: string } }).env;
      const ring = workerEnv.APP_ENCRYPTION_KEY;
      workerEnv.APP_ENCRYPTION_KEY = "not-a-ring";
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      try {
        await expect(
          serviceFor(script).handle({
            id: "job-badring",
            data: { runId: seeded.runId, orgId: seeded.orgId },
          }),
        ).rejects.toThrow("Encryption key must decode to exactly 32 bytes");
      } finally {
        workerEnv.APP_ENCRYPTION_KEY = ring;
        vi.restoreAllMocks();
      }

      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("running");
      expect(run?.error).toBe("internal");
      expect(script.calls).toHaveLength(0);
      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).not.toContain("unreadable_key");
    }, 20_000);

    it("fails a run whose channels have all been deleted rather than writing a draft nobody can publish", async () => {
      const seeded = await seed({ channels: 1 });
      await db.delete(schema.channels).where(eq(schema.channels.brandId, seeded.brandId));
      const script = scriptedModel();

      await serviceFor(script).handle({
        id: "job-nochan",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("every_channel_deleted");
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
      // AND NOT A SINGLE MODEL CALL. Without the refusal in `loadContext` the
      // run researches, writes, edits and fact-checks — four paid calls — and
      // only discovers at the terminal write that there is nowhere to publish
      // to, ending in this same status with this same code. The terminal
      // assertions above are all satisfied either way, which is exactly why the
      // early refusal could be deleted with every test still green.
      expect(script.calls).toHaveLength(0);
      expect(await ledgerOf(seeded.orgId)).toHaveLength(0);
    }, 20_000);
  });

  /**
   * The reviewer's probe, kept as a test.
   *
   * A provider's own error prose used to be written into `pipeline_runs.error`
   * verbatim — on the permanent arm and, once per retry, on the transient one —
   * and `RUN_COLUMNS` hands that column to the browser. OpenAI-style bodies
   * quote the submitted credential back ("Incorrect API key provided: sk-…")
   * and Google's quota errors quote the request URL, which carries `?key=`. So
   * the mock model throws exactly that, with the org's REAL seeded key inside
   * it, and the run row is read back raw.
   */
  describe("a provider's own error prose", () => {
    const LIVE_KEY = "sk-live-51PROBEkeyMUSTNOTLEAK0987654321";

    async function keyBearingModel(statusCode: number, isRetryable: boolean) {
      const { APICallError } = await import("ai");
      return scriptedModel({
        researcher: () => {
          throw new APICallError({
            // The two shapes a real 4xx body takes, in one string.
            message:
              `Incorrect API key provided: ${LIVE_KEY}. ` +
              `You can find your API key at https://generativelanguage.googleapis.com/v1beta/models:generateContent?key=${LIVE_KEY}`,
            url: `https://generativelanguage.googleapis.com/v1beta/models:generateContent?key=${LIVE_KEY}`,
            requestBodyValues: {},
            statusCode,
            isRetryable,
          });
        },
      });
    }

    it("never reaches pipeline_runs.error on the permanent (401) arm", async () => {
      const seeded = await seed({ channels: 1, apiKey: LIVE_KEY });
      const script = await keyBearingModel(401, false);

      await expect(
        serviceFor(script).handle({
          id: "job-leak-401",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();

      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("failed");
      expect(run?.error ?? "").not.toContain(LIVE_KEY);
      expect(run?.error ?? "").not.toContain("Incorrect API key provided");
      expect(run?.error ?? "").not.toContain("?key=");
    }, 25_000);

    it("never reaches pipeline_runs.error on the transient (429) arm, on any retry", async () => {
      const seeded = await seed({ channels: 1, apiKey: LIVE_KEY });
      const script = await keyBearingModel(429, true);

      await expect(
        serviceFor(script).handle({
          id: "job-leak-429",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).rejects.toThrow();

      const run = await runRow(seeded.runId);
      // Still running — a transient error records a reason without a verdict.
      expect(run?.status).toBe("running");
      expect(run?.error ?? "").not.toContain(LIVE_KEY);
      expect(run?.error ?? "").not.toContain("Incorrect API key provided");
      expect(run?.error ?? "").not.toContain("?key=");
      expect(run?.error).toBe("rate_limited");
    }, 40_000);

    it("stores the code and puts the provider's sentence in the log instead", async () => {
      const seeded = await seed({ channels: 1, apiKey: LIVE_KEY });
      const script = await keyBearingModel(401, false);
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

      await serviceFor(script).handle({
        id: "job-leak-log",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      // The prose is not thrown away — an operator needs to know WHICH 401 —
      // it is moved to the one place a customer's browser cannot reach.
      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("invalid_key");
      expect(logged).toContain("Incorrect API key provided");
      expect(logged).not.toContain(LIVE_KEY);
      expect((await runRow(seeded.runId))?.error).toBe("invalid_key");
      vi.restoreAllMocks();
    }, 25_000);

    it("takes the org's own key out of the log even when it looks like nothing", async () => {
      // The patterns in `redactSecrets` catch `sk-…`, `AIza…`, `?key=` and
      // `Bearer …`. A key of some other shape is caught only by the literal
      // pass, which needs the decrypted credential — which lives one stack frame
      // below the catch that writes the log line. This test is what says that
      // frame still hands it over.
      const QUIET_KEY = "9f3c-quiet-looking-credential-42";
      const { APICallError } = await import("ai");
      const seeded = await seed({ channels: 1, apiKey: QUIET_KEY });
      const script = scriptedModel({
        researcher: () => {
          throw new APICallError({
            message: `the key ${QUIET_KEY} is not authorized for this model`,
            url: "https://example.invalid/v1",
            requestBodyValues: {},
            statusCode: 403,
          });
        },
      });
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

      await serviceFor(script).handle({
        id: "job-leak-quiet",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("is not authorized for this model");
      expect(logged).not.toContain(QUIET_KEY);
      expect(logged).toContain("***");
      expect((await runRow(seeded.runId))?.error).toBe("invalid_key");
      vi.restoreAllMocks();
    }, 25_000);
  });

  describe("the DLQ consumer", () => {
    it("fails a run whose retries ran out, from queued as well as running", async () => {
      const queued = await seed({ channels: 1 });
      const running = await seed({ channels: 1 });
      await db
        .update(schema.pipelineRuns)
        .set({ status: "running" })
        .where(eq(schema.pipelineRuns.id, running.runId));

      const service = serviceFor(scriptedModel());
      await service.markExhausted({ runId: queued.runId, orgId: queued.orgId });
      await service.markExhausted({ runId: running.runId, orgId: running.orgId });

      // `queued` is included on purpose: a delivery that died before it could
      // claim leaves the run there, and it is exactly the run with no job, no
      // handler and no other way out of the strip.
      expect((await runRow(queued.runId))?.status).toBe("failed");
      expect((await runRow(running.runId))?.status).toBe("failed");
      expect((await runRow(queued.runId))?.error).toBe("retries_exhausted");
      expect((await runRow(running.runId))?.error).toBe("retries_exhausted");
    }, 20_000);

    it("leaves a run that already finished alone", async () => {
      const seeded = await seed({ channels: 1 });
      await serviceFor(scriptedModel()).handle({
        id: "job-done",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      await serviceFor(scriptedModel()).markExhausted({
        runId: seeded.runId,
        orgId: seeded.orgId,
      });

      expect((await runRow(seeded.runId))?.status).toBe("succeeded");
    }, 25_000);
  });

  describe("the terminal write", () => {
    it("writes ONE draft when a re-dispatch finishes the run while the first handler stalls", async () => {
      // The race the re-check under `FOR UPDATE` exists for, and the one thing
      // no other test in this file can reach: every other takeover is caught at
      // the NEXT step boundary by `beginStep`, and after the last adapter there
      // is no next step boundary — only `finish()`.
      //
      // H1 writes its last checkpoint and then stalls (a GC pause, a slow
      // socket) for longer than pg-boss is willing to wait. The job is
      // re-dispatched; H2 claims with a fresh nonce, resumes all five steps H1
      // already paid for, and commits the draft. H1 wakes up and walks into the
      // terminal write holding a fence that is no longer the run's.
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      const write = repo.writeCheckpoint.bind(repo);
      const second = scriptedModel();
      let redispatched = false;
      vi.spyOn(repo, "writeCheckpoint").mockImplementation(async (...args) => {
        const outcome = await write(...(args as Parameters<typeof write>));
        // Only after the adapter's checkpoint — from there H1 goes straight to
        // `finish()`. The real write is awaited FIRST, so H1 genuinely holds a
        // complete checkpoint map before it is overtaken.
        if (!redispatched && String(args[3]).startsWith("adapter:")) {
          redispatched = true;
          await serviceFor(second).handle({
            id: "job-terminal",
            data: { runId: seeded.runId, orgId: seeded.orgId },
          });
        }
        return outcome;
      });

      const first = scriptedModel();
      await expect(
        serviceFor(first, repo).handle({
          id: "job-terminal",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();
      vi.restoreAllMocks();

      // H1 paid for all five steps; H2 paid for none, because every one of them
      // was checkpointed. That is the shape of a real expiry re-dispatch.
      expect(first.calls).toHaveLength(5);
      expect(second.calls).toHaveLength(0);

      // ONE content item. Remove the run's status/fence re-check under the lock
      // AND the same predicates from the final UPDATE, and H1 inserts a second
      // draft here — with its own adaptations and its own `ai` version rows —
      // for a run that already has one, which is the duplicate the whole fence
      // exists to prevent.
      const items = await itemsOf(seeded.orgId);
      expect(items).toHaveLength(1);
      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("succeeded");
      expect(run?.contentItemId).toBe(items[0]?.id);
      expect(
        await db
          .select()
          .from(schema.adaptations)
          .where(eq(schema.adaptations.orgId, seeded.orgId)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(schema.contentVersions)
          .where(eq(schema.contentVersions.orgId, seeded.orgId)),
      ).toHaveLength(2);
    }, 30_000);

    it("tells a stale fence apart from a finished run, and writes for neither", async () => {
      // The two halves of the same guard, at the repository, where the outcome
      // is visible: `lost` while another handler is still working the run, and
      // `finished` once that handler has committed. Both are ordinary — they are
      // logged and returned, never thrown — but they are not the same event, and
      // an implementation that reached the INSERT before finding out would have
      // written a second draft in both cases.
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      expect(
        await repo.claim(seeded.orgId, seeded.runId, "job-stale#one", "job-stale"),
      ).toBeDefined();
      // A later delivery of the same job takes the run over.
      expect(
        await repo.claim(seeded.orgId, seeded.runId, "job-stale#two", "job-stale"),
      ).toBeDefined();

      const payload = {
        body: "A draft.",
        adaptations: [{ channelId: seeded.channelIds[0] as string, body: "An adaptation." }],
      };

      expect(
        await repo.finish(seeded.orgId, seeded.runId, "job-stale#one", seeded.brandId, payload),
      ).toBe("lost");
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);

      expect(
        await repo.finish(seeded.orgId, seeded.runId, "job-stale#two", seeded.brandId, payload),
      ).toBe("held");
      // Now it is the run's STATUS, not the fence, that refuses the loser — the
      // ambiguous-commit case, where a handler cannot tell whether its own
      // transaction landed.
      expect(
        await repo.finish(seeded.orgId, seeded.runId, "job-stale#one", seeded.brandId, payload),
      ).toBe("finished");
      expect(await itemsOf(seeded.orgId)).toHaveLength(1);
    }, 25_000);

    it("writes the draft, its adaptations and the first ai version of each", async () => {
      const seeded = await seed({ channels: 2 });
      const script = scriptedModel({
        editor: () => ({ body: EDITED, changes: ["Tightened the opening."] }),
      });

      await serviceFor(script).handle({
        id: "job-happy",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      const items = await itemsOf(seeded.orgId);
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item).toMatchObject({ body: EDITED, status: "draft", origin: "ai" });
      // Nobody has opened it, which is half of the refusal to publish text no
      // human has read.
      expect(item?.firstOpenedAt).toBeNull();

      const adaptations = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.contentItemId, item?.id as string));
      expect(adaptations).toHaveLength(2);
      // `adaptations.origin` DEFAULTS to `human`; a worker that forgot to set it
      // would leave the publish gate open on text no human ever read.
      expect(adaptations.every((row) => row.origin === "ai")).toBe(true);
      expect(adaptations.every((row) => row.status === "pending")).toBe(true);
      expect(new Set(adaptations.map((row) => row.channelId))).toEqual(new Set(seeded.channelIds));

      const versions = await db
        .select()
        .from(schema.contentVersions)
        .where(eq(schema.contentVersions.contentItemId, item?.id as string));
      expect(versions).toHaveLength(3);
      const master = versions.filter((row) => row.adaptationId === null);
      expect(master).toHaveLength(1);
      expect(master[0]).toMatchObject({ body: EDITED, origin: "ai", runId: seeded.runId });
      for (const adaptation of adaptations) {
        const version = versions.find((row) => row.adaptationId === adaptation.id);
        expect(version?.body).toBe(adaptation.body);
        expect(version?.origin).toBe("ai");
      }

      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("succeeded");
      expect(run?.contentItemId).toBe(item?.id);
      expect(run?.currentStep).toBeNull();
      expect(run?.error).toBeNull();
      expect(Object.keys(run?.steps ?? {}).sort()).toEqual(
        [
          "editor",
          "factcheck",
          "researcher",
          "writer",
          ...seeded.channelIds.map((id) => `adapter:${id}`),
        ].sort(),
      );
      // One adapter call per channel, and each got its own channel's identity.
      expect(script.adaptedChannels().sort()).toEqual([...seeded.channelNames].sort());
    }, 30_000);

    it("survives a channel deleted mid-run, writing the draft for the ones that remain", async () => {
      // `adaptations.channel_id` is NOT NULL and the run's channel list is a
      // snapshot taken minutes earlier, so a channel deleted while the run worked
      // used to kill the terminal transaction with a foreign-key violation, three
      // times over, and throw a fully paid five-step run away.
      const seeded = await seed({ channels: 2 });
      const doomed = seeded.channelIds[0] as string;
      const script = scriptedModel({
        factcheck: async () => {
          // After the fan-out list was resolved, before the terminal write.
          await db.delete(schema.channels).where(eq(schema.channels.id, doomed));
          return { claims: [] };
        },
      });

      await expect(
        serviceFor(script).handle({
          id: "job-chan-gone",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();

      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("succeeded");
      const items = await itemsOf(seeded.orgId);
      expect(items).toHaveLength(1);

      const adaptations = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.contentItemId, items[0]?.id as string));
      expect(adaptations.map((row) => row.channelId)).toEqual([seeded.channelIds[1]]);
      // One version for the master body and one for the surviving adaptation —
      // the deleted channel leaves nothing behind, not a dangling version row.
      const versions = await db
        .select()
        .from(schema.contentVersions)
        .where(eq(schema.contentVersions.contentItemId, items[0]?.id as string));
      expect(versions).toHaveLength(2);
    }, 30_000);

    it("fails the run rather than writing a draft whose every channel vanished", async () => {
      const seeded = await seed({ channels: 1 });
      const script = scriptedModel({
        factcheck: async () => {
          await db.delete(schema.channels).where(eq(schema.channels.brandId, seeded.brandId));
          return { claims: [] };
        },
      });

      await expect(
        serviceFor(script).handle({
          id: "job-chans-gone",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        }),
      ).resolves.toBeUndefined();

      const run = await runRow(seeded.runId);
      // An item with zero adaptations is one `approve` would mark approved while
      // enqueueing nothing — a post that looks sent and never was.
      expect(run?.status).toBe("failed");
      expect(run?.error).toBe("every_channel_deleted");
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
    }, 30_000);

    it("drops only the reference that broke when a ledger row outlives its channel", async () => {
      // Nulling `run_id` as well would take the call out of its own run's cost —
      // the figure on the finished draft sums by `run_id` — so the run would
      // under-report its own bill because an unrelated channel was deleted.
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      const doomed = seeded.channelIds[0] as string;
      await repo.claim(seeded.orgId, seeded.runId, "job-fk#1", "job-fk");
      await db.delete(schema.channels).where(eq(schema.channels.id, doomed));

      await repo.recordUsage(
        seeded.orgId,
        seeded.runId,
        { step: `adapter:${doomed}`, channelId: doomed },
        {
          provider: "google",
          modelId: "gemini-3.7-flash",
          attempt: 1,
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0.001,
          costSource: "price_table",
          responseMs: 12,
          status: "ok",
          outcome: "completed",
        },
      );

      const ledger = await ledgerOf(seeded.orgId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.channelId).toBeNull();
      expect(ledger[0]?.runId).toBe(seeded.runId);
    }, 20_000);

    it("floors a sub-micro-dollar cost instead of storing a billed call as 0.000000", async () => {
      // `numeric(12,6)` cannot hold 5e-8, and the naive conversion rounds it to
      // `0.000000` — a call that WAS billed, recorded as free, in the column
      // every cost figure sums. `toLedgerCostUsd` floors it; this pins the
      // CALL SITE rather than the helper, because a unit test of the helper
      // cannot notice a caller that stopped using it. This path writes
      // essentially every row in the table.
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      await repo.claim(seeded.orgId, seeded.runId, "job-floor#1", "job-floor");

      await repo.recordUsage(
        seeded.orgId,
        seeded.runId,
        { step: "writer" },
        {
          provider: "openrouter",
          modelId: "google/gemini-3.7-flash",
          attempt: 1,
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          // What OpenRouter reports for a tiny call. It never passes through
          // `estimateCostUsd`, which is where the other floor lives.
          costUsd: 5e-8,
          costSource: "provider_reported",
          responseMs: 12,
          status: "ok",
          outcome: "completed",
        },
      );

      const ledger = await ledgerOf(seeded.orgId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.costUsd).toBe("0.000001");
      expect(ledger[0]?.costUsd).not.toBe("0.000000");
    }, 20_000);

    it("stores what became of the round trip, so a lost call cannot read as free", async () => {
      // The column the org's total reads to decide whether it is a floor. A
      // writer that dropped it would leave every lost call looking exactly like
      // a 429 — which is the defect this whole column exists to close.
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      await repo.claim(seeded.orgId, seeded.runId, "job-outcome#1", "job-outcome");

      for (const outcome of ["completed", "refused", "unknown"] as const) {
        await repo.recordUsage(
          seeded.orgId,
          seeded.runId,
          { step: outcome },
          {
            provider: "google",
            modelId: "gemini-3.7-flash",
            attempt: 1,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            costUsd: null,
            costSource: "unknown",
            responseMs: 12,
            status: "errored",
            outcome,
          },
        );
      }

      const ledger = await ledgerOf(seeded.orgId);
      expect(new Map(ledger.map((row) => [row.step, row.outcome]))).toEqual(
        new Map([
          ["completed", "completed"],
          ["refused", "refused"],
          ["unknown", "unknown"],
        ]),
      );
    }, 20_000);

    it("attributes every ledger row to the step that made the call", async () => {
      const seeded = await seed({ channels: 2 });
      await serviceFor(scriptedModel()).handle({
        id: "job-ledger",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      const ledger = await ledgerOf(seeded.orgId);
      expect(ledger).toHaveLength(6);
      // One context serves the whole run, so a run that let the CALLER name the
      // step would write six rows that all looked right and all named the same
      // one. The step's own attribution is what prevents that.
      expect(new Set(ledger.map((row) => row.step))).toEqual(
        new Set([
          "researcher",
          "writer",
          "editor",
          "factcheck",
          ...seeded.channelIds.map((id) => `adapter:${id}`),
        ]),
      );
      for (const row of ledger) {
        expect(row.runId).toBe(seeded.runId);
        expect(row.provider).toBe("google");
        expect(row.modelId).toBe("gemini-3.7-flash");
        expect(row.status).toBe("ok");
        expect(row.keyOwnership).toBe("byok");
        // channel_id is what makes an adapter row attributable to its channel.
        const expectChannel = row.step.startsWith("adapter:") ? row.step.slice(8) : null;
        expect(row.channelId).toBe(expectChannel);
        expect(row.costSource).toBe("price_table");
        expect(row.costUsd).not.toBeNull();
      }
    }, 30_000);

    it("carries the brand's voice and the brief into every step's instructions", async () => {
      const seeded = await seed({ channels: 1 });
      const script = scriptedModel();
      await serviceFor(script).handle({
        id: "job-voice",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      for (const call of script.calls) {
        expect(call.system).toContain("dry and concrete");
        expect(call.system).toContain("independent cafe owners");
        // The brief is UNTRUSTED input: it reaches the model as material, never
        // as instructions.
        expect(call.system).not.toContain(BRIEF);
      }
      expect(script.calls.find((call) => call.role === "researcher")?.user).toContain(BRIEF);
      expect(channelOf(script.calls.find((call) => call.role === "adapter")?.system ?? "")).toBe(
        seeded.channelNames[0],
      );
    }, 25_000);
  });

  /**
   * A billed call whose ledger row cannot be written.
   *
   * The policy — keep the text, lose the row — is right and stays. What was
   * missing is anywhere for the loss to LAND. The package reports it to a
   * caller-supplied handler and, with none, to a bare `console.error`; the
   * worker set none, so the loss left the framework's logger entirely while the
   * SAME method's foreign-key narrowing wrote through it two lines away. Nothing
   * counted it, nothing marked the run, and an org whose spend is understated
   * had no way to find out.
   *
   * The failure below is REAL — a token count past int4, refused by Postgres on
   * the real table — and not a stubbed repository, because the thing being
   * proved is that the loss survives in the database.
   */
  describe("a ledger row that could not be written", () => {
    /** Past int4: `usage_ledger.input_tokens` is an `integer` column. */
    const OVERFLOWING: ScriptedUsage = {
      inputTokens: { total: 3_000_000_000, noCache: 3_000_000_000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 60, text: 60, reasoning: 0 },
    };

    it("counts the loss on the run, which outlives the step", async () => {
      const seeded = await seed({ channels: 1 });
      const script = scriptedModel({}, OVERFLOWING);

      await serviceFor(script).handle({
        id: "job-lost-ledger",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      // Every call this run made was billed and none of them could be recorded.
      // Five steps for one channel: researcher, writer, editor, factcheck, one
      // adapter.
      expect(script.calls).toHaveLength(5);
      expect(await ledgerOf(seeded.orgId)).toHaveLength(0);

      const run = await runRow(seeded.runId);
      // The number a receipt can print. Without it the org sees $0.00 for a run
      // that cost five calls and is given no reason to doubt it.
      expect(run?.unrecordedCalls).toBe(5);
      // And the run still succeeded: the text was paid for, so throwing it away
      // as well would be strictly worse than losing its record.
      expect(run?.status).toBe("succeeded");
      expect(await itemsOf(seeded.orgId)).toHaveLength(1);
    }, 30_000);

    it("leaves the counter at zero when every row lands", async () => {
      // The other half of the claim: this counter means "money we cannot
      // account for", so a run that recorded everything must read zero. A
      // counter that ticked on a healthy run would make every receipt hedge.
      const seeded = await seed({ channels: 1 });

      await serviceFor(scriptedModel()).handle({
        id: "job-ledger-fine",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      expect(await ledgerOf(seeded.orgId)).toHaveLength(5);
      expect((await runRow(seeded.runId))?.unrecordedCalls).toBe(0);
    }, 30_000);

    it("records the loss even for a handler that has lost the fence", async () => {
      // The write is deliberately UNFENCED. A handler whose ledger writes are
      // failing is exactly the one likely to have lost its lease as well, and a
      // fenced counter would drop precisely those losses — the money still left
      // the org. The run is handed to somebody else DURING the researcher's
      // call, so the loss is reported by a handler that no longer owns the run.
      const seeded = await seed({ channels: 1 });
      const script = scriptedModel(
        {
          researcher: async () => {
            await claimedByAnother(seeded.runId, "someone-else#9999");
            return { angle: "An angle", keyPoints: ["A key point"], avoid: [] };
          },
        },
        OVERFLOWING,
      );

      await serviceFor(script).handle({
        id: "job-lost-fence-and-row",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      // It stopped at the next step boundary, as it must — one call made, one
      // call lost, and the loss recorded anyway.
      expect(script.calls).toHaveLength(1);
      const run = await runRow(seeded.runId);
      expect(run?.unrecordedCalls).toBe(1);
      expect(run?.activeJobId).toBe("someone-else#9999");
    }, 30_000);

    it("counts the loss against the run it happened on and no other", async () => {
      const other = await seed({ channels: 1 });
      const seeded = await seed({ channels: 1 });
      // A SECOND run of the same org, which is what makes this test able to
      // fail. With one run per org, an update scoped by `org_id` alone still
      // touches exactly the intended row and every scoping mutation reads as
      // survived — the shape of test that reports a line as pinned while
      // pinning nothing. This sibling is the row a lost `id` predicate hits.
      const [sibling] = await db
        .insert(schema.pipelineRuns)
        .values({
          orgId: seeded.orgId,
          brandId: seeded.brandId,
          input: { kind: "brief", text: BRIEF, channelIds: seeded.channelIds },
        })
        .returning({ id: schema.pipelineRuns.id });

      await serviceFor(scriptedModel({}, OVERFLOWING)).handle({
        id: "job-lost-scoped",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      expect((await runRow(seeded.runId))?.unrecordedCalls).toBe(5);
      expect((await runRow(sibling?.id as string))?.unrecordedCalls).toBe(0);
      expect((await runRow(other.runId))?.unrecordedCalls).toBe(0);
    }, 30_000);
  });

  /**
   * Migration 0013 added `unrecorded_calls` NULLABLE, on purpose: a run that
   * predates the column carries NULL, not 0, because NULL means "nothing is
   * known" — a back-filled 0 would assert nobody lost anything on runs where a
   * loss could not even have been seen. `NULL + 1` is NULL, so writing the
   * FIRST loss against such a run without the `coalesce` in
   * `GenerateRepository.recordUnrecordedCall` would swallow it: the counter
   * would still read NULL, which every reader treats exactly like "no losses".
   *
   * Every test in "a ledger row that could not be written" above seeds a fresh
   * run, and a fresh run's `unrecorded_calls` defaults to 0 — that default is
   * exactly what makes the branch the `coalesce` exists for unreachable
   * everywhere else in this file. This is the one test that gives a run the
   * NULL the migration was written for.
   */
  describe("the NULL branch coalesce exists for", () => {
    it("turns a run's NULL counter into 1 on its first recorded loss", async () => {
      const seeded = await seed({ channels: 1 });
      await db
        .update(schema.pipelineRuns)
        .set({ unrecordedCalls: null })
        .where(eq(schema.pipelineRuns.id, seeded.runId));
      expect((await runRow(seeded.runId))?.unrecordedCalls).toBeNull();

      await new Repository().recordUnrecordedCall(seeded.orgId, seeded.runId);

      expect((await runRow(seeded.runId))?.unrecordedCalls).toBe(1);
    }, 20_000);
  });

  /**
   * `GenerateRepository.recordUnrecordedCall`'s own `await db.update(...)` is
   * what every test above proves, each of them by reading the counter back
   * only after `handle()` has returned. That proof is worth nothing without the
   * WORKER'S OWN `await this.repo.recordUnrecordedCall(...)`, inside
   * `recordUnrecordedCall` (generate.service.ts): without it, `try {
   * this.repo.recordUnrecordedCall(...); } catch (writeError) { ... }` never
   * sees a rejection. A bare call's promise settles after the `try` block has
   * already returned, so a write that fails becomes an unhandled rejection
   * nobody's `catch` runs, and "UNRECORDED-CALL COUNTER FAILED" — the line
   * that tells an operator BOTH records of this loss are now gone — never gets
   * logged.
   *
   * Proved against a repository double that rejects, rather than against a
   * race with the real database: with the `await` in place, the assertion
   * below and the `catch` settle on the very same promise chain, so there is
   * no timing window to depend on either way.
   */
  describe("the worker's own await on the counter write", () => {
    it("catches its own counter write when it rejects, and logs that both records are gone", async () => {
      const failingWrite = vi.fn().mockRejectedValue(new Error("write failed"));
      const fakeRepo = { recordUnrecordedCall: failingWrite } as unknown as GenerateRepository;
      const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      const service = new Service(fakeRepo) as unknown as {
        recordUnrecordedCall: (
          orgId: string,
          runId: string,
          error: unknown,
          record: UsageRecord,
        ) => Promise<void>;
      };
      const record: UsageRecord = {
        provider: "google",
        modelId: "gemini-3.7-flash",
        attempt: 1,
        inputTokens: 120,
        outputTokens: 60,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.01,
        costSource: "price_table",
        responseMs: 400,
        status: "ok",
        outcome: "completed",
      };

      await service.recordUnrecordedCall(
        "org-await-1",
        "run-await-1",
        new Error("ledger write failed"),
        record,
      );

      expect(failingWrite).toHaveBeenCalledWith("org-await-1", "run-await-1");
      const logged = errorLog.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(logged).toContain("UNRECORDED-CALL COUNTER FAILED");
      vi.restoreAllMocks();
    });
  });
});
