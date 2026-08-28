import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { channelOf, scriptedModel } from "../test/scripted-model";

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
  let and: typeof import("drizzle-orm").and;
  let eq: typeof import("drizzle-orm").eq;
  let sql: typeof import("drizzle-orm").sql;
  let encryptJson: typeof import("@pubrick/shared").encryptJson;
  let Repository: GenerateRepositoryCtor;
  let Service: GenerateServiceCtor;
  let seq = 0;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";

    const dbModule = await import("@pubrick/db");
    schema = dbModule.schema;
    ({ db, pool } = dbModule.createDb(url as string));
    ({ and, eq, sql } = await import("drizzle-orm"));
    ({ encryptJson } = await import("@pubrick/shared"));
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

  async function seed(options: { channels?: number; credential?: boolean } = {}): Promise<Seeded> {
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
        name: "Kettle and Co",
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
          { apiKey: "test-key" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
        defaultModel: "gemini-3.7-flash",
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
      // A sentence the user can act on, not a provider 401 they cannot read.
      expect(run?.error).toContain("No AI provider key is configured");
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
      expect(run?.error).toContain("does not match the required schema");
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
      expect(run?.error).toContain("Connection terminated unexpectedly");
      vi.restoreAllMocks();
    }, 20_000);

    it("fails a run whose channels have all been deleted rather than writing a draft nobody can publish", async () => {
      const seeded = await seed({ channels: 1 });
      await db.delete(schema.channels).where(eq(schema.channels.brandId, seeded.brandId));

      await serviceFor(scriptedModel()).handle({
        id: "job-nochan",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      const run = await runRow(seeded.runId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toContain("has since been deleted");
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
    }, 20_000);
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
      expect(run?.error).toContain("has since been deleted");
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
        },
      );

      const ledger = await ledgerOf(seeded.orgId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.channelId).toBeNull();
      expect(ledger[0]?.runId).toBe(seeded.runId);
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
});
