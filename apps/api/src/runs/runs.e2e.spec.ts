import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EDITOR, editSchema, FACTCHECK, factcheckSchema, type RunStepContext } from "@pubrick/ai";
import { MAX_CONCURRENT_RUNS } from "@pubrick/shared";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("runs e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    // Migrations run once for the whole suite in vitest.global-setup.ts.
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    // Listen for the whole file: supertest otherwise starts the server per
    // request and closes it when that request ends, killing any other request
    // in flight (see content.e2e.spec.ts for the measurement).
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgAgent(): Promise<request.Agent> {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `u${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return agent;
  }

  async function brandWithChannel(agent: request.Agent) {
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    return { brandId: brand.body.id as string, channelId: channel.body.id as string };
  }

  /**
   * Drives a run to a terminal state the way the worker would. There is no
   * worker in this suite (Task 8 owns it), and the point of these tests is what
   * the API does with the resulting row, not how it got there.
   */
  async function setRunStatus(runId: string, status: string, error?: string) {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db.execute(
      `UPDATE pipeline_runs SET status = '${status}', error = ${error ? `'${error}'` : "NULL"},
         updated_at = now() WHERE id = '${runId}'`,
    );
    await pool.end();
  }

  /**
   * A model that answers with one canned JSON body. The V4 usage shape is
   * nested and `finishReason` is an object — a bare string passes vitest and
   * fails `tsc` (see `packages/ai`'s steps.test.ts, where both traps are
   * documented). NO provider is reached: house rule, and this suite has no key.
   */
  function jsonModel(text: string) {
    return new MockLanguageModelV4({
      modelId: "gemini-3.7-flash",
      doGenerate: async () => ({
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      }),
    });
  }

  function stepContext(model: MockLanguageModelV4): RunStepContext {
    return {
      brand: { name: "B", voice: null, audience: null, contentLanguage: "en" },
      brief: "Write about our new release",
      model,
      provider: "google",
      onUsage: () => {},
    };
  }

  /**
   * Checkpoint one step onto a run the way `GenerateRepository.writeCheckpoint`
   * does — `steps || $patch::jsonb`, on the real column.
   *
   * There is no worker in this suite, and the point of these tests is what the
   * API does with a real row rather than how the row got there. The VALUE is
   * not hand-written either: it is what the real step returned, so a test here
   * cannot pass by agreeing with a shape nobody produces.
   */
  async function checkpoint(runId: string, key: string, output: unknown) {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const patch = JSON.stringify({ [key]: { status: "succeeded", output } });
    await db.execute(
      sql`UPDATE pipeline_runs SET steps = steps || ${patch}::jsonb WHERE id = ${runId}`,
    );
    await pool.end();
  }

  /** Point a run at the item it produced, as the worker's terminal write does. */
  async function attachItem(runId: string, contentItemId: string | null) {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db.execute(
      sql`UPDATE pipeline_runs SET content_item_id = ${contentItemId}, status = 'succeeded'
            WHERE id = ${runId}`,
    );
    await pool.end();
  }

  /**
   * Deletes a row the API has no endpoint for. Both directions of the item/run
   * link have to survive the other end going away, and the FK behaviours that
   * make that true (`content_item_id` ON DELETE SET NULL; the run row outliving
   * the draft it bought) can only be exercised by removing the row.
   */
  async function deleteRow(table: "pipeline_runs" | "content_items", id: string) {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE id = ${id}`);
    await pool.end();
  }

  async function startRun(agent: request.Agent, brandId: string, channelIds: string[]) {
    const created = await agent
      .post("/api/runs")
      .send({ brandId, brief: "Write about our new release", channelIds })
      .expect(201);
    return created.body as { id: string; status: string; input: { channelIds: string[] } };
  }

  /** The org a brand belongs to. `orgAgent()` never exposes the id it created. */
  async function orgIdOfBrand(brandId: string): Promise<string> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(`SELECT org_id FROM brands WHERE id = '${brandId}'`);
    await pool.end();
    return (rows.rows[0] as { org_id: string }).org_id;
  }

  /**
   * Whether `promise` settles within `ms`. Used to assert that a request is
   * genuinely BLOCKED, which no amount of assertion on its eventual result can
   * show — the blocked and the unblocked case both end in a 201.
   */
  function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  it("queues a run and enqueues exactly one generate job for it", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const run = await startRun(agent, brandId, [channelId]);

    expect(run.status).toBe("queued");
    expect(run.input).toMatchObject({
      kind: "brief",
      text: "Write about our new release",
      channelIds: [channelId],
    });

    // The row alone proves nothing: the whole reason the insert and the send
    // share a transaction is that a `queued` run with no job behind it is a
    // stall nobody can see. Assert the job actually exists.
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job
         WHERE name = 'generate' AND data->>'runId' = '${run.id}'`,
    );
    await pool.end();
    expect((jobs.rows[0] as { n: number }).n).toBe(1);
  });

  it("refuses a brand with no channels (400): a run with no channels produces an item with zero adaptations", async () => {
    const agent = await orgAgent();
    const emptyBrand = await agent.post("/api/brands").send({ name: "No channels" }).expect(201);
    const { channelId } = await brandWithChannel(agent);

    // Whatever channel ids are offered, a brand with nothing to publish to is
    // refused up front and by name — not with "those channels aren't yours".
    const denied = await agent
      .post("/api/runs")
      .send({ brandId: emptyBrand.body.id, brief: "Anything", channelIds: [channelId] })
      .expect(400);
    expect(denied.body.message).toBe("This brand has no channels; add one before generating");
  });

  it("refuses an empty channelIds even on a brand that HAS channels: only the zod bound can say no", async () => {
    const agent = await orgAgent();
    // The brand is POPULATED on purpose. Sent against a channel-less brand this
    // assertion is dead: the 400 comes from resolveChannels, so relaxing
    // runCreateSchema to .min(0) stays green while `[]` on a real brand is
    // admitted 201 — producing exactly the item with zero adaptations that
    // spec §5 names as the reason the bound exists (approve marks it approved
    // and enqueues nothing). Here the repository has no complaint to make, so
    // the refusal can only come from channelIds.min(1).
    const { brandId } = await brandWithChannel(agent);

    const denied = await agent
      .post("/api/runs")
      .send({ brandId, brief: "Anything", channelIds: [] })
      .expect(400);
    expect(JSON.stringify(denied.body.message)).toContain("channelIds");

    // ...and nothing was created by the refused request.
    expect((await agent.get("/api/runs").expect(200)).body).toEqual([]);
  });

  it("refuses a fourth concurrent run (409) and names the limit", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);

    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
      await startRun(agent, brandId, [channelId]);
    }

    const denied = await agent
      .post("/api/runs")
      .send({ brandId, brief: "One too many", channelIds: [channelId] })
      .expect(409);
    // The number is in the message: "too many runs" leaves the user guessing
    // how many is too many, and the web app renders the same figure from the
    // shared MAX_CONCURRENT_RUNS.
    expect(denied.body.message).toContain(String(MAX_CONCURRENT_RUNS));

    // The cap counts only queued|running, so finishing one admits the next.
    const open = await agent.get("/api/runs?state=open").expect(200);
    await setRunStatus(open.body[0].id, "succeeded");
    await startRun(agent, brandId, [channelId]);
  });

  it("admits exactly the cap when the requests arrive at once, not one cap per racer", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);

    // Sequential creates cannot see this defect at all: under READ COMMITTED
    // ten simultaneous requests each read a count taken before any of the
    // others committed, all ten pass `inFlight < 3`, and the org runs ten.
    // That is why the count is taken under a per-org advisory lock, and this
    // is the only test that can tell the lock is there — deleting it leaves
    // every other test in this file green.
    const attempts = 10;
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        agent.post("/api/runs").send({ brandId, brief: "concurrent", channelIds: [channelId] }),
      ),
    );

    const admitted = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    expect(admitted).toHaveLength(MAX_CONCURRENT_RUNS);
    // Every loser is a 409 and nothing else — no 500 from a lost race.
    expect(refused).toHaveLength(attempts - MAX_CONCURRENT_RUNS);

    // The database agrees: the cap is on ROWS, not just on response codes.
    const open = await agent.get("/api/runs?state=open").expect(200);
    expect(open.body).toHaveLength(MAX_CONCURRENT_RUNS);
  }, 30_000);

  it("takes the admission lock per ORG: one org's create never waits behind another's", async () => {
    const held = await orgAgent();
    const heldBrand = await brandWithChannel(held);
    const free = await orgAgent();
    const freeBrand = await brandWithChannel(free);
    const heldOrgId = await orgIdOfBrand(heldBrand.brandId);

    const { createDb } = await import("@pubrick/db");
    const { pool } = createDb(url as string);
    const holder = await pool.connect();
    await holder.query("BEGIN");
    // The key is spelled out here rather than imported from the repository ON
    // PURPOSE. An imported key would mutate along with the code it is meant to
    // pin, and the mutation that matters — `hashtext(orgId)` replaced by a
    // constant, turning a per-org lock into a global one — is exactly the one
    // it would hide. Two independent copies, the same reasoning as this
    // codebase's rule about pinning request bodies twice. (The namespace
    // matches ADMISSION_LOCK_NAMESPACE in runs.repository.ts; the two-argument
    // advisory-lock space is disjoint from the one-argument space
    // runMigrations uses.)
    await holder.query("SELECT pg_advisory_xact_lock(0x7a11, hashtext($1))", [heldOrgId]);

    try {
      // A different org must sail straight through. Under a global lock this
      // request waits for a transaction that is never going to commit.
      const unrelated = Promise.resolve(
        free.post("/api/runs").send({
          brandId: freeBrand.brandId,
          brief: "other org",
          channelIds: [freeBrand.channelId],
        }),
      );
      expect(await settlesWithin(unrelated, 8_000)).toBe(true);
      expect((await unrelated).status).toBe(201);

      // ...while the org whose lock we hold genuinely waits. Without this half
      // the test would also pass if the repository took no lock at all.
      const blocked = Promise.resolve(
        held.post("/api/runs").send({
          brandId: heldBrand.brandId,
          brief: "same org",
          channelIds: [heldBrand.channelId],
        }),
      );
      expect(await settlesWithin(blocked, 1_500)).toBe(false);

      await holder.query("ROLLBACK");
      expect((await blocked).status).toBe(201);
    } finally {
      holder.release();
      await pool.end();
    }
  }, 30_000);

  it("caps by org, not globally: another org is unaffected", async () => {
    const first = await orgAgent();
    const firstBrand = await brandWithChannel(first);
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
      await startRun(first, firstBrand.brandId, [firstBrand.channelId]);
    }
    await first
      .post("/api/runs")
      .send({ brandId: firstBrand.brandId, brief: "x", channelIds: [firstBrand.channelId] })
      .expect(409);

    const second = await orgAgent();
    const secondBrand = await brandWithChannel(second);
    await startRun(second, secondBrand.brandId, [secondBrand.channelId]);
  });

  it("cancels a queued run: status moves to cancelled, the job is cancelled, updated_at advances", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const run = await startRun(agent, brandId, [channelId]);
    const before = await agent.get(`/api/runs/${run.id}`).expect(200);

    const cancelled = await agent.post(`/api/runs/${run.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe("cancelled");
    // Raw-SQL updates do not fire Drizzle's $onUpdate; this write goes through
    // the query builder precisely so the timestamp cannot silently freeze.
    expect(new Date(cancelled.body.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.body.updatedAt).getTime(),
    );

    // Flipping the status alone would not be a cancellation: the job would keep
    // spending the org's money and then write a content item nobody asked for.
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'generate' AND data->>'runId' = '${run.id}'`,
    );
    await pool.end();
    expect((jobs.rows[0] as { state: string }).state).toBe("cancelled");

    // Cancelling twice is refused in the words of the status on screen.
    const again = await agent.post(`/api/runs/${run.id}/cancel`).expect(409);
    expect(again.body.message).toBe("This run has already been cancelled");
  });

  it("keeps a failed, undismissed run on the open list and drops it once dismissed", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const failed = await startRun(agent, brandId, [channelId]);
    const queued = await startRun(agent, brandId, [channelId]);
    await setRunStatus(failed.id, "failed", "too_long_for_channel");

    const open = await agent.get("/api/runs?state=open").expect(200);
    const ids = open.body.map((run: { id: string }) => run.id);
    expect(ids).toContain(failed.id);
    expect(ids).toContain(queued.id);
    // Failures sort first: a failed run creates no content item, so a strip
    // buried under successful chatter is a failure that is invisible everywhere.
    expect(open.body[0].id).toBe(failed.id);
    // A CODE on the wire, under a name that says so. The column it comes from
    // used to hold the provider's own error sentence — the sentence that quotes
    // the submitted API key back — and this is the response that carried it to
    // a browser.
    expect(open.body[0].errorCode).toBe("too_long_for_channel");
    expect(open.body[0].error).toBeUndefined();

    const dismissed = await agent.post(`/api/runs/${failed.id}/dismiss`).expect(200);
    expect(dismissed.body.dismissedAt).not.toBeNull();

    const after = await agent.get("/api/runs?state=open").expect(200);
    expect(after.body.map((run: { id: string }) => run.id)).not.toContain(failed.id);
    // Dismissing clears the strip, never the record: the run is still there.
    const all = await agent.get("/api/runs").expect(200);
    expect(all.body.map((run: { id: string }) => run.id)).toContain(failed.id);
  });

  /**
   * The other half of `DISMISSABLE_RUN_STATUSES`, and it was unpinned: the test
   * above covers `failed`, the one below covers `succeeded` leaving on its own,
   * and nothing covered `cancelled` — so dropping it from the dismissable set
   * changed the strip a user actually looks at and no test noticed. A cancelled
   * run creates no content item either; if its entry vanished the moment it was
   * cancelled, the only trace of the money already spent would be gone from the
   * one screen that shows it.
   *
   * Cancelled through the real endpoint rather than by writing the status, so
   * this is the shape the strip meets in production.
   */
  it("keeps a cancelled, undismissed run on the open list and drops it once dismissed", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const run = await startRun(agent, brandId, [channelId]);
    await agent.post(`/api/runs/${run.id}/cancel`).expect(200);

    const open = await agent.get("/api/runs?state=open").expect(200);
    expect(open.body.map((r: { id: string }) => r.id)).toContain(run.id);

    await agent.post(`/api/runs/${run.id}/dismiss`).expect(200);
    const after = await agent.get("/api/runs?state=open").expect(200);
    expect(after.body.map((r: { id: string }) => r.id)).not.toContain(run.id);
    const all = await agent.get("/api/runs").expect(200);
    expect(all.body.map((r: { id: string }) => r.id)).toContain(run.id);
  });

  it("hides a succeeded run from the open list without needing a dismiss", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const run = await startRun(agent, brandId, [channelId]);
    await setRunStatus(run.id, "succeeded");

    const open = await agent.get("/api/runs?state=open").expect(200);
    expect(open.body.map((r: { id: string }) => r.id)).not.toContain(run.id);
    // ...and a run still in flight cannot be dismissed off the strip.
    const live = await startRun(agent, brandId, [channelId]);
    const denied = await agent.post(`/api/runs/${live.id}/dismiss`).expect(409);
    expect(denied.body.message).toBe("A queued run cannot be dismissed; cancel it first");
  });

  it("400s an unknown state without pretending it is a status enum member", async () => {
    const agent = await orgAgent();
    const denied = await agent.get("/api/runs?state=queued").expect(400);
    // `queued` IS a run status, and that is the point: `state` is a different
    // vocabulary, so copying the content list's status validation here would
    // have rejected `open` — the only value the queue strip ever sends.
    expect(denied.body.message).toContain("Expected one of: open, all");
    await agent.get("/api/runs?state=open").expect(200);
  });

  it("scopes every run to its org — on the open list the queue strip actually polls, too", async () => {
    const owner = await orgAgent();
    const ownerBrand = await brandWithChannel(owner);
    const theirs = await startRun(owner, ownerBrand.brandId, [ownerBrand.channelId]);

    const stranger = await orgAgent();
    const strangerBrand = await brandWithChannel(stranger);
    const own = await startRun(stranger, strangerBrand.brandId, [strangerBrand.channelId]);

    await stranger.get(`/api/runs/${theirs.id}`).expect(404);
    await stranger.post(`/api/runs/${theirs.id}/cancel`).expect(404);
    await stranger.post(`/api/runs/${theirs.id}/dismiss`).expect(404);

    // BOTH list paths, and `?state=open` above all: it is the one the queue
    // strip polls on every tick, so an org filter that held only on the
    // unfiltered branch would leak every tenant's runs onto the busiest screen
    // in the app while a tenancy test that never sent `state` stayed green.
    // Asserted positively — the stranger has a run of its own — so an empty
    // result cannot pass for correct scoping.
    for (const path of ["/api/runs", "/api/runs?state=open"]) {
      const listed = (await stranger.get(path).expect(200)).body as { id: string }[];
      expect(listed.map((run) => run.id)).toEqual([own.id]);
    }
  });

  /**
   * A channel row owned by ANOTHER org while pointing at THIS brand.
   *
   * Nothing in the database forbids it (`channels.brand_id` and
   * `channels.org_id` are independent references), and no endpoint will create
   * it — which is exactly why it has to be planted from underneath the API. It
   * is the only shape that reaches the org predicate on `resolveChannels`'s
   * second read: every channel a caller can create through the API already
   * agrees with its brand's org, so `brand_id` alone answers correctly and the
   * org filter next to it is never asked anything.
   */
  async function foreignChannelOnBrand(brandId: string): Promise<string> {
    const stranger = await orgAgent();
    const strangerBrand = await brandWithChannel(stranger);
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (
      await db.execute(
        `SELECT org_id, credentials_encrypted FROM channels WHERE id = '${strangerBrand.channelId}'`,
      )
    ).rows as { org_id: string; credentials_encrypted: string }[];
    const inserted = await db
      .insert(schema.channels)
      .values({
        orgId: row?.org_id as string,
        brandId,
        platform: "telegram",
        name: "Theirs, filed under your brand",
        credentialsEncrypted: row?.credentials_encrypted as string,
      })
      .returning({ id: schema.channels.id });
    await pool.end();
    return inserted[0]?.id as string;
  }

  it("404s a run against another org's brand — and says the brand is missing, not that it has no channels", async () => {
    const owner = await orgAgent();
    const theirs = await brandWithChannel(owner);

    const stranger = await orgAgent();
    const mine = await brandWithChannel(stranger);

    const denied = await stranger
      .post("/api/runs")
      .send({
        brandId: theirs.brandId,
        brief: "Write about their release",
        channelIds: [theirs.channelId],
      })
      .expect(404);
    // The MESSAGE is the assertion, not just the refusal. Drop the org
    // predicate from the brand read and this request is still refused — by the
    // channel read, which finds no channel of this org on that brand and calls
    // it "this brand has no channels", a 400. Two different checks, two
    // different codes, and only one of them is the one that must hold.
    expect(denied.body.message).toBe("Brand not found");

    // The stranger's own brand still starts a run, so the refusal above is
    // scoping and not an endpoint that turns everything down.
    const own = await startRun(stranger, mine.brandId, [mine.channelId]);
    expect(own.status).toBe("queued");
  });

  it("404s a channel that belongs to another org even when it names this brand", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const foreign = await foreignChannelOnBrand(brandId);

    // Refused by the org predicate on the channel read alone: `brand_id`
    // matches, and the run would otherwise fan a generated post out through
    // another org's bot token.
    const denied = await agent
      .post("/api/runs")
      .send({ brandId, brief: "x", channelIds: [foreign] })
      .expect(404);
    expect(denied.body.message).toBe("One or more channels do not belong to this brand");

    // The MIXED request, which is what the ownership check is really for: one
    // channel the caller owns and one it does not. `some(id => !owned.has(id))`
    // refuses it; `every(...)` — one character of difference — sees the first
    // id is owned, decides the request is fine, and starts a run that publishes
    // to a stranger's channel.
    await agent
      .post("/api/runs")
      .send({ brandId, brief: "x", channelIds: [channelId, foreign] })
      .expect(404);

    // ...and the caller's own channel alone still starts a run.
    const own = await startRun(agent, brandId, [channelId]);
    expect(own.input.channelIds).toEqual([channelId]);
  });

  it("refuses a channel from another brand (404) and a duplicated channel (400)", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const other = await brandWithChannel(agent);

    await agent
      .post("/api/runs")
      .send({ brandId, brief: "x", channelIds: [other.channelId] })
      .expect(404);

    // A repeat is a PAID adapter call made twice for one channel, so it is
    // rejected rather than quietly deduped.
    await agent
      .post("/api/runs")
      .send({ brandId, brief: "x", channelIds: [channelId, channelId] })
      .expect(400);
  });
  /**
   * The step whose whole purpose is honesty about what it could not verify.
   *
   * Its output is generated, billed and stored on the run — and until the run
   * receipt learned to render it, nobody could read it. The endpoint is the
   * first half of that road: `RUN_DETAIL_COLUMNS` is what decides whether the
   * list ever leaves the database.
   */
  describe("a run's step output reaches the client", () => {
    it("hands back the fact-checker's own list, unchanged, from a real run row", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);

      // The REAL step, against a mock model. The value written to the column is
      // therefore the shape the worker actually produces, not one this test
      // invented and then confirmed.
      const model = jsonModel(
        JSON.stringify({
          claims: [
            { text: "Revenue tripled in the second quarter.", needsCheck: true },
            { text: "Our office is in Lisbon.", needsCheck: false },
          ],
        }),
      );
      const produced = await FACTCHECK.run(stepContext(model), { body: "A draft." });
      await checkpoint(run.id, FACTCHECK.name, produced);

      const got = await agent.get(`/api/runs/${run.id}`).expect(200);

      // Parsed with the step's OWN schema rather than compared to a literal: a
      // field renamed upstream fails here instead of quietly arriving as a key
      // the receipt does not render.
      const output = factcheckSchema.parse(got.body.steps[FACTCHECK.name].output);
      expect(output).toEqual(produced);
      expect(output.claims).toHaveLength(2);
      expect(got.body.steps[FACTCHECK.name].status).toBe("succeeded");
    });

    it("hands back the editor's change notes the same way", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);

      const model = jsonModel(
        JSON.stringify({ body: "The edited post.", changes: ["Cut the closing line."] }),
      );
      const produced = await EDITOR.run(stepContext(model), {
        research: { angle: "A", keyPoints: ["p"], avoid: [] },
        body: "A draft.",
      });
      await checkpoint(run.id, EDITOR.name, produced);

      const got = await agent.get(`/api/runs/${run.id}`).expect(200);

      expect(editSchema.parse(got.body.steps[EDITOR.name].output)).toEqual(produced);
    });

    /**
     * ...and the LIST still does not carry it. Each checkpoint holds that
     * step's whole model output, so a queue strip of a dozen runs would ship
     * several hundred kilobytes of draft text on every poll to draw rows that
     * read three columns. The detail/list split is what the receipt's data now
     * depends on, in both directions.
     */
    it("keeps the checkpoint map off the queue strip", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);
      await checkpoint(run.id, FACTCHECK.name, { claims: [] });

      const list = await agent.get("/api/runs").expect(200);
      const row = (list.body as Array<{ id: string }>).find((r) => r.id === run.id);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("steps");
      // ...while the same run, asked for by id, has it.
      expect((await agent.get(`/api/runs/${run.id}`).expect(200)).body.steps).toBeDefined();
    });

    it("refuses a run belonging to another org rather than leaking its output", async () => {
      const owner = await orgAgent();
      const theirs = await brandWithChannel(owner);
      const run = await startRun(owner, theirs.brandId, [theirs.channelId]);
      await checkpoint(run.id, FACTCHECK.name, {
        claims: [{ text: "A private claim.", needsCheck: true }],
      });

      const stranger = await orgAgent();
      await stranger.get(`/api/runs/${run.id}`).expect(404);
    });
  });

  /**
   * The receipt has to stay reachable FROM the finished item, which means the
   * item has to know which run made it. The run already carries the item's id;
   * this is the reverse, and it rides on the item's own response rather than a
   * second endpoint — the item screen already reads (and polls) the item, so a
   * property costs no round trip and cannot go stale against the thing it
   * describes.
   */
  describe("an item points back at the run that made it", () => {
    async function itemOn(agent: request.Agent, brandId: string, channelId: string) {
      const created = await agent
        .post("/api/content")
        .send({ brandId, channelIds: [channelId], title: "T", body: "A body." })
        .expect(201);
      return created.body.id as string;
    }

    it("reports the run id on the item the run produced", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);
      const itemId = await itemOn(agent, brandId, channelId);
      await attachItem(run.id, itemId);

      const item = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(item.body.runId).toBe(run.id);

      // ...and the forward direction still holds on the same pair, so the link
      // is a round trip rather than two half-facts.
      const back = await agent.get(`/api/runs/${run.id}`).expect(200);
      expect(back.body.contentItemId).toBe(itemId);
    });

    it("reports no run for a hand-written item — the ordinary case", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const itemId = await itemOn(agent, brandId, channelId);

      const item = await agent.get(`/api/content/${itemId}`).expect(200);
      // The key is PRESENT and null: a missing key and "nothing generated this"
      // are different answers, and the screen renders one of them.
      expect(item.body).toHaveProperty("runId", null);
    });

    it("reports no run for an item whose run is gone", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);
      const itemId = await itemOn(agent, brandId, channelId);
      await attachItem(run.id, itemId);
      expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.runId).toBe(run.id);

      await deleteRow("pipeline_runs", run.id);

      // The draft survives its receipt, and says so rather than 500ing or
      // offering a link to a run that is not there.
      expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.runId).toBeNull();
    });

    it("keeps the run when its item is deleted, and drops the dead item id", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);
      const itemId = await itemOn(agent, brandId, channelId);
      await attachItem(run.id, itemId);
      await checkpoint(run.id, FACTCHECK.name, {
        claims: [{ text: "Revenue tripled.", needsCheck: true }],
      });

      await deleteRow("content_items", itemId);

      // ON DELETE SET NULL, not cascade: a run is the record of what the org
      // was charged and must outlive the draft it bought — so the receipt, and
      // the claims on it, are still readable.
      const got = await agent.get(`/api/runs/${run.id}`).expect(200);
      expect(got.body.contentItemId).toBeNull();
      expect(got.body.status).toBe("succeeded");
      expect(factcheckSchema.parse(got.body.steps[FACTCHECK.name].output).claims).toHaveLength(1);
    });

    it("never reports another org's run on this org's item", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const itemId = await itemOn(agent, brandId, channelId);

      // A run of a DIFFERENT org, pointed at this org's item — which the FK
      // permits and only the org predicate on the lookup refuses. Drop that
      // predicate and this item starts naming a stranger's receipt.
      const stranger = await orgAgent();
      const theirs = await brandWithChannel(stranger);
      const foreignRun = await startRun(stranger, theirs.brandId, [theirs.channelId]);
      await attachItem(foreignRun.id, itemId);

      expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.runId).toBeNull();
    });
  });
  /**
   * A RUN'S REFUSALS NAME THEMSELVES — through the HTTP response, so the code
   * is proved to survive the exception filter and JSON serialisation and not
   * merely to exist on a thrown object.
   *
   * The English sentence is asserted beside every code on purpose: it is the
   * developer's, the API consumer's, and an older web build's only account of
   * what happened, and a change that replaced it with the code would pass a
   * code-only assertion.
   */
  describe("coded refusals", () => {
    it("codes the admission cap WITHOUT putting the limit on the wire", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) await startRun(agent, brandId, [channelId]);

      const denied = await agent
        .post("/api/runs")
        .send({ brandId, brief: "One too many", channelIds: [channelId] })
        .expect(409);

      expect(denied.body.code).toBe("run_limit_reached");
      // The code is NULLARY. The number stays in the English sentence for the
      // developer, and the web fills its own from the shared MAX_CONCURRENT_RUNS
      // rather than parsing it back out of prose it cannot read in Russian.
      expect(denied.body.message).toContain(String(MAX_CONCURRENT_RUNS));
      expect(denied.body.code).not.toContain(String(MAX_CONCURRENT_RUNS));
    });

    it("codes a brand with nothing to publish to apart from a brand that is gone", async () => {
      const agent = await orgAgent();
      const emptyBrand = await agent.post("/api/brands").send({ name: "No channels" }).expect(201);
      const { channelId } = await brandWithChannel(agent);

      const noChannels = await agent
        .post("/api/runs")
        .send({ brandId: emptyBrand.body.id, brief: "Anything", channelIds: [channelId] })
        .expect(400);
      expect(noChannels.body.code).toBe("brand_has_no_channels");
      expect(noChannels.body.message).toBe("This brand has no channels; add one before generating");

      const missing = await agent
        .post("/api/runs")
        .send({ brandId: randomUUID(), brief: "Anything", channelIds: [channelId] })
        .expect(404);
      expect(missing.body.code).toBe("brand_not_found");
    });

    it("codes a channel that is not this brand's", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const other = await brandWithChannel(agent);

      const denied = await agent
        .post("/api/runs")
        .send({ brandId, brief: "Anything", channelIds: [channelId, other.channelId] })
        .expect(404);
      expect(denied.body.code).toBe("channels_not_in_brand");
    });

    it("codes cancel and dismiss by the status on screen, one code per status", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);

      // Live: dismissable is what it is NOT.
      const queued = await agent.post(`/api/runs/${run.id}/dismiss`).expect(409);
      expect(queued.body.code).toBe("run_not_dismissable_queued");
      expect(queued.body.message).toBe("A queued run cannot be dismissed; cancel it first");

      await setRunStatus(run.id, "running");
      const running = await agent.post(`/api/runs/${run.id}/dismiss`).expect(409);
      expect(running.body.code).toBe("run_not_dismissable_running");

      // Terminal: cancellable is what it is NOT, and each terminal status says
      // a different true thing — which is why there are three codes and not one
      // code carrying a status argument.
      for (const [status, code] of [
        ["succeeded", "run_not_cancellable_succeeded"],
        ["failed", "run_not_cancellable_failed"],
        ["cancelled", "run_not_cancellable_cancelled"],
      ] as const) {
        await setRunStatus(run.id, status);
        const refused = await agent.post(`/api/runs/${run.id}/cancel`).expect(409);
        expect(refused.body.code, status).toBe(code);
      }
    });

    it("codes a run that is gone", async () => {
      const agent = await orgAgent();
      const missing = await agent.get(`/api/runs/${randomUUID()}`).expect(404);
      expect(missing.body.code).toBe("run_not_found");
      expect(missing.body.message).toBe("Run not found");
    });
  });
});
