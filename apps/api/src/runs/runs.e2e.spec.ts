import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EDITOR, editSchema, FACTCHECK, factcheckSchema, type RunStepContext } from "@pubrick/ai";
import {
  MAX_CONCURRENT_RUNS,
  MAX_SOURCE_TEXT_LENGTH,
  runDetailDtoSchema,
  runDtoSchema,
  runInputSchema,
  sourceRunInputSchema,
} from "@pubrick/shared";
import { MockLanguageModelV4 } from "ai/test";
import { inArray, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

/**
 * Where the owner reads the gate query (`docs/specs/0003-ai-generation-engine.md`
 * §12), and the heading the fence sits under.
 *
 * Found by walking up from the working directory rather than from
 * `import.meta.url`: `apps/api` compiles as CommonJS (`tsc` refuses
 * `import.meta` under it) while vitest runs the file as ESM, so neither
 * `__dirname` nor `import.meta` exists in both.
 *
 * The walk stops at the repository root — the directory holding
 * `pnpm-workspace.yaml` — and the stop is CHECKED, not assumed. Without it the
 * loop stops at the first ancestor that happens to hold `docs/specs`, which for
 * a worktree placed beneath another pubrick checkout (this owner's habit) is
 * the PARENT checkout: a §12 renamed here would then silently be validated
 * against the neighbour's document.
 */
const GATE_DOC = (() => {
  const relative = join("docs", "specs", "0003-ai-generation-engine.md");
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const candidate = join(dir, relative);
      if (existsSync(candidate)) return candidate;
      throw new Error(`${relative} is missing from the workspace root ${dir}`);
    }
    if (dirname(dir) === dir) throw new Error(`no pnpm-workspace.yaml above ${process.cwd()}`);
  }
})();
const GATE_SECTION = "## 12. The gate before increment 3b, and the query that measures it";

/**
 * This file's copy of the gate query, byte for byte as §12 carries it.
 *
 * §12 supersedes the watched-sources design's copy (at `cf2077e6`), whose
 * volume clause counted raw URLs: one article pasted with a `#:~:text=` or a
 * `utm_source` scored as several stories, which is the person the design's §5
 * wrote the clause to exclude. The document says so; this is the copy that runs.
 *
 * `String.raw` because `'^www\.'` must survive into the SQL: written as an
 * ordinary template literal, JavaScript eats the backslash, the regex becomes
 * `^www.` — any character — and `wwwXexample.com` would fold too.
 */
const GATE_SQL = String.raw`-- Per org, per week: the distinct stories a watcher could have fetched (the
-- threshold), the runs they cost and how many of those failed (context), the
-- URL-less pastes (context, not evidence), and the hosts.
with pastes as (
  select org_id,
         date_trunc('week', created_at) as week,
         status,
         input->>'sourceUrl' as url,
         -- The address with the fragment, the query and the scheme cut away.
         split_part(split_part(split_part(input->>'sourceUrl', '#', 1), '?', 1),
                    '://', 2) as trimmed
  from pipeline_runs
  where input->>'kind' = 'source'
),
source_runs as (
  select org_id, week, status, url,
         nullif(regexp_replace(lower(split_part(trimmed, '/', 1)), '^www\.', '')
                || rtrim(regexp_replace(trimmed, '^[^/]*', ''), '/'), '') as story,
         nullif(regexp_replace(
           lower(split_part(split_part(url, '://', 2), '/', 1)),
           '^www\.', ''), '') as host
  from pastes
)
select org_id,
       week,
       count(distinct story)                     as watchable_stories,
       count(*) filter (where url is not null)   as watchable_runs,
       count(*) filter (where url is not null
                          and status in ('failed', 'cancelled')) as failed_runs,
       count(*) filter (where url is null)       as urlless_runs,
       array_agg(distinct host) filter (where host is not null) as hosts
from source_runs
group by 1, 2
order by 1, 2;
`;

/**
 * The fenced `sql` block under §12's heading, as the document carries it.
 *
 * The slice is bounded by the NEXT `## ` heading, not by the end of the file.
 * §12 is last today; a §13 carrying its own `sql` fence, plus a fence renamed
 * or removed here, would otherwise extract §13's query and fail while naming
 * the wrong section.
 */
function gateSqlFromDoc(): string {
  const doc = readFileSync(GATE_DOC, "utf8");
  const at = doc.indexOf(GATE_SECTION);
  expect(at, `${GATE_DOC} no longer has the section holding the gate query`).toBeGreaterThan(-1);
  const after = doc.slice(at + GATE_SECTION.length);
  const end = after.indexOf("\n## ");
  const section = end === -1 ? after : after.slice(0, end);
  const fence = /```sql\n([\s\S]*?)```/.exec(section)?.[1];
  expect(fence, `${GATE_SECTION} no longer contains a fenced sql block`).toBeDefined();
  return fence as string;
}

/**
 * The parity ratchet reads two files and touches no database, so it runs
 * WHEREVER the suite runs — outside the `skipIf` below. The parity assertion is
 * the thing that stops the owner reading a threshold off a paragraph whose SQL
 * no test has ever executed; it is the last assertion that should be allowed to
 * vanish when `TEST_DATABASE_URL` is unset.
 */
describe("the gate query the document carries", () => {
  it("runs the same query the document tells the owner to run", () => {
    expect(gateSqlFromDoc()).toBe(GATE_SQL);
  });

  /** The threshold is a number in prose; prose is what goes stale first. */
  it("keeps the threshold, and the date it was chosen, beside the query", () => {
    const doc = readFileSync(GATE_DOC, "utf8");
    const section = doc.slice(doc.indexOf(GATE_SECTION));
    expect(section).toContain("five distinct URLs a week");
    expect(section).toContain("four consecutive weeks");
    expect(section).toContain("three of those four weeks");
    expect(section).toContain("chosen, not measured");
    expect(section).toContain("2026-09-11, branch `feat/paste-a-story`");
  });
});

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
      // Required-and-nullable on `RunStepContext`: a builder that has no pasted
      // material says so. Omitting them would still RUN here — vitest strips
      // types — with `undefined` reaching the steps' block predicates.
      material: null,
      sourceUrl: null,
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

  /**
   * Loses `n` billed calls on a run, the way the worker does when the ledger
   * refuses a row: `coalesce(unrecorded_calls, 0) + 1`, evaluated by Postgres,
   * once per loss (`GenerateRepository.recordUnrecordedCall`). Not `SET … = n`,
   * because the reader under test must see the value the writer produces, and
   * the writer only ever adds one.
   */
  async function loseCalls(runId: string, n: number) {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    for (let i = 0; i < n; i++) {
      await db.execute(
        sql`UPDATE pipeline_runs SET unrecorded_calls = coalesce(unrecorded_calls, 0) + 1
              WHERE id = ${runId}`,
      );
    }
    await pool.end();
  }

  /**
   * Turns a run into one that predates migration 0013: the counter is NULL,
   * "nothing is known", which is what every historical row was left holding
   * on purpose. The api has no path that writes NULL, so this is the only way
   * to put the value in front of the reader.
   */
  async function forgetLosses(runId: string) {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db.execute(sql`UPDATE pipeline_runs SET unrecorded_calls = NULL WHERE id = ${runId}`);
    await pool.end();
  }

  /** One provider-priced ledger row on a run, as the worker's `recordUsage` writes it. */
  async function pricedCall(runId: string, costUsd: string) {
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const orgId = (await db.execute(sql`SELECT org_id FROM pipeline_runs WHERE id = ${runId}`))
      .rows[0] as { org_id: string };
    await db.insert(schema.usageLedger).values({
      orgId: orgId.org_id,
      runId,
      step: "writer",
      provider: "google",
      modelId: "gemini-3.7-flash",
      inputTokens: 900,
      outputTokens: 120,
      costUsd,
      costSource: "provider_reported",
      status: "ok",
      outcome: "completed",
    });
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

  it("requires a Google key for an opted-in cover and preserves the choice on retry", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const requestBody = {
      brandId,
      brief: "Illustrate the new release",
      channelIds: [channelId],
      generateCover: true,
    };
    const denied = await agent.post("/api/runs").send(requestBody).expect(400);
    expect(denied.body.code).toBe("cover_requires_google_key");
    expect((await agent.get("/api/runs").expect(200)).body).toEqual([]);

    const { createDb, schema } = await import("@pubrick/db");
    const { encryptJson, runDetailDtoSchema } = await import("@pubrick/shared");
    const { db, pool } = createDb(url as string);
    const orgId = await orgIdOfBrand(brandId);
    await db.insert(schema.aiCredentials).values({
      orgId,
      provider: "google",
      credentialsEncrypted: encryptJson(
        { apiKey: "test-google-key" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    await pool.end();

    const first = runDetailDtoSchema.parse(
      (await agent.post("/api/runs").send(requestBody).expect(201)).body,
    );
    expect(first.input.generateCover).toBe(true);
    const retried = runDetailDtoSchema.parse(
      (await agent.post(`/api/runs/${first.id}/retry`).expect(201)).body,
    );
    expect(retried.input.generateCover).toBe(true);

    const budget = createDb(url as string);
    await budget.db.insert(schema.usageLedger).values(
      Array.from({ length: 10 }, () => ({
        orgId,
        step: "image_generate",
        provider: "google" as const,
        modelId: "gemini-3.1-flash-image",
        costSource: "unknown" as const,
        status: "ok" as const,
        outcome: "completed" as const,
      })),
    );
    await budget.pool.end();
    const capped = await agent.post("/api/runs").send(requestBody).expect(409);
    expect(capped.body.code).toBe("media_generation_limit");
  });

  it("keeps editorial feedback off by default and records an explicit empty opt-in", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const base = { brandId, brief: "A new announcement", channelIds: [channelId] };

    const ordinary = runDetailDtoSchema.parse(
      (await agent.post("/api/runs").send(base).expect(201)).body,
    );
    expect(ordinary.input).not.toHaveProperty("useEditorialFeedback");
    expect(ordinary.input).not.toHaveProperty("editorialFeedback");

    const optedIn = runDetailDtoSchema.parse(
      (
        await agent
          .post("/api/runs")
          .send({ ...base, useEditorialFeedback: true })
          .expect(201)
      ).body,
    );
    expect(optedIn.input).toMatchObject({
      useEditorialFeedback: true,
      editorialFeedback: [],
    });
    const listed = (await agent.get("/api/runs?state=open").expect(200)).body as Array<{
      id: string;
      input: Record<string, unknown>;
    }>;
    expect(listed.find((row) => row.id === optedIn.id)?.input).toMatchObject({
      useEditorialFeedback: true,
    });
    expect(listed.every((row) => !("editorialFeedback" in row.input))).toBe(true);
  });

  it("snapshots at most five latest notes from this organization and brand in stable order", async () => {
    const agent = await orgAgent();
    const outsider = await orgAgent();
    const own = await brandWithChannel(agent);
    const otherBrand = await brandWithChannel(agent);
    const foreign = await brandWithChannel(outsider);

    async function noteFor(
      owner: request.Agent,
      brandId: string,
      channelId: string,
      body: string,
      note: string,
    ): Promise<string> {
      const item = await owner
        .post("/api/content")
        .send({ brandId, channelIds: [channelId], body })
        .expect(201);
      const created = await owner
        .post(`/api/content/${item.body.id}/editorial-notes`)
        .send({ expectedBody: body, note })
        .expect(201);
      return created.body.id as string;
    }

    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(
        await noteFor(
          agent,
          own.brandId,
          own.channelId,
          `Draft ${i}`,
          `Note ${i} ${"x".repeat(600)}`,
        ),
      );
    }
    await noteFor(agent, otherBrand.brandId, otherBrand.channelId, "Other brand", "Wrong brand");
    await noteFor(outsider, foreign.brandId, foreign.channelId, "Other org", "Wrong org");

    // Force a timestamp tie. Ordering must still be total through the UUID.
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db
      .update(schema.editorialNotes)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(inArray(schema.editorialNotes.id, ids));
    await pool.end();

    const created = runDetailDtoSchema.parse(
      (
        await agent
          .post("/api/runs")
          .send({
            brandId: own.brandId,
            brief: "Learn from these notes",
            channelIds: [own.channelId],
            useEditorialFeedback: true,
          })
          .expect(201)
      ).body,
    );
    expect(created.input.editorialFeedback?.map((entry) => entry.id)).toEqual(
      ids.sort().reverse().slice(0, 5),
    );
    expect(created.input.editorialFeedback).toHaveLength(5);
    expect(created.input.editorialFeedback?.every((entry) => entry.note.length === 500)).toBe(true);
    const listed = (await agent.get("/api/runs?state=open").expect(200)).body as Array<{
      id: string;
      input: Record<string, unknown>;
    }>;
    expect(listed.find((row) => row.id === created.id)?.input).not.toHaveProperty(
      "editorialFeedback",
    );
  });

  it("retries an opted-in run with a fresh note snapshot and leaves its first receipt intact", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const item = await agent
      .post("/api/content")
      .send({ brandId, channelIds: [channelId], body: "Draft for feedback" })
      .expect(201);
    const notesPath = `/api/content/${item.body.id}/editorial-notes`;
    const firstNote = await agent
      .post(notesPath)
      .send({ expectedBody: "Draft for feedback", note: "Use a clearer opening" })
      .expect(201);
    const original = runDetailDtoSchema.parse(
      (
        await agent
          .post("/api/runs")
          .send({
            brandId,
            brief: "Write a post",
            channelIds: [channelId],
            useEditorialFeedback: true,
          })
          .expect(201)
      ).body,
    );
    expect(original.input.editorialFeedback).toEqual([
      { id: firstNote.body.id, note: "Use a clearer opening" },
    ]);
    const secondNote = await agent
      .post(notesPath)
      .send({ expectedBody: "Draft for feedback", note: "Specify the audience" })
      .expect(201);
    const retried = runDetailDtoSchema.parse(
      (await agent.post(`/api/runs/${original.id}/retry`).expect(201)).body,
    );
    expect(retried.input.useEditorialFeedback).toBe(true);
    expect(retried.input.editorialFeedback).toHaveLength(2);
    expect(new Set(retried.input.editorialFeedback?.map((entry) => entry.id))).toEqual(
      new Set([firstNote.body.id, secondNote.body.id]),
    );
    const firstReceipt = runDetailDtoSchema.parse(
      (await agent.get(`/api/runs/${original.id}`).expect(200)).body,
    );
    expect(firstReceipt.input.editorialFeedback).toEqual(original.input.editorialFeedback);
  });

  it("keeps a valid JSONB snapshot when the note limit lands inside an emoji", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const item = await agent
      .post("/api/content")
      .send({ brandId, channelIds: [channelId], body: "Draft for Unicode feedback" })
      .expect(201);
    await agent
      .post(`/api/content/${item.body.id}/editorial-notes`)
      .send({ expectedBody: "Draft for Unicode feedback", note: `${"x".repeat(499)}😌` })
      .expect(201);

    const run = runDetailDtoSchema.parse(
      (
        await agent
          .post("/api/runs")
          .send({
            brandId,
            brief: "Write a post",
            channelIds: [channelId],
            useEditorialFeedback: true,
          })
          .expect(201)
      ).body,
    );
    expect(run.input.editorialFeedback?.[0]?.note).toBe("x".repeat(499));
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
    // the generation-engine spec's §5 names as the reason the bound exists (approve marks it approved
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

  /**
   * What a run asked for from pasted material actually STORES.
   *
   * `pipeline_runs.input` is a receipt: the run screen renders it, the retry
   * rebuilds a request from it, and the gate that decides whether watched
   * sources get built counts `input->>'sourceUrl'` out of it. Every assertion
   * here is about the row the one writer produced, read back through
   * `runDtoSchema` — the same declaration the browser parses — rather than
   * about the 201.
   */
  describe("a run asked for from material a person pasted", () => {
    const ARTICLE = "The autumn menu, as somebody else wrote it.";

    it("stores the paste, the url at the top level, and no brief at all", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);

      const created = await agent
        .post("/api/runs")
        .send({
          brandId,
          material: `${ARTICLE}\r\nA second paragraph.`,
          sourceUrl: "https://example.com/autumn-menu",
          channelIds: [channelId],
        })
        .expect(201);

      // The WIRE contract, not just the row: a browser parses this shape.
      const run = runDetailDtoSchema.parse(created.body);
      expect(run.input).toEqual({
        kind: "source",
        // `null`, never `""`: a stored empty brief reaches the model as a
        // labelled but empty BRIEF block.
        text: null,
        sourceUrl: "https://example.com/autumn-menu",
        // Verbatim AFTER `normalizeNewlines`, which is what the schema stores.
        material: `${ARTICLE}\nA second paragraph.`,
        channelIds: [channelId],
      });

      // Top-level, because that is the expression the 3b gate reads. A nested
      // key would leave this NULL for every row while the query still ran.
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const rows = await db.execute(
        `SELECT input->>'kind' AS kind, input->>'sourceUrl' AS source_url
           FROM pipeline_runs WHERE id = '${run.id}'`,
      );
      await pool.end();
      expect(rows.rows[0]).toMatchObject({
        kind: "source",
        source_url: "https://example.com/autumn-menu",
      });
    });

    /**
     * The case the compose screen actually sends. `brief` is `useState("")` and
     * goes on the body unconditionally, so an ordinary paste-only run arrives as
     * `{brief: "", material: "…"}` — and `data.brief ?? null` is `""`. An
     * assertion written as "a source create stores `text: null`" passes without
     * exercising this, because a body that simply OMITS `brief` satisfies it
     * too. The empty string is sent on purpose.
     */
    /**
     * THE ARTICLE IS NOT ON THE LIST, and it is on the receipt.
     *
     * The queue polls `?state=open` every five seconds over a set nothing
     * bounds — the cap counts `queued | running`, while a failed run stays open
     * until a human dismisses it — and it reads three things off each row: the
     * brief, the kind and the host. Asserted on the RAW body rather than
     * through `runDtoSchema`, because a zod object strips what it does not
     * declare: parsing would hide a material the api is still sending.
     */
    it("keeps the pasted article off the list, and keeps it on the one run", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/runs")
        .send({
          brandId,
          material: ARTICLE,
          sourceUrl: "https://example.com/autumn-menu",
          channelIds: [channelId],
        })
        .expect(201);
      const id = created.body.id as string;

      for (const path of ["/api/runs", "/api/runs?state=open"]) {
        const listed = (await agent.get(path).expect(200)).body as Array<{
          input: Record<string, unknown>;
        }>;
        expect(listed).toHaveLength(1);
        expect(listed[0]?.input).toEqual({
          kind: "source",
          text: null,
          sourceUrl: "https://example.com/autumn-menu",
          channelIds: [channelId],
        });
        // The WIRE contract for a list row, which is the shape the browser
        // parses: narrowed, and still a complete answer to what the strip draws.
        expect(runDtoSchema.parse(listed[0]).input).toEqual(listed[0]?.input);
      }

      // The receipt asks for ONE run and gets the whole thing — the material,
      // and `steps` beside it.
      const detail = runDetailDtoSchema.parse((await agent.get(`/api/runs/${id}`)).body);
      expect(detail.input).toEqual({
        kind: "source",
        text: null,
        sourceUrl: "https://example.com/autumn-menu",
        material: ARTICLE,
        channelIds: [channelId],
      });
    });

    /** A brief run has no `material` key to cut, and must come back whole. */
    it("leaves a brief run's input alone on the list", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      await startRun(agent, brandId, [channelId]);

      const listed = (await agent.get("/api/runs").expect(200)).body as Array<{ input: unknown }>;
      expect(listed[0]?.input).toEqual({
        kind: "brief",
        text: "Write about our new release",
        channelIds: [channelId],
      });
    });

    it("stores no brief for the empty string the compose screen sends", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);

      for (const brief of ["", "   \n  "]) {
        const created = await agent
          .post("/api/runs")
          .send({ brandId, brief, material: ARTICLE, channelIds: [channelId] })
          .expect(201);
        expect(runDtoSchema.parse(created.body).input).toMatchObject({
          kind: "source",
          text: null,
        });
      }
    });

    it("keeps a real brief beside the paste, as instructions about it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);

      const created = await agent
        .post("/api/runs")
        .send({ brandId, brief: "Shorten it", material: ARTICLE, channelIds: [channelId] })
        .expect(201);
      expect(runDetailDtoSchema.parse(created.body).input).toMatchObject({
        kind: "source",
        text: "Shorten it",
        material: ARTICLE,
      });
    });

    /**
     * Material decides the kind. A url with nothing to attribute is not a source
     * run — it is dropped — and whitespace is not material, which is the one
     * place the writer's trim and the schema's refine have to agree.
     */
    it("stores a brief run when there is no material to work from", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);

      const withUrl = await agent
        .post("/api/runs")
        .send({
          brandId,
          brief: "Announce the autumn menu",
          sourceUrl: "https://example.com/autumn-menu",
          channelIds: [channelId],
        })
        .expect(201);
      expect(runDtoSchema.parse(withUrl.body).input).toEqual({
        kind: "brief",
        text: "Announce the autumn menu",
        channelIds: [channelId],
      });

      const blankMaterial = await agent
        .post("/api/runs")
        .send({
          brandId,
          brief: "Announce the autumn menu",
          material: "   \n  ",
          channelIds: [channelId],
        })
        .expect(201);
      expect(runDtoSchema.parse(blankMaterial.body).input).toEqual({
        kind: "brief",
        text: "Announce the autumn menu",
        channelIds: [channelId],
      });
    });

    /**
     * The property is "refused before an admission slot is spent", not "returned
     * 400": the bound is on the create schema precisely so the API does not
     * create the run and then fail it in the worker's parse, having spent one of
     * the org's three slots. So the run COUNT is what this asserts.
     */
    it("refuses an over-long paste before it costs an admission slot", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      await startRun(agent, brandId, [channelId]);
      const before = (await agent.get("/api/runs").expect(200)).body.length;

      const denied = await agent
        .post("/api/runs")
        .send({
          brandId,
          material: "x".repeat(MAX_SOURCE_TEXT_LENGTH + 1),
          channelIds: [channelId],
        })
        .expect(400);
      expect(JSON.stringify(denied.body.message)).toContain("material:");

      expect((await agent.get("/api/runs").expect(200)).body.length).toBe(before);
    });

    it("refuses a request with neither a brief nor material, naming both", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);

      const denied = await agent
        .post("/api/runs")
        .send({ brandId, channelIds: [channelId] })
        .expect(400);
      expect(denied.body.message).toEqual(["brief: provide a brief, material, or both"]);
      expect((await agent.get("/api/runs").expect(200)).body).toEqual([]);
    });

    /**
     * The url is rendered as an `<a href>` on two screens, so a scheme that is
     * not http(s) is refused at the boundary rather than stored and drawn.
     */
    it("refuses a source url that is not http or https, and creates nothing", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);

      const denied = await agent
        .post("/api/runs")
        .send({
          brandId,
          material: ARTICLE,
          sourceUrl: "javascript:alert(1)",
          channelIds: [channelId],
        })
        .expect(400);
      expect(JSON.stringify(denied.body.message)).toContain("sourceUrl:");
      expect((await agent.get("/api/runs").expect(200)).body).toEqual([]);
    });
  });

  /**
   * ASKING FOR THE SAME RUN AGAIN, without the browser carrying what it was.
   *
   * Try again used to be `POST /api/runs` with a body the queue screen rebuilt
   * out of `run.input` — which is why the list had to ship every open run's
   * whole pasted article, five seconds apart, for ever (measured: 122 265 bytes
   * for eight open runs). The material now never leaves the server: this route
   * re-reads the stored input under the caller's org and hands it back to
   * `create`, so the admission cap, the channel resolution and the
   * enqueue-in-the-same-transaction rule are the SAME code, not a second
   * spelling of it.
   */
  describe("retrying a run the API already has", () => {
    it.each(["educational", "product_update", "comparison"] as const)(
      "preserves the %s format in the receipt and on retry",
      async (contentType) => {
        const agent = await orgAgent();
        const { brandId, channelId } = await brandWithChannel(agent);
        const created = await agent
          .post("/api/runs")
          .send({
            brandId,
            brief: "Announce the supported product change",
            channelIds: [channelId],
            contentType,
          })
          .expect(201);
        const first = runDetailDtoSchema.parse(created.body);
        expect(first.input.contentType).toBe(contentType);
        await setRunStatus(first.id, "failed", "internal");

        const retried = runDetailDtoSchema.parse(
          (await agent.post(`/api/runs/${first.id}/retry`).expect(201)).body,
        );
        expect(retried.input).toEqual(first.input);
      },
    );

    it("preserves an article format beside pasted source material", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/runs")
        .send({
          brandId,
          material: ARTICLE,
          sourceUrl: "https://example.com/article",
          channelIds: [channelId],
          contentType: "expert_article",
        })
        .expect(201);
      const first = runDetailDtoSchema.parse(created.body);
      expect(first.input).toMatchObject({ kind: "source", contentType: "expert_article" });
      await setRunStatus(first.id, "failed", "internal");

      const retried = runDetailDtoSchema.parse(
        (await agent.post(`/api/runs/${first.id}/retry`).expect(201)).body,
      );
      expect(retried.input).toEqual(first.input);
    });
    it.each([
      ["repost", null],
      ["repost", "https://example.com/announcement"],
      ["case_study", null],
      ["case_study", "https://example.com/announcement"],
    ] as const)("preserves %s and its optional URL %s on retry", async (contentType, sourceUrl) => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const material = "The supplier announced a new process for autumn orders.";
      const created = await agent
        .post("/api/runs")
        .send({
          brandId,
          brief: "Explain the effect for cafe owners",
          material,
          ...(sourceUrl && { sourceUrl }),
          channelIds: [channelId],
          contentType,
        })
        .expect(201);
      const first = runDetailDtoSchema.parse(created.body);
      expect(first.input).toMatchObject({
        kind: "source",
        contentType,
        material,
        sourceUrl,
      });
      await setRunStatus(first.id, "failed", "internal");

      const retried = runDetailDtoSchema.parse(
        (await agent.post(`/api/runs/${first.id}/retry`).expect(201)).body,
      );
      expect(retried.input).toEqual(first.input);
    });

    it.each(["repost", "case_study"] as const)(
      "refuses %s with only a brief and URL",
      async (contentType) => {
        const agent = await orgAgent();
        const { brandId, channelId } = await brandWithChannel(agent);
        await agent
          .post("/api/runs")
          .send({
            brandId,
            brief: "Retell this story",
            sourceUrl: "https://example.com/announcement",
            channelIds: [channelId],
            contentType,
          })
          .expect(400);
      },
    );
    const ARTICLE = "The autumn menu, as somebody else wrote it.";

    async function pastedRun(agent: request.Agent, brandId: string, channelIds: string[]) {
      const created = await agent
        .post("/api/runs")
        .send({
          brandId,
          brief: "Shorten it",
          material: ARTICLE,
          sourceUrl: "https://example.com/autumn-menu",
          channelIds,
        })
        .expect(201);
      return runDetailDtoSchema.parse(created.body);
    }

    /**
     * The whole point: the retry carries the paste even though the request
     * carried nothing at all. `toEqual` rather than `toMatchObject`, because a
     * retry that dropped `sourceUrl` or invented a brief would satisfy the
     * looser assertion.
     */
    it("re-admits the stored input from an empty request body", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const first = await pastedRun(agent, brandId, [channelId]);
      await setRunStatus(first.id, "failed", "internal");

      const retried = await agent.post(`/api/runs/${first.id}/retry`).expect(201);
      const run = runDetailDtoSchema.parse(retried.body);

      expect(run.id).not.toBe(first.id);
      expect(run.status).toBe("queued");
      expect(run.input).toEqual(first.input);

      // The same answer `POST /api/runs` gives, down to the enqueued job: a run
      // row with no job behind it is a stall nobody can see.
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const jobs = await db.execute(
        `SELECT count(*)::int AS n FROM pgboss.job
           WHERE name = 'generate' AND data->>'runId' = '${run.id}'`,
      );
      await pool.end();
      expect((jobs.rows[0] as { n: number }).n).toBe(1);
    });

    /**
     * The flagship shape — a paste with no brief and no address — stores two
     * `null`s, and `runCreateSchema` accepts neither key as `null` (`brief`
     * and `sourceUrl` are optional, not nullable). The retry must OMIT them,
     * not forward them: forwarding turns the increment's main flow into a
     * `400 invalid_request` on Try again. Pinned on the exact shape.
     */
    it("re-admits a paste that carried no brief and no address", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/runs")
        .send({ brandId, material: ARTICLE, channelIds: [channelId] })
        .expect(201);
      const first = runDetailDtoSchema.parse(created.body);
      expect(first.input).toEqual({
        kind: "source",
        text: null,
        material: ARTICLE,
        sourceUrl: null,
        channelIds: [channelId],
      });
      await setRunStatus(first.id, "failed", "internal");

      const run = runDetailDtoSchema.parse(
        (await agent.post(`/api/runs/${first.id}/retry`).expect(201)).body,
      );
      expect(run.id).not.toBe(first.id);
      expect(run.input).toEqual(first.input);
    });

    /** The other arm of the union, which has no material and must not grow one. */
    it("re-admits a brief run as a brief run", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const first = await startRun(agent, brandId, [channelId]);
      await setRunStatus(first.id, "failed", "internal");

      const run = runDetailDtoSchema.parse(
        (await agent.post(`/api/runs/${first.id}/retry`).expect(201)).body,
      );
      expect(run.input).toEqual({
        kind: "brief",
        text: "Write about our new release",
        channelIds: [channelId],
      });
    });

    /**
     * The run stays exactly where it was: dismissing is a separate act, and the
     * queue screen does it only once the retry is known to have been admitted.
     */
    it("leaves the run it was asked about untouched", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const first = await pastedRun(agent, brandId, [channelId]);
      await setRunStatus(first.id, "failed", "internal");

      await agent.post(`/api/runs/${first.id}/retry`).expect(201);

      const before = runDetailDtoSchema.parse((await agent.get(`/api/runs/${first.id}`)).body);
      expect(before).toMatchObject({ status: "failed", dismissedAt: null });
    });

    /**
     * TENANCY, and the only shape that can show it: the stranger asks by the
     * real id of a run they do not own. A 404 is the same answer they get for an
     * id that does not exist, so the row's existence is not reported either —
     * and, crucially, nothing of the owner's article is copied into a run the
     * stranger can then read.
     */
    it("never retries another org's run, and creates nothing while refusing", async () => {
      const owner = await orgAgent();
      const ownerBrand = await brandWithChannel(owner);
      const theirs = await pastedRun(owner, ownerBrand.brandId, [ownerBrand.channelId]);

      const stranger = await orgAgent();
      await brandWithChannel(stranger);

      const denied = await stranger.post(`/api/runs/${theirs.id}/retry`).expect(404);
      expect(denied.body.code).toBe("run_not_found");
      expect((await stranger.get("/api/runs").expect(200)).body).toEqual([]);
      // And the owner's list is unchanged: nothing was created on their side
      // either.
      expect((await owner.get("/api/runs").expect(200)).body).toHaveLength(1);
    });

    it("answers 404 for a run id that never existed", async () => {
      const agent = await orgAgent();
      const denied = await agent.post(`/api/runs/${randomUUID()}/retry`).expect(404);
      expect(denied.body.code).toBe("run_not_found");
    });

    /**
     * The refusals are `create`'s own, because the retry IS a create. A channel
     * deleted since the run is the reachable case — deleting the BRAND cascades
     * the run row away, so that one answers `run_not_found` instead.
     */
    it("refuses with a code, not a 500, when the channels are gone", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const first = await pastedRun(agent, brandId, [channelId]);
      await setRunStatus(first.id, "failed", "internal");
      await agent.delete(`/api/channels/${channelId}`).expect(200);

      const denied = await agent.post(`/api/runs/${first.id}/retry`).expect(400);
      expect(denied.body.code).toBe("brand_has_no_channels");
    });

    /**
     * The cap is the reason this goes through `create` at all. A retry that
     * inserted the row itself would be a fourth way into `pipeline_runs` and the
     * one the spend guard does not cover.
     */
    it("is refused by the admission cap exactly as a create is", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const first = await startRun(agent, brandId, [channelId]);
      await setRunStatus(first.id, "failed", "internal");
      for (let i = 1; i < MAX_CONCURRENT_RUNS; i++) await startRun(agent, brandId, [channelId]);
      // The cap counts queued|running, so the failed run above is not one of
      // them: the org is at the cap and the retry would be the fourth.
      await startRun(agent, brandId, [channelId]);

      const denied = await agent.post(`/api/runs/${first.id}/retry`).expect(409);
      expect(denied.body.code).toBe("run_limit_reached");
      expect(denied.body.message).toContain(String(MAX_CONCURRENT_RUNS));
    });

    /**
     * A stored row the request schema would refuse today — written by hand, past
     * the drizzle `$type`, with material longer than `MAX_SOURCE_TEXT_LENGTH`.
     * The retry is a REQUEST like any other and is refused at the same boundary,
     * with the same code, rather than admitted because it came from inside.
     */
    it("refuses a stored input the create schema would not accept, coded", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const first = await pastedRun(agent, brandId, [channelId]);
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db.execute(
        sql`UPDATE pipeline_runs
              SET input = jsonb_set(input, '{material}', to_jsonb(${"x".repeat(MAX_SOURCE_TEXT_LENGTH + 1)}::text))
            WHERE id = ${first.id}`,
      );
      await pool.end();

      const denied = await agent.post(`/api/runs/${first.id}/retry`).expect(400);
      expect(denied.body.code).toBe("invalid_request");
      expect(JSON.stringify(denied.body.message)).toContain("material:");
    });
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
  /**
   * `pipeline_runs.unrecorded_calls` — how many of a run's billed model calls
   * the ledger refused — was written by the worker for a day before anything
   * read it: not selected, not typed, not rendered, not counted. These pin the
   * reader: the number leaves a REAL run row, through the response, in the
   * shape the web's receipt is built from.
   */
  describe("calls the ledger could not record reach the receipt", () => {
    it("reports 0 on a fresh run, and the body IS the wire contract", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);

      // Parsed with the shared schema rather than probed for one property: the
      // web builds its fixtures through the same declaration, so this is the
      // one assertion that makes "the receipt renders what the api returns"
      // a fact about both ends of the wire.
      const detail = runDetailDtoSchema.parse(
        (await agent.get(`/api/runs/${run.id}`).expect(200)).body,
      );
      expect(detail.unrecordedCalls).toBe(0);

      const list = await agent.get("/api/runs").expect(200);
      const row = runDtoSchema.parse(
        (list.body as Array<{ id: string }>).find((r) => r.id === run.id),
      );
      expect(row.unrecordedCalls).toBe(0);
    });

    it("carries the count the worker accumulated, one loss at a time", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);
      await loseCalls(run.id, 3);

      const detail = runDetailDtoSchema.parse(
        (await agent.get(`/api/runs/${run.id}`).expect(200)).body,
      );
      expect(detail.unrecordedCalls).toBe(3);
    });

    it("hands NULL through as null — a run from before the counter says nothing, not zero", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);
      await forgetLosses(run.id);

      const detail = runDetailDtoSchema.parse(
        (await agent.get(`/api/runs/${run.id}`).expect(200)).body,
      );
      // `toBeNull`, not `toBeFalsy`: 0 would satisfy the latter, and 0 is the
      // one value this row must not be flattened to.
      expect(detail.unrecordedCalls).toBeNull();
    });

    it("stays scoped to the org: another org's losses are not this org's", async () => {
      const owner = await orgAgent();
      const theirs = await brandWithChannel(owner);
      const run = await startRun(owner, theirs.brandId, [theirs.channelId]);
      await loseCalls(run.id, 2);

      const stranger = await orgAgent();
      await stranger.get(`/api/runs/${run.id}`).expect(404);
    });

    /**
     * The org's spend figure. Its three display rules partition LEDGER ROWS
     * (`cost-display.ts`); a call the ledger refused is not a row, so it is
     * not a fourth bucket of rows — it is a second source of the same count:
     * money left the org and no total names the amount, which is exactly what
     * rule 1 ("≥ $X, N calls unpriced") already says. Left out, the figure
     * reads `exact` over a bill it is missing three calls from.
     *
     * The measured case of the 2026-09-02 money review, with the loss moved
     * one layer down: one priced call at $0.007875, three that never became
     * rows at all.
     */
    it("counts a run's lost calls among the calls the org's spend cannot price", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);
      await pricedCall(run.id, "0.007875");

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 0.007875,
      });

      await loseCalls(run.id, 3);

      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "atLeast",
        usd: 0.007875,
        unpricedCalls: 3,
      });
    });

    it("does not let a NULL counter move the org's spend either way", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const run = await startRun(agent, brandId, [channelId]);
      await pricedCall(run.id, "0.005000");
      await forgetLosses(run.id);

      // Unknown is unknown: nothing can be counted from it, and an `atLeast`
      // with a count of 0 — or a NULL sum poisoning the whole figure — would
      // both be the api inventing a fact about a row that holds none.
      expect((await agent.get("/api/ai-credentials/spend").expect(200)).body).toEqual({
        kind: "exact",
        usd: 0.005,
      });
    });
  });

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

  /**
   * THE QUERY THAT DECIDES WHETHER THE WATCHER (3b) GETS BUILT, run against
   * rows this suite created through `POST /api/runs`.
   *
   * 3b is designed and not scheduled: it becomes a plan when 3a has produced a
   * number, and the number is collectable with no new machinery — but only
   * because 3a stores exactly what the query reads. A `sourceUrl` nested one
   * level down, or written as an absent key instead of `null`, makes the query
   * run and return nothing, and the gate then reads as "nobody wants this"
   * instead of "the writer wrote the wrong column". A gate that cannot fire is
   * a decision made in advance and dressed as a measurement; a gate that
   * cannot SEE is worse.
   *
   * So the query is not restated here. It is READ OUT OF THE DOCUMENT the
   * owner will run it from (`docs/specs/0003-ai-generation-engine.md` §12),
   * executed verbatim, and compared with this file's own copy — the number
   * that document promises is the number these assertions prove, and a token
   * changed on either side is a failure rather than a drift.
   *
   * ⚠ RAW SQL IN A TEST, AND ONLY IN A TEST. CLAUDE.md's rule is that no
   * controller inlines SQL and every read goes through a repository; this is
   * neither — the artefact under test IS a string of SQL a person pastes into
   * psql, and routing it through a repository would test a method nothing
   * calls instead of the query the decision is made from. There is no new
   * endpoint, and nothing here takes a lock (`docs/lock-order.md` is
   * untouched): the query is one read, and the seeds go through the ordinary
   * create path.
   */
  describe("the number 3b's gate will be decided from", () => {
    /**
     * `sourceHost` (`apps/web/src/lib/runs.ts`), copied — the same three calls
     * over the same WHATWG parser Node and the browser share.
     *
     * Copied rather than imported: `apps/web` is an application, not a
     * package, and the point here is not to re-pin that function but to measure
     * the two derivations against ONE stored value and record where they part
     * company. Nothing compares this copy with the original, so what keeps it
     * honest is that `apps/web/src/lib/runs.test.ts` pins each of the five
     * divergent shapes below by name. Change one side without the other and
     * that suite fails.
     */
    function webSourceHost(url: string): string | null {
      try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || null;
      } catch {
        return null;
      }
    }

    /**
     * Every seed goes through `POST /api/runs`, deliberately: a seed written
     * straight into the column could store a shape the product cannot produce,
     * and then the gate would be pinned against a fiction. Each run is then
     * moved to a terminal status, because `MAX_CONCURRENT_RUNS` admits three
     * live runs per org and this org needs ten.
     */
    async function sourceRun(
      agent: request.Agent,
      brandId: string,
      channelId: string,
      sourceUrl: string | null,
      status: "succeeded" | "failed" | "cancelled" = "succeeded",
    ): Promise<string> {
      const body: Record<string, unknown> = {
        brandId,
        material: "Somebody else's article, pasted.",
        channelIds: [channelId],
      };
      if (sourceUrl !== null) body.sourceUrl = sourceUrl;
      const created = await agent.post("/api/runs").send(body).expect(201);
      const run = runDtoSchema.parse(created.body);
      expect(run.input.kind).toBe("source");
      await setRunStatus(run.id, status);
      return run.id;
    }

    /**
     * A row the ordinary create path cannot produce: a shape no writer in this
     * build can write (see the nested-key test), or a `created_at` in the past,
     * which is the only way to put two runs in two different weeks — the column
     * is `defaultNow()` and no endpoint accepts it.
     */
    async function rawRun(
      orgId: string,
      brandId: string,
      input: unknown,
      createdAt?: string,
    ): Promise<string> {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const rows = await db.execute(
        createdAt === undefined
          ? sql`INSERT INTO pipeline_runs (org_id, brand_id, input, status)
                  VALUES (${orgId}, ${brandId}, ${JSON.stringify(input)}::jsonb, 'succeeded')
                RETURNING id`
          : sql`INSERT INTO pipeline_runs (org_id, brand_id, input, status, created_at)
                  VALUES (${orgId}, ${brandId}, ${JSON.stringify(input)}::jsonb, 'succeeded',
                          ${createdAt}::timestamp)
                RETURNING id`,
      );
      await pool.end();
      return (rows.rows[0] as { id: string }).id;
    }

    /** The input a source run stores, as the DTO writes it. */
    function sourceInput(sourceUrl: string): Record<string, unknown> {
      return {
        kind: "source",
        text: null,
        sourceUrl,
        material: "Somebody else's article, pasted.",
        channelIds: [randomUUID()],
      };
    }

    type GateRow = {
      org_id: string;
      week: string | Date;
      watchable_stories: string;
      watchable_runs: string;
      failed_runs: string;
      urlless_runs: string;
      hosts: string[] | null;
    };

    /**
     * The `week` bucket as a calendar day. `created_at` is `timestamp` WITHOUT
     * time zone, and the driver hands a zoneless value back as a Date built
     * from the stored wall clock in the local zone — so local getters read that
     * wall clock back, and no zone conversion can move the day.
     */
    function weekDay(week: string | Date): string {
      const d = week instanceof Date ? week : new Date(week);
      const month = String(d.getMonth() + 1).padStart(2, "0");
      return `${d.getFullYear()}-${month}-${String(d.getDate()).padStart(2, "0")}`;
    }

    /** Runs the DOCUMENT's query and returns this org's row. */
    async function runGate(orgId: string): Promise<GateRow[]> {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const result = await db.execute(gateSqlFromDoc());
      await pool.end();
      return (result.rows as GateRow[]).filter((r) => r.org_id === orgId);
    }

    /**
     * The shapes the two derivations disagree about, each seeded below. The
     * `web` column is what the queue strip prints; the `sql` column is what the
     * gate counts, and the gate's column is the one the decision is read from.
     */
    const SHAPES = [
      { url: "https://WWW.Example.com/a", sql: "example.com", web: "example.com" },
      { url: "https://www.example.com/b", sql: "example.com", web: "example.com" },
      { url: "HTTPS://Example.com/upper", sql: "example.com", web: "example.com" },
      { url: "https://example.com:8443/port", sql: "example.com:8443", web: "example.com" },
      { url: "https://example.com?q=1", sql: "example.com?q=1", web: "example.com" },
      { url: "https://example.com#frag", sql: "example.com#frag", web: "example.com" },
      { url: "https://user:pw@example.com/who", sql: "user:pw@example.com", web: "example.com" },
      { url: "https://пример.рф/idn", sql: "пример.рф", web: "xn--e1afmkfd.xn--p1ai" },
    ] as const;

    it("counts the stories, the runs, the failures and the hosts a watcher could have fetched", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const orgId = await orgIdOfBrand(brandId);

      // A brief run: everything below must ignore it.
      const briefRun = await startRun(agent, brandId, [channelId]);
      await setRunStatus(briefRun.id, "succeeded");

      const sourceIds: string[] = [];
      for (const shape of SHAPES) {
        // The two statuses the gate is asked NOT to filter out ride on two of
        // the divergent shapes on purpose: an assertion that counts them can
        // only pass while both halves hold.
        const status =
          shape.url === "https://example.com:8443/port"
            ? "failed"
            : shape.url === "https://example.com?q=1"
              ? "cancelled"
              : "succeeded";
        sourceIds.push(await sourceRun(agent, brandId, channelId, shape.url, status));
      }
      // A paste from a paywalled article, a PDF, a Slack message: material a
      // watcher could never have fetched. SQL NULL, so `count(distinct story)`
      // skips it without a filter.
      sourceIds.push(await sourceRun(agent, brandId, channelId, null));

      const grouped = await runGate(orgId);
      expect(grouped, "one org, one week, one row").toHaveLength(1);
      const row = grouped[0] as GateRow;

      // Eight pastes, INCLUDING the failed and the cancelled one: the work a
      // poller takes over is the fetching, and the fetch happened before the
      // run did. SEVEN stories, not eight — `https://example.com?q=1` and
      // `https://example.com#frag` are one page reached two ways, and the
      // `story` column says so even while the `host` column still splits them.
      expect(Number(row.watchable_stories)).toBe(7);
      expect(Number(row.watchable_runs)).toBe(8);
      expect(Number(row.failed_runs)).toBe(2);
      expect(Number(row.urlless_runs)).toBe(1);

      // `kind = 'source'` selects exactly the source runs — the brief run is
      // not among them, and every paste is.
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const selected = await db.execute(
        sql`SELECT id FROM pipeline_runs
              WHERE org_id = ${orgId} AND input->>'kind' = 'source' ORDER BY id`,
      );
      await pool.end();
      expect((selected.rows as { id: string }[]).map((r) => r.id)).toEqual([...sourceIds].sort());
      expect(sourceIds).not.toContain(briefRun.id);

      // The fold that the whole second half of the gate rests on: three
      // spellings of one site are ONE host, and the six shapes the expression
      // reads differently from a URL parser are six more.
      expect([...(row.hosts as string[])].sort()).toEqual(
        [...new Set(SHAPES.map((s) => s.sql))].sort(),
      );
    });

    /**
     * The threshold is written in weeks — "five distinct URLs A WEEK, for four
     * consecutive WEEKS" — and nothing but this test says the query buckets by
     * one. Every other seed here is created inside a single `it`, so all of its
     * rows land in one bucket whatever the bucket is: `month`, `year` or no
     * truncation at all would leave them green.
     *
     * `created_at` is `defaultNow()` and no endpoint accepts it, so the three
     * rows go in raw. Sunday 23:59 and Monday 00:00 are seeded adjacent because
     * the ISO Monday boundary is the one the four-week window is counted over.
     */
    it("buckets by ISO week, starting on Monday", async () => {
      const agent = await orgAgent();
      const { brandId } = await brandWithChannel(agent);
      const orgId = await orgIdOfBrand(brandId);

      await rawRun(orgId, brandId, sourceInput("https://a.example.com/sun"), "2026-09-06 23:59:00");
      await rawRun(orgId, brandId, sourceInput("https://b.example.com/mon"), "2026-09-07 00:00:00");
      await rawRun(orgId, brandId, sourceInput("https://c.example.com/one"), "2026-09-21 12:00:00");
      await rawRun(orgId, brandId, sourceInput("https://c.example.com/two"), "2026-09-23 12:00:00");

      const grouped = await runGate(orgId);
      // A fortnight apart is two buckets, and Sunday is not in Monday's:
      // `month` would return one row, `year` one, no truncation four.
      expect(grouped.map((r) => weekDay(r.week))).toEqual([
        "2026-08-31",
        "2026-09-07",
        "2026-09-21",
      ]);
      expect(grouped.map((r) => Number(r.watchable_stories))).toEqual([1, 1, 2]);
    });

    /**
     * C1: the volume clause counts STORIES, and a story is not a spelling.
     *
     * One article, pasted six ways. The fragment is not a hypothetical: Chrome's
     * "Copy link to highlight" — the default right-click after selecting article
     * text, which is this increment's paste gesture — mints a fresh
     * `#:~:text=…` per selection, and a newsletter link carries `utm_*`. Counted
     * raw these score five or six "stories", meet the threshold exactly, and
     * open the gate on a person who returned to the DRAFT and never to the
     * source — the person the design's §5 wrote the clause to exclude.
     *
     * This also pins `distinct` itself: with every other seed's URLs pairwise
     * different, `count(url)` and `count(distinct story)` would agree.
     */
    it("counts one article pasted six ways as one story", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const orgId = await orgIdOfBrand(brandId);

      const spellings = [
        "https://blog.example.com/a",
        "https://blog.example.com/a", // the same paste twice: one story, two runs
        "https://blog.example.com/a/", // a trailing slash
        "http://blog.example.com/a", // the other scheme
        "https://blog.example.com/a#:~:text=hello", // Copy link to highlight
        "https://blog.example.com/a?utm_source=nl", // a newsletter's link
      ];
      for (const spelling of spellings) await sourceRun(agent, brandId, channelId, spelling);

      const grouped = await runGate(orgId);
      expect(grouped).toHaveLength(1);
      const row = grouped[0] as GateRow;
      expect(Number(row.watchable_stories)).toBe(1);
      expect(Number(row.watchable_runs)).toBe(6);
      // The ratio §5 leaned on: re-drafting shows as few stories over many
      // runs, and a reader can see it. `count(url)` would make these equal.
      expect(Number(row.watchable_stories)).toBeLessThan(Number(row.watchable_runs));
      expect(row.hosts).toEqual(["blog.example.com"]);
    });

    /**
     * What the gate counts as a host, beside what the screen shows for the same
     * stored value. `lower()` runs INSIDE the `www.` strip — written the other
     * way round, `WWW.Example.com` folds to `www.example.com` while
     * `www.example.com` folds to `example.com`, and one site becomes two hosts
     * across the clause that counts hosts across weeks.
     *
     * The rest of the table is divergence, recorded rather than repaired: every
     * one of them SPLITS a site into several hosts and none MERGES two sites
     * into one, so they can make the gate miss and can never make it fire
     * falsely. The SQL's answer is the gate's truth; the parser's is a label.
     */
    it("folds the case before the www. strip, and parts from the queue strip on six shapes", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const orgId = await orgIdOfBrand(brandId);

      for (const shape of SHAPES) await sourceRun(agent, brandId, channelId, shape.url);

      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const rows = await db.execute(
        sql`SELECT input->>'sourceUrl' AS url,
                   nullif(regexp_replace(
                     lower(split_part(split_part(input->>'sourceUrl', '://', 2), '/', 1)),
                     '^www\.', ''), '') AS host
              FROM pipeline_runs
             WHERE org_id = ${orgId} AND input->>'kind' = 'source'`,
      );
      await pool.end();

      const bySql = new Map(
        (rows.rows as { url: string; host: string }[]).map((r) => [r.url, r.host]),
      );
      for (const shape of SHAPES) {
        expect(bySql.get(shape.url), `SQL host of ${shape.url}`).toBe(shape.sql);
        expect(webSourceHost(shape.url), `web host of ${shape.url}`).toBe(shape.web);
      }

      // Six of the eight are read differently by the two, and the difference
      // only ever splits: no two sites collapse into one host either side.
      const diverging = SHAPES.filter((s) => s.sql !== s.web);
      expect(diverging.map((s) => s.url)).toEqual([
        "https://example.com:8443/port",
        "https://example.com?q=1",
        "https://example.com#frag",
        "https://user:pw@example.com/who",
        "https://пример.рф/idn",
      ]);
      expect(new Set(SHAPES.map((s) => s.sql)).size).toBeGreaterThanOrEqual(
        new Set(SHAPES.map((s) => s.web)).size,
      );
    });

    /**
     * The blind spot the DTO exists to close. `input->>'sourceUrl'` reads the
     * TOP level: a writer that nested the address under an `attribution`
     * object would leave the expression NULL for every row, and the gate would
     * count a month of watchable pastes as URL-less ones — the query running,
     * returning a number, and the number being wrong.
     *
     * The query cannot see the difference, so this test asserts BOTH halves:
     * the miscount, on a row put there by raw insert, and the two schema facts
     * that keep such a row out of the product.
     */
    it("miscounts a nested sourceUrl, which is why the DTO cannot write one", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const orgId = await orgIdOfBrand(brandId);

      const honest = await sourceRun(agent, brandId, channelId, "https://example.com/story");
      const nested = {
        kind: "source",
        text: null,
        attribution: { sourceUrl: "https://nested.example.com/story" },
        material: "Somebody else's article, pasted.",
        channelIds: [randomUUID()],
      };
      const nestedId = await rawRun(orgId, brandId, nested);

      const grouped = await runGate(orgId);
      expect(grouped).toHaveLength(1);
      const row = grouped[0] as GateRow;
      // The blind spot, measured: two source runs, one story, and the nested
      // row reported as though the person had pasted from a PDF.
      expect(Number(row.watchable_stories)).toBe(1);
      expect(Number(row.watchable_runs)).toBe(1);
      expect(Number(row.urlless_runs)).toBe(1);
      expect(row.hosts).toEqual(["example.com"]);
      expect(nestedId).not.toBe(honest);

      // And the reason no writer in this build can produce that row. Be exact
      // about WHICH reason: zod strips unknown keys rather than rejecting them,
      // so this is refused because the TOP-LEVEL key is absent, not because a
      // nested one is present. An input carrying both is accepted and the
      // nested one dropped — the stored shape is right either way, which is
      // why the mandatory top-level key is the whole of the guarantee.
      expect(runInputSchema.safeParse(nested).success).toBe(false);
      const both = runInputSchema.safeParse({
        ...nested,
        sourceUrl: "https://example.com/top-level",
      });
      expect(both.success).toBe(true);
      expect(both.data).not.toHaveProperty("attribution");
      expect((both.data as { sourceUrl: string }).sourceUrl).toBe("https://example.com/top-level");
      // `.nullable()`, NOT `.optional()`: the key is mandatory, so "absent" is
      // refused as loudly as "nested" is. `jsonb ->> 'k'` cannot tell an absent
      // key from a null one, so the gate never has to ask.
      expect(
        sourceRunInputSchema.safeParse({
          kind: "source",
          text: null,
          material: "Somebody else's article, pasted.",
          channelIds: [randomUUID()],
        }).success,
      ).toBe(false);
      expect(
        sourceRunInputSchema.safeParse({
          kind: "source",
          text: null,
          sourceUrl: null,
          material: "Somebody else's article, pasted.",
          channelIds: [randomUUID()],
        }).success,
      ).toBe(true);
    });
  });
});
