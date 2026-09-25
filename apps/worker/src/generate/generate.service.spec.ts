import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Logger } from "@nestjs/common";
import type { UsageRecord } from "@pubrick/ai";
import sharp from "sharp";
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
  let mediaDir: string;

  beforeAll(async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), "pubrick-cover-test-"));
    process.env.MEDIA_STORAGE_DIR = mediaDir;
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
    delete process.env.MEDIA_STORAGE_DIR;
    if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
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
    generateCover?: boolean;
    generateInlineImages?: boolean;
    contentType?: import("@pubrick/shared").ContentType;
    seoKeywords?: string[];
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
      .values({
        orgId,
        brandId,
        input: {
          kind: "brief",
          text: BRIEF,
          channelIds,
          ...(options.generateCover && { generateCover: true }),
          ...(options.generateInlineImages && { generateInlineImages: true }),
          ...(options.contentType && { contentType: options.contentType }),
          ...(options.seoKeywords && { seoKeywords: options.seoKeywords }),
        },
      })
      .returning({ id: schema.pipelineRuns.id });

    return { orgId, brandId, runId: run?.id as string, channelIds, channelNames };
  }

  /** The service, wired to a real repository and the given mock model. */
  function serviceFor(
    model: ReturnType<typeof scriptedModel>,
    repo: GenerateRepository = new Repository(),
    imageCaller?: {
      call: (key: string, prompt: string) => Promise<import("@pubrick/ai").ImageCall>;
    },
  ): GenerateService {
    return new Service(repo, () => model.model as never, 0, imageCaller);
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

  describe("optional expert-article SEO polish", () => {
    it("uses the extra metered step only for a reviewed expert-article input", async () => {
      const ordinary = await seed({ contentType: "expert_article" });
      const without = scriptedModel();
      await serviceFor(without).handle({
        id: "seo-default-off",
        data: { runId: ordinary.runId, orgId: ordinary.orgId },
      });
      expect(without.callsFor("seo_polish")).toBe(0);

      const chosen = await seed({
        contentType: "expert_article",
        seoKeywords: ["local cafe planning"],
      });
      const script = scriptedModel({
        seo_polish: () => ({ body: "## Local cafe planning\n\nA polished first draft." }),
      });
      await serviceFor(script).handle({
        id: "seo-opted-in",
        data: { runId: chosen.runId, orgId: chosen.orgId },
      });
      expect(script.callsFor("seo_polish")).toBe(1);
      expect(script.calls.find((call) => call.role === "seo_polish")?.user).toContain(
        "local cafe planning",
      );
      expect(script.calls.find((call) => call.role === "editor")?.user).toContain(
        "A polished first draft.",
      );
      expect((await runRow(chosen.runId))?.steps.seo_polish?.output).toMatchObject({
        result: "polished",
      });
      expect(
        (await ledgerOf(chosen.orgId)).filter((entry) => entry.step === "seo_polish"),
      ).toHaveLength(1);
    }, 30_000);

    it("checkpoints a visible fallback and does not repay SEO on takeover", async () => {
      const seeded = await seed({
        contentType: "expert_article",
        seoKeywords: ["practical guide"],
      });
      const repo = new Repository();
      const write = repo.writeCheckpoint.bind(repo);
      let tookOver = false;
      vi.spyOn(repo, "writeCheckpoint").mockImplementation(async (...args) => {
        const result = await write(...(args as Parameters<typeof write>));
        if (args[3] === "seo_polish" && !tookOver) {
          tookOver = true;
          await new Repository().claim(
            seeded.orgId,
            seeded.runId,
            "seo-fallback#other",
            "seo-fallback",
          );
        }
        return result;
      });
      const first = scriptedModel({ seo_polish: () => "invalid structured response" });
      await serviceFor(first, repo).handle({
        id: "seo-fallback",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      const afterFirst = await runRow(seeded.runId);
      expect(afterFirst?.steps.seo_polish?.output).toMatchObject({
        body: "A first draft.",
        result: "unavailable",
      });
      expect(first.callsFor("seo_polish")).toBe(2); // structured-output repair
      const billed = (await ledgerOf(seeded.orgId)).filter((entry) => entry.step === "seo_polish");
      expect(billed).toHaveLength(2);

      const resumed = scriptedModel();
      await serviceFor(resumed).handle({
        id: "seo-fallback",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      expect(resumed.callsFor("seo_polish")).toBe(0);
      expect(resumed.calls.find((call) => call.role === "editor")?.user).toContain(
        "A first draft.",
      );
      expect((await runRow(seeded.runId))?.status).toBe("succeeded");
      expect(
        (await ledgerOf(seeded.orgId)).filter((entry) => entry.step === "seo_polish"),
      ).toHaveLength(2);
    }, 30_000);
  });

  describe("opt-in draft covers", () => {
    it("does not call the image provider unless the run requested a cover", async () => {
      const seeded = await seed();
      const imageCaller = { call: vi.fn() };
      await serviceFor(scriptedModel(), new Repository(), imageCaller).handle({
        id: "cover-off",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      expect(imageCaller.call).not.toHaveBeenCalled();
      expect((await itemsOf(seeded.orgId))[0]?.coverMediaId).toBeNull();
    });

    it("attaches a normalized image only to its new draft and records its cost", async () => {
      const seeded = await seed({ generateCover: true });
      const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "#e66142" },
      })
        .png()
        .toBuffer();
      const imageCaller = {
        call: vi.fn(async () => ({
          bytes: png,
          mimeType: "image/png",
          outcome: "completed" as const,
          responseMs: 50,
          usage: {
            promptTokenCount: 100,
            candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
          },
        })),
      };
      await serviceFor(scriptedModel(), new Repository(), imageCaller).handle({
        id: "cover-success",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      const [item] = await itemsOf(seeded.orgId);
      expect(item?.status).toBe("draft");
      expect(item?.coverMediaId).toBeTruthy();
      expect(item?.firstOpenedAt).toBeNull();
      const [asset] = await db
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, item?.coverMediaId as string));
      expect(asset).toMatchObject({
        orgId: seeded.orgId,
        brandId: seeded.brandId,
        mimeType: "image/jpeg",
      });
      expect(
        (await readFile(path.join(mediaDir, `${item?.coverMediaId}.jpg`))).length,
      ).toBeGreaterThan(0);
      const coverCall = (await ledgerOf(seeded.orgId)).find((row) => row.step === "cover");
      expect(coverCall).toMatchObject({
        outcome: "completed",
        costSource: "price_table",
        provider: "google",
      });
      expect((await runRow(seeded.runId))?.steps.cover?.output).toMatchObject({
        mediaId: item?.coverMediaId,
        result: "generated",
      });
      expect(imageCaller.call).toHaveBeenCalledTimes(1);
    });

    it("keeps the text draft when the image outcome and cost are unknown", async () => {
      const seeded = await seed({ generateCover: true });
      const imageCaller = {
        call: vi.fn(async () => ({ outcome: "unknown" as const, responseMs: 120_000 })),
      };
      await serviceFor(scriptedModel(), new Repository(), imageCaller).handle({
        id: "cover-unknown",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      expect((await itemsOf(seeded.orgId))[0]).toMatchObject({
        status: "draft",
        coverMediaId: null,
      });
      expect((await runRow(seeded.runId))?.steps.cover?.output).toEqual({
        mediaId: null,
        result: "unavailable",
      });
      expect((await ledgerOf(seeded.orgId)).find((row) => row.step === "cover")).toMatchObject({
        outcome: "unknown",
        costSource: "unknown",
        status: "errored",
      });
    });

    it("skips a cover while another process owns the organization's image call lock", async () => {
      const seeded = await seed({ generateCover: true });
      const holder = await workerPool.connect();
      const key = `image-call-budget:${seeded.orgId}`;
      try {
        await holder.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
        const imageCaller = { call: vi.fn() };
        await serviceFor(scriptedModel(), new Repository(), imageCaller).handle({
          id: "cover-busy",
          data: { runId: seeded.runId, orgId: seeded.orgId },
        });
        expect(imageCaller.call).not.toHaveBeenCalled();
        expect((await itemsOf(seeded.orgId))[0]?.coverMediaId).toBeNull();
      } finally {
        await holder.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        holder.release();
      }
    });

    it("resumes from the cover checkpoint without buying another image", async () => {
      const seeded = await seed({ generateCover: true });
      const png = await sharp({
        create: { width: 2, height: 2, channels: 3, background: "#e66142" },
      })
        .png()
        .toBuffer();
      const imageCaller = {
        call: vi.fn(async () => ({
          bytes: png,
          mimeType: "image/png",
          outcome: "completed" as const,
          responseMs: 5,
        })),
      };
      const repo = new Repository();
      const finish = vi
        .spyOn(repo, "finish")
        .mockRejectedValue(new Error("temporary database failure"));
      const service = serviceFor(scriptedModel(), repo, imageCaller);
      const job = { id: "cover-resume", data: { runId: seeded.runId, orgId: seeded.orgId } };
      await expect(service.handle(job)).rejects.toThrow("temporary database failure");
      expect((await runRow(seeded.runId))?.steps.cover?.status).toBe("succeeded");
      finish.mockRestore();
      await service.handle(job);
      expect(imageCaller.call).toHaveBeenCalledTimes(1);
      const checkpoint = (await runRow(seeded.runId))?.steps.cover?.output as { mediaId: string };
      expect((await itemsOf(seeded.orgId))[0]).toMatchObject({
        status: "draft",
        coverMediaId: checkpoint.mediaId,
      });
      expect((await ledgerOf(seeded.orgId)).filter((row) => row.step === "cover")).toHaveLength(1);
    });
  });

  describe("opt-in inline article images", () => {
    const body = [
      "The bakery opens on Monday.",
      "A second oven doubles the daily loaf capacity.",
      "The team will test recipes with local flour.",
      "Customers can collect orders in the morning.",
      "The first menu includes five kinds of bread.",
    ].join("\n\n");

    async function png() {
      return sharp({ create: { width: 2, height: 2, channels: 3, background: "#e66142" } })
        .png()
        .toBuffer();
    }

    it("attaches two normalized, review-required slots and meters each physical call", async () => {
      const seeded = await seed({ generateInlineImages: true, contentType: "expert_article" });
      const bytes = await png();
      const imageCaller = {
        call: vi.fn(async () => ({
          bytes,
          mimeType: "image/png",
          outcome: "completed" as const,
          responseMs: 12,
          usage: {
            promptTokenCount: 50,
            candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
          },
        })),
      };
      await serviceFor(
        scriptedModel({ editor: () => ({ body, changes: [] }) }),
        new Repository(),
        imageCaller,
      ).handle({
        id: "inline-success",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      const [item] = await itemsOf(seeded.orgId);
      const slots = await db
        .select()
        .from(schema.contentImageSlots)
        .where(eq(schema.contentImageSlots.contentItemId, item?.id as string));
      expect(slots.map((slot) => slot.afterParagraph).sort()).toEqual([1, 3]);
      expect(slots).toHaveLength(2);
      for (const slot of slots) {
        expect(slot).toMatchObject({
          orgId: seeded.orgId,
          brandId: seeded.brandId,
          needsReview: true,
        });
        expect(slot.alt.length).toBeGreaterThan(0);
        expect((await readFile(path.join(mediaDir, `${slot.mediaId}.jpg`))).length).toBeGreaterThan(
          0,
        );
      }
      const calls = (await ledgerOf(seeded.orgId)).filter((row) => row.step === "inline_image");
      expect(calls).toHaveLength(2);
      expect(
        calls.every((row) => row.costSource === "price_table" && row.runId === seeded.runId),
      ).toBe(true);
      expect(imageCaller.call).toHaveBeenCalledTimes(2);
      expect((await runRow(seeded.runId))?.steps["inline_image:1"]?.status).toBe("succeeded");
      expect((await runRow(seeded.runId))?.steps["inline_image:3"]?.status).toBe("succeeded");
    });

    it("resumes from both slot checkpoints without paying for another image", async () => {
      const seeded = await seed({ generateInlineImages: true, contentType: "expert_article" });
      const bytes = await png();
      const imageCaller = {
        call: vi.fn(async () => ({
          bytes,
          mimeType: "image/png",
          outcome: "completed" as const,
          responseMs: 8,
        })),
      };
      const repo = new Repository();
      const finish = vi
        .spyOn(repo, "finish")
        .mockRejectedValue(new Error("temporary database failure"));
      const service = serviceFor(
        scriptedModel({ editor: () => ({ body, changes: [] }) }),
        repo,
        imageCaller,
      );
      const job = { id: "inline-resume", data: { runId: seeded.runId, orgId: seeded.orgId } };
      await expect(service.handle(job)).rejects.toThrow("temporary database failure");
      expect(
        (await ledgerOf(seeded.orgId)).filter((row) => row.step === "inline_image"),
      ).toHaveLength(2);
      finish.mockRestore();
      await service.handle(job);
      expect(imageCaller.call).toHaveBeenCalledTimes(2);
      expect(
        (await ledgerOf(seeded.orgId)).filter((row) => row.step === "inline_image"),
      ).toHaveLength(2);
      expect((await itemsOf(seeded.orgId))[0]?.status).toBe("draft");
    });

    it("uses only remaining hourly image budget and keeps the text draft", async () => {
      const seeded = await seed({ generateInlineImages: true, contentType: "expert_article" });
      await db.insert(schema.usageLedger).values(
        Array.from({ length: 11 }, () => ({
          orgId: seeded.orgId,
          step: "image_generate",
          provider: "google" as const,
          modelId: "gemini-3.1-flash-image",
          costSource: "unknown" as const,
          status: "ok" as const,
          outcome: "completed" as const,
        })),
      );
      const bytes = await png();
      const imageCaller = {
        call: vi.fn(async () => ({
          bytes,
          mimeType: "image/png",
          outcome: "completed" as const,
          responseMs: 8,
        })),
      };
      await serviceFor(
        scriptedModel({ editor: () => ({ body, changes: [] }) }),
        new Repository(),
        imageCaller,
      ).handle({
        id: "inline-budget",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      expect(imageCaller.call).toHaveBeenCalledTimes(1);
      expect((await itemsOf(seeded.orgId))[0]?.status).toBe("draft");
      expect((await runRow(seeded.runId))?.steps["inline_image:3"]?.output).toEqual({
        mediaId: null,
        result: "unavailable",
      });
    });

    it("skips image calls for a one-paragraph draft", async () => {
      const seeded = await seed({ generateInlineImages: true, contentType: "expert_article" });
      const imageCaller = { call: vi.fn() };
      await serviceFor(scriptedModel(), new Repository(), imageCaller).handle({
        id: "inline-short",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      expect(imageCaller.call).not.toHaveBeenCalled();
      expect((await itemsOf(seeded.orgId))[0]?.status).toBe("draft");
    });
  });

  /**
   * Waits until some backend is parked on a row lock held by `pid`.
   *
   * Scoped by BLOCKING PID (`pg_blocking_pids`), not by statement text or
   * `application_name`: sibling spec files run against this same database at the
   * same time, so "a backend is waiting on `brands`" does not identify ours,
   * while "a backend is waiting on a lock THIS transaction holds" does.
   *
   * `racing` is passed so that a promise which rejects instead of blocking says
   * so here, rather than timing out ten seconds later as if the lock were merely
   * slow.
   */
  async function waitForBlockedBy(pid: number, racing: Promise<unknown>): Promise<void> {
    let settled = false;
    const watched = racing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await db.execute(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND ${pid} = ANY(pg_blocking_pids(pid))`,
      );
      if ((rows[0] as { n: number }).n > 0) return;
      if (settled) {
        await watched;
        return;
      }
      if (Date.now() > deadline) throw new Error(`no backend blocked by pid ${pid}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
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

    it("uses effective editorial rank for news eligibility in lexical and vector retrieval", async () => {
      const down = await seed({ channels: 1 });
      const up = await seed({ channels: 1 });
      const [downSource, upSource] = await db
        .insert(schema.newsSources)
        .values([
          {
            orgId: down.orgId,
            brandId: down.brandId,
            name: "Downranked",
            kind: "rss",
            url: "https://example.com/down-feed",
          },
          {
            orgId: up.orgId,
            brandId: up.brandId,
            name: "Upranked",
            kind: "rss",
            url: "https://example.com/up-feed",
          },
        ])
        .returning({ id: schema.newsSources.id });
      const [, upStory] = await db
        .insert(schema.newsItems)
        .values([
          {
            orgId: down.orgId,
            brandId: down.brandId,
            sourceId: downSource?.id as string,
            title: "Autumn menu downranked",
            summary: "Autumn menu changed.",
            url: "https://example.com/down-story",
            relevanceStatus: "scored",
            relevanceScore: 0.6,
            relevanceFeedbackDelta: -0.2,
            relevanceReason: "Initially useful",
            relevanceUrgency: "timely",
            relevanceScoredAt: new Date(),
            embedding: Array(768).fill(0.1),
            embeddingModel: "gemini-embedding-001",
            embeddingDimensions: 768,
          },
          {
            orgId: up.orgId,
            brandId: up.brandId,
            sourceId: upSource?.id as string,
            title: "Autumn menu upranked",
            summary: "Autumn menu changed.",
            url: "https://example.com/up-story",
            relevanceStatus: "scored",
            relevanceScore: 0.4,
            relevanceFeedbackDelta: 0.2,
            relevanceReason: "Initially low",
            relevanceUrgency: "timely",
            relevanceScoredAt: new Date(),
            embedding: Array(768).fill(0.1),
            embeddingModel: "gemini-embedding-001",
            embeddingDimensions: 768,
          },
        ])
        .returning({ id: schema.newsItems.id });
      const repo = new Repository();
      const query = Array(768).fill(0.1);
      expect(await repo.hasRelatedNews(down.orgId, down.brandId)).toBe(false);
      expect(await repo.hasIndexedRelatedNews(down.orgId, down.brandId)).toBe(false);
      expect(await repo.lexicalRelatedNews(down.orgId, down.brandId, "Autumn menu")).toEqual([]);
      expect(await repo.similarRelatedNews(down.orgId, down.brandId, query)).toEqual([]);
      expect(await repo.hasRelatedNews(up.orgId, up.brandId)).toBe(true);
      expect(await repo.hasIndexedRelatedNews(up.orgId, up.brandId)).toBe(true);
      expect(
        (await repo.lexicalRelatedNews(up.orgId, up.brandId, "Autumn menu")).map(
          (story) => story.id,
        ),
      ).toEqual([upStory?.id]);
      expect(
        (await repo.similarRelatedNews(up.orgId, up.brandId, query)).map((story) => story.id),
      ).toEqual([upStory?.id]);
    });

    it("uses only recent scored public stories of this brand, without fetching their URLs", async () => {
      const { victim, intruder } = await twoOrgs();
      const [otherBrand] = await db
        .insert(schema.brands)
        .values({ orgId: victim.orgId, name: "Other news brand" })
        .returning({ id: schema.brands.id });
      const [publicSource, privateSource, otherBrandSource, otherOrgSource] = await db
        .insert(schema.newsSources)
        .values([
          {
            orgId: victim.orgId,
            brandId: victim.brandId,
            name: "Public",
            kind: "rss",
            url: "https://example.com/feed",
          },
          {
            orgId: victim.orgId,
            brandId: victim.brandId,
            name: "Private",
            kind: "telegram_private",
            url: "https://example.com/private",
            privatePeerEncrypted: "fixture",
          },
          {
            orgId: victim.orgId,
            brandId: otherBrand?.id as string,
            name: "Other brand",
            kind: "rss",
            url: "https://example.com/other-brand",
          },
          {
            orgId: intruder.orgId,
            brandId: intruder.brandId,
            name: "Other org",
            kind: "rss",
            url: "https://example.com/other-org",
          },
        ])
        .returning({ id: schema.newsSources.id });
      const row = (sourceId: string, orgId: string, brandId: string, marker: string) => ({
        orgId,
        brandId,
        sourceId,
        title: `Autumn menu ${marker}`,
        summary: `${marker} opened on Tuesday.`,
        url: `https://example.com/${marker}`,
        relevanceStatus: "scored" as const,
        relevanceScore: 0.8,
        relevanceReason: "Relevant to this brand",
        relevanceUrgency: "timely" as const,
        relevanceScoredAt: new Date(),
      });
      const [eligible] = await db
        .insert(schema.newsItems)
        .values([
          row(publicSource?.id as string, victim.orgId, victim.brandId, "OWN_NEWS_MARKER"),
          row(privateSource?.id as string, victim.orgId, victim.brandId, "PRIVATE_NEWS_MARKER"),
          row(
            otherBrandSource?.id as string,
            victim.orgId,
            otherBrand?.id as string,
            "OTHER_BRAND_NEWS_MARKER",
          ),
          row(
            otherOrgSource?.id as string,
            intruder.orgId,
            intruder.brandId,
            "OTHER_ORG_NEWS_MARKER",
          ),
          {
            ...row(
              publicSource?.id as string,
              victim.orgId,
              victim.brandId,
              "IRRELEVANT_NEWS_MARKER",
            ),
            editorSignal: "irrelevant" as const,
          },
          {
            ...row(publicSource?.id as string, victim.orgId, victim.brandId, "STALE_NEWS_MARKER"),
            publishedAt: new Date(Date.now() - 40 * 86_400_000),
          },
          {
            ...row(
              publicSource?.id as string,
              victim.orgId,
              victim.brandId,
              "UNSCORED_NEWS_MARKER",
            ),
            relevanceStatus: "unscored" as const,
            relevanceScore: null,
            relevanceReason: null,
            relevanceUrgency: null,
            relevanceScoredAt: null,
          },
        ])
        .returning({ id: schema.newsItems.id });
      const repo = new Repository();
      expect(await repo.hasRelatedNews(victim.orgId, victim.brandId)).toBe(true);
      expect(await repo.hasIndexedRelatedNews(victim.orgId, victim.brandId)).toBe(false);
      expect(
        (await repo.lexicalRelatedNews(victim.orgId, victim.brandId, BRIEF)).map((item) => item.id),
      ).toEqual([eligible?.id]);

      const script = scriptedModel();
      await serviceFor(script).handle({
        id: "related-news-job",
        data: { runId: victim.runId, orgId: victim.orgId },
      });
      for (const role of ["researcher", "writer"] as const) {
        const call = script.calls.find((candidate) => candidate.role === role);
        expect(call?.user).toContain("OWN_NEWS_MARKER");
        expect(call?.user).not.toContain("PRIVATE_NEWS_MARKER");
        expect(call?.user).not.toContain("OTHER_BRAND_NEWS_MARKER");
        expect(call?.user).not.toContain("OTHER_ORG_NEWS_MARKER");
        expect(call?.user).not.toContain("IRRELEVANT_NEWS_MARKER");
        expect(call?.user).not.toContain("STALE_NEWS_MARKER");
        expect(call?.user).not.toContain("UNSCORED_NEWS_MARKER");
        expect(call?.user).not.toContain("https://example.com/OWN_NEWS_MARKER");
      }
      const run = await runRow(victim.runId);
      expect(run?.steps.knowledge?.output).toMatchObject({
        entries: [],
        relatedNews: [{ id: eligible?.id, title: "Autumn menu OWN_NEWS_MARKER" }],
      });
      expect(
        (await ledgerOf(victim.orgId)).filter((entry) => entry.step === "knowledge"),
      ).toHaveLength(0);
      await db
        .update(schema.newsItems)
        .set({
          embedding: Array(768).fill(0.1),
          embeddingModel: "gemini-embedding-001",
          embeddingDimensions: 768,
        })
        .where(eq(schema.newsItems.id, eligible?.id as string));
      expect(await repo.hasIndexedRelatedNews(victim.orgId, victim.brandId)).toBe(true);
      expect(
        (await repo.similarRelatedNews(victim.orgId, victim.brandId, Array(768).fill(0.1))).map(
          (item) => item.id,
        ),
      ).toEqual([eligible?.id]);
    }, 25_000);

    it("reuses frozen news after its source has gone, without another retrieval call", async () => {
      const seeded = await seed({ channels: 1 });
      const newsId = randomUUID();
      await db
        .update(schema.pipelineRuns)
        .set({
          steps: {
            knowledge: {
              status: "succeeded",
              output: {
                entries: [],
                relatedNews: [
                  {
                    id: newsId,
                    title: "FROZEN_NEWS_MARKER",
                    summary: "An old source excerpt.",
                    url: "https://example.com/deleted",
                  },
                ],
              },
            },
          },
        })
        .where(eq(schema.pipelineRuns.id, seeded.runId));
      const script = scriptedModel();
      await serviceFor(script).handle({
        id: "frozen-news-job",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      expect(script.calls.find((call) => call.role === "researcher")?.user).toContain(
        "FROZEN_NEWS_MARKER",
      );
      expect(script.calls.find((call) => call.role === "writer")?.user).toContain(
        "FROZEN_NEWS_MARKER",
      );
      expect(
        (await ledgerOf(seeded.orgId)).filter((entry) => entry.step === "knowledge"),
      ).toHaveLength(0);
      expect((await runRow(seeded.runId))?.status).toBe("succeeded");
    }, 25_000);

    it("adds only active notes of the run's brand to material, without a provider embedding call", async () => {
      const { victim, intruder } = await twoOrgs();
      const [otherBrand] = await db
        .insert(schema.brands)
        .values({ orgId: victim.orgId, name: "Other brand" })
        .returning({ id: schema.brands.id });
      const inserted = await db
        .insert(schema.knowledgeEntries)
        .values([
          {
            orgId: victim.orgId,
            brandId: victim.brandId,
            title: "Autumn menu",
            content: "OWN_KNOWLEDGE_MARKER espresso uses Arabica.",
            category: "product_info",
          },
          {
            orgId: victim.orgId,
            brandId: victim.brandId,
            title: "Autumn menu",
            content: "PAUSED_KNOWLEDGE_MARKER",
            category: "product_info",
            isActive: false,
          },
          {
            orgId: victim.orgId,
            brandId: otherBrand?.id as string,
            title: "Autumn menu",
            content: "OTHER_BRAND_MARKER",
            category: "product_info",
          },
          {
            orgId: intruder.orgId,
            brandId: intruder.brandId,
            title: "Autumn menu",
            content: "OTHER_ORG_MARKER",
            category: "product_info",
          },
        ])
        .returning({ id: schema.knowledgeEntries.id });
      const script = scriptedModel();
      await serviceFor(script).handle({
        id: "knowledge-job",
        data: { runId: victim.runId, orgId: victim.orgId },
      });

      for (const role of ["researcher", "writer"] as const) {
        const call = script.calls.find((candidate) => candidate.role === role);
        expect(call?.user).toContain("OWN_KNOWLEDGE_MARKER");
        expect(call?.system).not.toContain("OWN_KNOWLEDGE_MARKER");
        expect(call?.user).not.toContain("PAUSED_KNOWLEDGE_MARKER");
        expect(call?.user).not.toContain("OTHER_BRAND_MARKER");
        expect(call?.user).not.toContain("OTHER_ORG_MARKER");
      }
      const run = await runRow(victim.runId);
      expect(run?.steps.knowledge?.status).toBe("succeeded");
      const [ownEntry] = inserted;
      if (!ownEntry) throw new Error("Knowledge fixture was not inserted");
      expect(run?.steps.knowledge?.output).toMatchObject({
        entries: [{ id: ownEntry.id, title: "Autumn menu" }],
      });
      expect((await ledgerOf(victim.orgId)).filter((row) => row.step === "knowledge")).toHaveLength(
        0,
      );
    }, 25_000);

    it("excludes vectors from a different embedding model", async () => {
      const own = await seed({ channels: 1, apiKey: VICTIM_KEY, brandName: "Model scope" });
      const [entry] = await db
        .insert(schema.knowledgeEntries)
        .values({
          orgId: own.orgId,
          brandId: own.brandId,
          title: "Model-specific fact",
          content: "A fact for vector search",
          category: "product_info",
          embedding: Array(768).fill(0.1),
          embeddingModel: "other-model",
          embeddingDimensions: 768,
        })
        .returning({ id: schema.knowledgeEntries.id });
      const repository = new Repository();
      expect(await repository.hasIndexedKnowledge(own.orgId, own.brandId)).toBe(false);
      expect(
        await repository.similarKnowledge(own.orgId, own.brandId, Array(768).fill(0.1)),
      ).toEqual([]);
      await db
        .update(schema.knowledgeEntries)
        .set({ embeddingModel: "gemini-embedding-001" })
        .where(eq(schema.knowledgeEntries.id, entry?.id as string));
      expect(await repository.hasIndexedKnowledge(own.orgId, own.brandId)).toBe(true);
      expect(
        await repository.similarKnowledge(own.orgId, own.brandId, Array(768).fill(0.1)),
      ).toHaveLength(1);
    });

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
      expect(
        await repo.context(intruder.orgId, victim.brandId, victim.channelIds, {}),
      ).toBeUndefined();

      const own = await repo.context(
        victim.orgId,
        victim.brandId,
        [...victim.channelIds, ...intruder.channelIds],
        {},
      );
      expect(own?.brand.name).toBe("Victim Coffee");
      // The channel list is scoped by brand as well as org — the brand predicate
      // alone would already exclude these — so this pins the pair, not either
      // predicate on its own.
      expect(own?.channels.map((channel) => channel.id)).toEqual(victim.channelIds);
    }, 25_000);

    it("pins each org's latest role revision on its first successful claim", async () => {
      const { victim, intruder } = await twoOrgs();
      const revisions = await db
        .insert(schema.promptRevisions)
        .values([
          { orgId: victim.orgId, role: "writer", version: 1, guidance: "VICTIM_OLD" },
          { orgId: victim.orgId, role: "writer", version: 2, guidance: "VICTIM_LATEST" },
          { orgId: intruder.orgId, role: "writer", version: 1, guidance: "INTRUDER_ONLY" },
        ])
        .returning({
          id: schema.promptRevisions.id,
          orgId: schema.promptRevisions.orgId,
          version: schema.promptRevisions.version,
        });
      const repo = new Repository();
      expect(await repo.claim(intruder.orgId, victim.runId, "cross#1", "cross")).toBeUndefined();
      expect((await runRow(victim.runId))?.guidanceSnapshot).toBeNull();
      const victimRun = await repo.claim(victim.orgId, victim.runId, "victim#1", "victim");
      const intruderRun = await repo.claim(
        intruder.orgId,
        intruder.runId,
        "intruder#1",
        "intruder",
      );
      expect(victimRun?.guidanceSnapshot).toEqual({
        writer: {
          revisionId: revisions.find((r) => r.orgId === victim.orgId && r.version === 2)?.id,
          version: 2,
          text: "VICTIM_LATEST",
        },
      });
      expect(intruderRun?.guidanceSnapshot).toEqual({
        writer: {
          revisionId: revisions.find((r) => r.orgId === intruder.orgId)?.id,
          version: 1,
          text: "INTRUDER_ONLY",
        },
      });
      expect(
        (
          await repo.context(
            victim.orgId,
            victim.brandId,
            victim.channelIds,
            victimRun?.guidanceSnapshot ?? {},
          )
        )?.promptGuidance,
      ).toEqual({ writer: "VICTIM_LATEST" });
      expect(
        (
          await repo.context(
            intruder.orgId,
            intruder.brandId,
            intruder.channelIds,
            intruderRun?.guidanceSnapshot ?? {},
          )
        )?.promptGuidance,
      ).toEqual({ writer: "INTRUDER_ONLY" });
    }, 25_000);

    it("keeps an empty first-claim snapshot empty after guidance is added", async () => {
      const seeded = await seed();
      const repo = new Repository();
      expect(
        (await repo.claim(seeded.orgId, seeded.runId, "empty#1", "empty"))?.guidanceSnapshot,
      ).toEqual({});
      await db
        .insert(schema.promptRevisions)
        .values({ orgId: seeded.orgId, role: "writer", version: 1, guidance: "ADDED_LATER" });
      const resumed = await repo.claim(seeded.orgId, seeded.runId, "empty#2", "empty");
      expect(resumed?.guidanceSnapshot).toEqual({});
      expect((await runRow(seeded.runId))?.guidanceSnapshot).toEqual({});
      const script = scriptedModel();
      await serviceFor(script).handle({
        id: "empty",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      expect(script.calls.find((call) => call.role === "writer")?.system).not.toContain(
        "ADDED_LATER",
      );
    }, 25_000);

    it("keeps guidance through a lease takeover and checkpoint resume; a new run gets current guidance", async () => {
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      await db
        .insert(schema.promptRevisions)
        .values({ orgId: seeded.orgId, role: "editor", version: 1, guidance: "PINNED_EDITOR" });
      const first = await repo.claim(seeded.orgId, seeded.runId, "old-job#1", "old-job");
      expect(first?.guidanceSnapshot.editor?.text).toBe("PINNED_EDITOR");
      await db
        .update(schema.pipelineRuns)
        .set({
          steps: {
            researcher: {
              status: "succeeded",
              output: { angle: "An angle", keyPoints: ["A key point"], avoid: [] },
            },
            writer: { status: "succeeded", output: { body: "Checkpointed draft." } },
          },
          leaseExpiresAt: sql`now() - interval '1 second'`,
        })
        .where(eq(schema.pipelineRuns.id, seeded.runId));
      await db
        .insert(schema.promptRevisions)
        .values({ orgId: seeded.orgId, role: "editor", version: 2, guidance: "NEW_EDITOR" });
      const taken = await repo.claim(seeded.orgId, seeded.runId, "new-job#1", "new-job");
      expect(taken?.guidanceSnapshot).toEqual(first?.guidanceSnapshot);
      const script = scriptedModel();
      await serviceFor(script).handle({
        id: "new-job",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      expect(script.callsFor("researcher")).toBe(0);
      expect(script.callsFor("writer")).toBe(0);
      expect(script.calls.find((call) => call.role === "editor")?.system).toContain(
        "PINNED_EDITOR",
      );
      expect(script.calls.find((call) => call.role === "editor")?.system).not.toContain(
        "NEW_EDITOR",
      );
      const [newRun] = await db
        .insert(schema.pipelineRuns)
        .values({
          orgId: seeded.orgId,
          brandId: seeded.brandId,
          input: { kind: "brief", text: BRIEF, channelIds: seeded.channelIds },
        })
        .returning({ id: schema.pipelineRuns.id });
      expect(
        (await repo.claim(seeded.orgId, newRun?.id as string, "new-run#1", "new-run"))
          ?.guidanceSnapshot.editor,
      ).toMatchObject({ version: 2, text: "NEW_EDITOR" });
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

    /**
     * FABRICATED, and deliberately so.
     *
     * After 3a every `kind` a writer can produce is one this build executes, so
     * there is no reachable subject for this refusal — the row below is written
     * by hand, past the drizzle `$type<RunInput>()` that would refuse it. It is
     * here because the refusal is what makes the union in `parseInput` an
     * enumeration of what this build CAN RUN rather than a restatement of what
     * the column may hold: `runInputSchema` will gain `"topic"` before any
     * worker can execute one, and the day it does this is the test that says
     * what happens to the runs already in the queue.
     *
     * The weight sits on the two assertions the design's §18 standard asks for:
     * the CODE the row carries, and that not one step was paid for. "It did not
     * throw" would pass with the run stuck at `running` and five calls billed.
     */
    it("fails a run whose stored kind this build cannot execute, before any step is paid for", async () => {
      const seeded = await seed({ channels: 1 });
      await db.execute(
        sql`UPDATE pipeline_runs SET input = ${JSON.stringify({
          kind: "topic",
          topic: "the autumn menu",
          channelIds: seeded.channelIds,
        })}::jsonb WHERE id = ${seeded.runId}`,
      );
      const script = scriptedModel();
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

      try {
        await expect(
          serviceFor(script).handle({
            id: "job-unexecutable-kind",
            data: { runId: seeded.runId, orgId: seeded.orgId },
          }),
        ).resolves.toBeUndefined();

        const run = await runRow(seeded.runId);
        expect(run?.status).toBe("failed");
        // `internal`, not a code of its own: a row this build cannot parse was
        // written by another build of OURS, and the reader of the strip can do
        // nothing about it.
        expect(run?.error).toBe("internal");
        expect(script.calls).toHaveLength(0);
        expect(await itemsOf(seeded.orgId)).toHaveLength(0);
        expect(await ledgerOf(seeded.orgId)).toHaveLength(0);

        // AND FOR THE RIGHT REASON, which the code alone cannot say. Delete the
        // parse and hand the row through as-is and every assertion above still
        // passes: the context comes out with three undefined text fields, the
        // researcher builds an empty block list, and `callStep`'s own refusal
        // ends the run `failed`/`internal` with no call billed — the same row,
        // one step later, for a reason that has nothing to do with the kind.
        // `internal` covers both, so only the sentence tells them apart.
        const logged = warn.mock.calls.map((call) => call.join(" ")).join("\n");
        expect(logged).toContain("this run's input cannot be executed by this worker");
        expect(logged).toContain("kind");
        expect(logged).not.toContain("was given no material to work on");
      } finally {
        vi.restoreAllMocks();
      }
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

    /**
     * THE TERMINAL WRITE AGAINST `DELETE /api/brands/:id`, which used to be a
     * deadlock: `40P01`, reproduced on a real database, on two independent
     * edges (`pipeline_runs` and `channels`) with either side as the victim.
     *
     * The brand delete is replayed here as its statements rather than called:
     * it lives in the api, and this file drives the worker. Its sequence is the
     * one `BrandsRepository.delete` issues — brand `FOR UPDATE`, the brand's
     * runs, the doomed adaptations, then the cascading `DELETE FROM brands` —
     * and the ORDER of those statements is the whole subject of the test.
     *
     * The delete goes first and holds the brand, which is the arrival order
     * that used to kill `finish` inside `SELECT 1 FROM ONLY "brands" x … FOR
     * KEY SHARE OF x`, four statements after it had already taken the run and
     * the channel. `finish` now asks for the brand BEFORE either of them, so it
     * parks there holding nothing, and the delete runs to completion.
     *
     * BOTH sides are asserted. Checking only the outcome would pass a fix that
     * merely moved the victim onto the api — which is exactly what adding the
     * delete's run lock without the brand pre-lock does (measured).
     */
    it("a brand delete landing on the terminal write ends the run as `gone`, not as a deadlock", async () => {
      const seeded = await seed({ channels: 1 });
      const repo = new Repository();
      expect(
        await repo.claim(seeded.orgId, seeded.runId, "job-cascade#one", "job-cascade"),
      ).toBeDefined();
      // Money already spent by this run, recorded the way every step records it:
      // its own transaction, before the checkpoint.
      await db.execute(
        sql`INSERT INTO usage_ledger (org_id, run_id, step, provider, model_id, cost_usd, cost_source, status)
            VALUES (${seeded.orgId}, ${seeded.runId}, 'writer', 'google', 'gemini-3.7-flash', 0.004, 'price_table', 'ok')`,
      );

      const deleting = await pool.connect();
      let deleteError: string | null = null;
      let outcome: unknown;
      try {
        await deleting.query("BEGIN");
        const { rows } = await deleting.query("SELECT pg_backend_pid() AS pid");
        const deletingPid = (rows[0] as { pid: number }).pid;
        await deleting.query(
          "SELECT id FROM brands WHERE org_id = $1 AND id = $2 LIMIT 1 FOR UPDATE",
          [seeded.orgId, seeded.brandId],
        );

        const finishing = repo.finish(
          seeded.orgId,
          seeded.runId,
          "job-cascade#one",
          seeded.brandId,
          {
            body: "A draft nobody will read.",
            adaptations: [{ channelId: seeded.channelIds[0] as string, body: "An adaptation." }],
          },
        );
        // The interleaving as a fact, not a hope about promise scheduling: wait
        // until a backend is parked on a lock held BY THIS delete. Scoped by
        // blocking pid rather than by statement text, because other spec files
        // run against this same database concurrently.
        await waitForBlockedBy(deletingPid, finishing);

        await deleting.query(
          "SELECT id, status FROM pipeline_runs WHERE org_id = $1 AND brand_id = $2 ORDER BY id FOR UPDATE",
          [seeded.orgId, seeded.brandId],
        );
        await deleting.query(
          `SELECT id, status, attempt_count FROM adaptations
            WHERE org_id = $1
              AND (channel_id IN (SELECT id FROM channels WHERE org_id = $1 AND brand_id = $2)
                OR content_item_id IN (SELECT id FROM content_items WHERE org_id = $1 AND brand_id = $2))
            ORDER BY id FOR UPDATE`,
          [seeded.orgId, seeded.brandId],
        );
        deleteError = await deleting
          .query("DELETE FROM brands WHERE org_id = $1 AND id = $2", [seeded.orgId, seeded.brandId])
          .then(
            () => null,
            (error: { code?: string }) => String(error.code),
          );
        await deleting.query("COMMIT");
        outcome = await finishing;
      } finally {
        await deleting.query("ROLLBACK").catch(() => {});
        deleting.release();
      }

      expect(
        deleteError,
        "DELETE /api/brands/:id was the deadlock victim (40P01 -> 500)",
      ).toBeNull();
      // `gone`, not a throw: the brand's row is missing, so the run's is too,
      // and there is nowhere for `content_items.brand_id` to point. The caller
      // logs one line instead of raising the terminal-write alarm three times.
      expect(outcome, "the terminal write was the deadlock victim").toBe("gone");
      expect(await runRow(seeded.runId)).toBeUndefined();
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
      // And what the run had already spent outlives it: `usage_ledger.run_id` is
      // ON DELETE SET NULL precisely so the org's bill survives the cascade.
      const ledger = await ledgerOf(seeded.orgId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]?.runId).toBeNull();
      expect(ledger[0]?.costUsd).toBe("0.004000");
    }, 25_000);

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

    it("stores generated hashtags in the exact channel text and CTA as editorial metadata", async () => {
      const seeded = await seed();
      const script = scriptedModel({
        adapter: () => ({
          body: "A generated channel post.",
          hashtags: [" #new product ", "launch"],
          cta: "Ask a question",
        }),
      });
      await serviceFor(script).handle({
        id: "job-channel-metadata",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      const item = (await itemsOf(seeded.orgId))[0];
      const adaptations = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.contentItemId, item?.id as string));
      expect(adaptations[0]).toMatchObject({
        body: "A generated channel post.\n\n#new_product #launch",
        hashtags: ["new_product", "launch"],
        cta: "Ask a question",
      });
      const versions = await db
        .select()
        .from(schema.contentVersions)
        .where(eq(schema.contentVersions.adaptationId, adaptations[0]?.id as string));
      expect(versions[0]).toMatchObject({
        body: adaptations[0]?.body,
        hashtags: adaptations[0]?.hashtags,
        cta: "Ask a question",
      });
    }, 30_000);

    it("fails generation when a hashtag suffix would exceed the channel limit", async () => {
      const seeded = await seed();
      const script = scriptedModel({
        adapter: () => ({ body: "x".repeat(4095), hashtags: ["tag"] }),
      });
      await serviceFor(script).handle({
        id: "job-overlong-tags",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });
      expect(await itemsOf(seeded.orgId)).toHaveLength(0);
      expect(await runRow(seeded.runId)).toMatchObject({
        status: "failed",
        error: "too_long_for_channel",
      });
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

    it("uses a stored editorial snapshot only for the writer, without changing other steps", async () => {
      const seeded = await seed({ channels: 1 });
      const note = "FEEDBACK_MARKER prefer a calm opening";
      await db
        .update(schema.pipelineRuns)
        .set({
          input: {
            kind: "brief",
            text: BRIEF,
            channelIds: seeded.channelIds,
            useEditorialFeedback: true,
            editorialFeedback: [{ id: "a61851c4-7fac-4a2a-9aa4-2dd0d77b854b", note }],
          },
        })
        .where(eq(schema.pipelineRuns.id, seeded.runId));
      const script = scriptedModel();

      await serviceFor(script).handle({
        id: "job-editorial-feedback",
        data: { runId: seeded.runId, orgId: seeded.orgId },
      });

      expect(script.calls.find((call) => call.role === "writer")?.user).toContain(note);
      for (const call of script.calls) {
        expect(call.system).not.toContain(note);
        if (call.role !== "writer") expect(call.user).not.toContain(note);
      }
    }, 25_000);

    it.each([
      ["educational", "how-to", "how-to"],
      ["product_update", "product update", "release change"],
      ["comparison", "comparison", "comparison criteria"],
    ] as const)(
      "uses stored %s format without adding a paid step",
      async (contentType, phrase, adapterPhrase) => {
        const seeded = await seed({ channels: 1 });
        await db
          .update(schema.pipelineRuns)
          .set({
            input: {
              kind: "brief",
              text: BRIEF,
              channelIds: seeded.channelIds,
              contentType,
            },
          })
          .where(eq(schema.pipelineRuns.id, seeded.runId));
        const script = scriptedModel();

        await serviceFor(script).handle({
          id: `job-${contentType}`,
          data: { runId: seeded.runId, orgId: seeded.orgId },
        });

        expect(script.calls.map((call) => call.role)).toEqual([
          "researcher",
          "writer",
          "editor",
          "factcheck",
          "adapter",
        ]);
        expect(script.calls.find((call) => call.role === "writer")?.system).toContain(phrase);
        expect(script.calls.find((call) => call.role === "researcher")?.system).toContain(phrase);
        expect(script.calls.find((call) => call.role === "adapter")?.system).toContain(
          adapterPhrase,
        );
        expect(await ledgerOf(seeded.orgId)).toHaveLength(5);
      },
      25_000,
    );

    it.each([
      ["repost", "source-based retelling"],
      ["case_study", "case study"],
    ] as const)(
      "uses stored source text for %s through the same five metered steps",
      async (contentType, phrase) => {
        const seeded = await seed({ channels: 1 });
        const material = "SOURCE_MARKER The supplier announced new autumn ordering terms.";
        await db
          .update(schema.pipelineRuns)
          .set({
            input: {
              kind: "source",
              text: "Explain the effect for cafe owners",
              material,
              sourceUrl: null,
              channelIds: seeded.channelIds,
              contentType,
            },
          })
          .where(eq(schema.pipelineRuns.id, seeded.runId));
        const script = scriptedModel();

        await serviceFor(script).handle({
          id: `job-${contentType}`,
          data: { runId: seeded.runId, orgId: seeded.orgId },
        });

        expect(script.calls.map((call) => call.role)).toEqual([
          "researcher",
          "writer",
          "editor",
          "factcheck",
          "adapter",
        ]);
        expect(script.calls.find((call) => call.role === "writer")?.system).toContain(phrase);
        expect(script.calls.find((call) => call.role === "researcher")?.user).toContain(material);
        expect(script.calls.find((call) => call.role === "writer")?.user).toContain(material);
        expect(await ledgerOf(seeded.orgId)).toHaveLength(5);
      },
      25_000,
    );
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

  describe("the abandoned-run sweep", () => {
    /**
     * THE SAME TABLE, TWO TRANSACTIONS: the sweep walks `pipeline_runs` in
     * ascending `id`, because `BrandsRepository.delete` does
     * (`docs/lock-order.md`).
     *
     * That delete locks every run of the brand it is destroying with
     * `ORDER BY id FOR UPDATE`. This sweep is one bulk `UPDATE` over every
     * abandoned `running` run in the product — an overlapping set — and a bulk
     * `UPDATE ... WHERE` cannot carry an `ORDER BY` of its own, so unordered it
     * takes its row locks in scan order: heap order, which has nothing to do
     * with id order and reverses freely. Two walkers, opposite directions, one
     * cycle. The sweep losing is `ABANDONED-RUN SWEEP FAILED` on the one path
     * that rescues stuck runs; the delete losing is a 500 on
     * `DELETE /api/brands/:id`.
     *
     * The cycle forms INSIDE a single statement, so no interleaving of these
     * two transactions' STATEMENTS can produce it — which is exactly why a pair
     * matrix over statement prefixes reported this pair clean. The interleaving
     * here is built inside the `UPDATE` instead: the delete holds the LOWEST id
     * of the set and the sweep is launched, parking on a row lock. Ordered, the
     * lowest id is the sweep's FIRST lock, so it parks holding nothing and the
     * delete's ascending walk runs on unobstructed. Unordered, it reaches that
     * row somewhere in the middle of its scan and is holding the rows it passed
     * on the way — which is exactly what the delete asks for next, while it
     * holds what the sweep wants.
     *
     * MANY runs, not two, and this is the part a smaller fixture gets wrong.
     * The unordered scan order here is neither id order nor heap order: the
     * planner hashes `pipeline_runs` against `pgboss.job` for the no-live-job
     * anti-join, so the sub-select emits rows in hash-bucket order of the run
     * id — arbitrary, and with two rows it is a coin toss whether the lowest id
     * comes out first anyway. Over `RUNS` of them the unordered scan reaches the
     * held row first only once in `RUNS`, so the cycle is built with probability
     * `(RUNS - 1) / RUNS`; the ORDERED shape never builds it, at any count.
     *
     * Measured before this shape existed, racing the two real statements over
     * 60 runs: 8 deadlocks in 40 concurrent rounds, against 0 in 40 with it.
     *
     * Both sides are asserted. Checking only that the sweep returned would pass
     * a fix that merely moved the victim onto the api.
     */
    it("sweepAbandoned locks in id order, so a brand delete's ordered walk cannot deadlock it", async () => {
      const seeded = await seed({ channels: 0 });
      // The brand's own seeded run is `queued` and so outside the sweep's set,
      // but INSIDE the delete's — which locks every run of the brand. Removing
      // it keeps the two ids below the whole of both walks.
      await db.execute(sql`DELETE FROM pipeline_runs WHERE id = ${seeded.runId}`);

      const RUNS = 24;
      const ids = Array.from({ length: RUNS }, () => randomUUID()).sort();
      const low = ids[0] as string;
      // Inserted in DESCENDING id order, so heap order is the reverse of id
      // order too — the disagreement is the premise, and it costs nothing to
      // make it hold for the plans that do scan the heap.
      //
      // Abandoned by the sweep's own three conditions: `running`, a lease that
      // expired, and the grace period past on top of it. Arithmetic in SQL, not
      // a JavaScript Date, for the reason `claimedByAnother` gives.
      for (const id of [...ids].reverse()) {
        await db.execute(
          sql`INSERT INTO pipeline_runs (id, org_id, brand_id, input, status, active_job_id, lease_expires_at)
              VALUES (${id}, ${seeded.orgId}, ${seeded.brandId},
                      ${JSON.stringify({ kind: "brief", text: BRIEF, channelIds: [] })}::jsonb,
                      'running', ${`job-sweep-${id}`}, now() - interval '1 day')`,
        );
      }

      const repo = new Repository();
      const deleting = await pool.connect();
      let deleteError: string | null = null;
      let sweeping: PromiseSettledResult<unknown>;
      try {
        // `BrandsRepository.delete`, mid-walk: the brand is taken and the first
        // row of its ascending run set is held. Replayed as its statements
        // rather than called — it lives in the api, and this file drives the
        // worker.
        await deleting.query("BEGIN");
        const { rows } = await deleting.query("SELECT pg_backend_pid() AS pid");
        const deletingPid = (rows[0] as { pid: number }).pid;
        await deleting.query("SELECT id FROM brands WHERE id = $1 FOR UPDATE", [seeded.brandId]);
        await deleting.query("SELECT id FROM pipeline_runs WHERE id = $1 FOR UPDATE", [low]);

        const swept = repo.sweepAbandoned();
        await waitForBlockedBy(deletingPid, swept);

        // ...and now the delete walks on to the rest of its ordered set.
        deleteError = await deleting
          .query(
            `SELECT id, status FROM pipeline_runs
              WHERE org_id = $1 AND brand_id = $2 ORDER BY id FOR UPDATE`,
            [seeded.orgId, seeded.brandId],
          )
          .then(
            () => null,
            (error: { code?: string }) => String(error.code),
          );
        await deleting.query("COMMIT");
        [sweeping] = await Promise.allSettled([swept]);
      } finally {
        await deleting.query("ROLLBACK").catch(() => {});
        deleting.release();
      }

      expect(
        deleteError,
        "DELETE /api/brands/:id was the deadlock victim (40P01 -> 500)",
      ).toBeNull();
      expect(sweeping.status, "the sweep was the deadlock victim").toBe("fulfilled");
      // And every run was swept once the delete let go: it only READ them, so
      // the sweep's re-check under the lock still finds them abandoned.
      for (const id of ids) expect((await runRow(id))?.status).toBe("failed");
    }, 20_000);
  });
});
