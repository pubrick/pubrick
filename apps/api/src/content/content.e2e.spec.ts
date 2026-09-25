import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  adaptationLimit,
  contentDetailDtoSchema,
  contentListItemDtoSchema,
  MAX_BODY_LENGTH,
  MAX_REFINE_CALLS_PER_HOUR,
} from "@pubrick/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ReadaptCaller, type ReadaptOutcome } from "./readapt.caller";
import { RefineCaller, type RefineOutcome } from "./refine.caller";
import { REFINE_STEP } from "./refine.step";

const url = process.env.TEST_DATABASE_URL;
/**
 * The same database, tagged. `application_name` rides in the connection string
 * and lands in `pg_stat_activity.application_name`, which is what lets
 * `waitForLockWaiter` below recognise a backend of THIS FILE'S app pool rather
 * than guessing from statement text — brands.e2e.spec.ts documents the measured
 * reason at length, and this file cascades through the same tables.
 */
const APP_NAME = "content-e2e";
const appUrl = url ? `${url}${url.includes("?") ? "&" : "?"}application_name=${APP_NAME}` : url;

describe.skipIf(!url)("content e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = appUrl as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    // Migrations run once for the whole suite in vitest.global-setup.ts (a single
    // barrier, instead of six e2e files each racing runMigrations() against the
    // same DB — that redundant per-file migration dance is what caused the
    // "beforeAll hook timed out" flake).
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The one seam in this file that would otherwise call Google or
      // OpenRouter. `RefineCaller` owns every network line of a refine and
      // nothing else, so replacing it leaves the whole of the endpoint under
      // test — the guard, org scoping, the unlocked editability read, the
      // `ai` draft check, the hourly allowance, the ledger write, the staged
      // row and its supersede — running for real against a real database.
      .overrideProvider(RefineCaller)
      .useValue({
        run: async (args: RefineCall): Promise<RefineOutcome> => {
          refineCalls.push(args);
          // The forty-five seconds this call really takes, as a hook: it is the
          // one window in which the draft can be deleted underneath a refine,
          // and the only way a test can be in it.
          if (refineDuringCall) await refineDuringCall();
          return refineOutcome;
        },
      })
      .overrideProvider(ReadaptCaller)
      .useValue({
        run: async (args: {
          channel: { id: string };
          masterBody: string;
          previousBody: string | null;
        }): Promise<ReadaptOutcome> => {
          readaptCalls.push(args);
          if (readaptDuringCall) await readaptDuringCall();
          return readaptOutcome;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    // Listen for the whole file, rather than letting supertest start the server
    // per request. supertest's Test calls `app.listen(0)` when it finds the
    // server not listening and `server.close()` when THAT request ends — so the
    // first of several in-flight requests to finish tears the listener down
    // under the others, and they die with ECONNRESET / "socket hang up". Measured
    // on this app: 8 concurrent GETs repeated 60 times lost 259 of 480 requests
    // that way, and none once the server was already listening. `runs.e2e`'s
    // admission-cap test is the suite's genuine 10-at-once case; a listener
    // owned by the suite instead of by one request removes the whole class (and
    // the several hundred listen/close cycles a file otherwise performs).
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

  /** The AI's own words, in both the item body and its first version row. */
  const AI_BODY = "Café ouvert. Passez nous voir.";
  const aiAdapted = (index: number) => `Channel ${index} version. The AI wrote this one too.`;

  /**
   * One sentence the model wrote later, stored as a refine `fragment` row's
   * whole body — the shape increment 2b-2's accepted proposal leaves behind.
   */
  const AI_FRAGMENT = "Venez goûter nos viennoiseries.";
  /**
   * The body an accepted refine produces: `AI_BODY`'s first sentence and the
   * fragment's, merged. Equal to NO stored version row, which is precisely why
   * whole-body equality read a human touch here that never happened.
   */
  const REFINED_BODY = `Café ouvert. ${AI_FRAGMENT}`;

  /**
   * The same three things for a refine that SHORTENED the draft — the flagship
   * verb doing its job, and the shape the old deletion clause could not tell
   * from a human trimming the draft.
   *
   * A three-sentence draft; the model returns its last two as one line; the
   * merged body is two sentences and every word of it is still the model's.
   * The accepted proposal's `unit_delta` is −1, and the whole of increment
   * 2b-2's fix is that the gate adds it to what it counts against.
   */
  const AI_LONG_BODY = `${AI_BODY} On vous attend dès sept heures.`;
  const AI_SHORTENING_FRAGMENT = "Passez nous voir dès sept heures.";
  const SHORTENED_BODY = `Café ouvert. ${AI_SHORTENING_FRAGMENT}`;

  /**
   * What Task 8's terminal write leaves behind, written directly.
   *
   * That write creates the item (`origin: "ai"`), its adaptations (each with
   * the AI's adapted body), and the FIRST `content_versions` row for every one
   * of them — item and adaptation alike. The worker does not exist yet, and the
   * api never writes versions itself, so this seeds those rows the same way
   * every other worker-shaped fixture in this file does. Drizzle's insert
   * builder rather than raw SQL: the bodies are real prose with accents, and
   * they must arrive byte-for-byte or the provenance comparison is testing the
   * fixture's escaping instead of the rule.
   */
  async function aiDraft(agent: request.Agent, brandId: string, channelIds: string[]) {
    const created = await agent
      .post("/api/content")
      .send({ brandId, title: "AI title", body: AI_BODY, channelIds })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptations = created.body.adaptations as { id: string; channelId: string }[];
    // The API returns adaptations in insertion order, but nothing promises it;
    // index by channel so the caller's `channelIds` order is what indexes them.
    const ordered = channelIds.map(
      (channelId) => adaptations.find((a) => a.channelId === channelId) as { id: string },
    );

    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
      .rows as { org_id: string }[];
    const orgId = row?.org_id as string;

    await db.execute(`UPDATE content_items SET origin = 'ai' WHERE id = '${itemId}'`);
    for (const [index, adaptation] of ordered.entries()) {
      await db
        .update(schema.adaptations)
        .set({ origin: "ai", body: aiAdapted(index) })
        .where(eq(schema.adaptations.id, adaptation.id));
    }
    await db.insert(schema.contentVersions).values([
      {
        orgId,
        contentItemId: itemId,
        adaptationId: null,
        body: AI_BODY,
        title: "AI title",
        origin: "ai",
      },
      ...ordered.map((adaptation, index) => ({
        orgId,
        contentItemId: itemId,
        adaptationId: adaptation.id,
        body: aiAdapted(index),
        origin: "ai" as const,
      })),
    ]);
    await pool.end();

    return { itemId, adaptationIds: ordered.map((a) => a.id) };
  }

  /**
   * WHAT THE MODEL WAS ASKED, recorded per call so a test can assert not only
   * that the endpoint refused before spending but that nothing was spent at
   * all — "the mock was never invoked" is the assertion; "the response was a
   * 409" is not, since a 409 after a paid call looks identical from outside.
   */
  type RefineCall = {
    credential: { provider: string; apiKey: string };
    brand: { name: string; contentLanguage: string };
    verb: string;
    input: { selection: string; before: string; after: string };
  };
  const refineCalls: RefineCall[] = [];
  const readaptCalls: {
    channel: { id: string };
    masterBody: string;
    previousBody: string | null;
  }[] = [];
  let readaptDuringCall: (() => Promise<void>) | null = null;
  let readaptOutcome: ReadaptOutcome;

  /** One physical model call, in ledger shape. */
  function refineUsage(overrides: Record<string, unknown> = {}) {
    return {
      record: {
        provider: "google" as const,
        modelId: "gemini-3.7-flash",
        attempt: 1,
        inputTokens: 120,
        outputTokens: 24,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.0021,
        costSource: "price_table" as const,
        responseMs: 900,
        status: "ok" as const,
        outcome: "completed" as const,
        ...overrides,
      },
      // The step's OWN attribution, exactly as `refineStep` supplies it: the
      // hourly allowance counts rows by this string.
      attribution: { step: REFINE_STEP },
    };
  }

  const AI_REPLACEMENT = "Ouvert dès sept heures.";
  const AI_REASON = "Deux phrases en une, sans perdre l'horaire.";

  let refineOutcome: RefineOutcome;
  /** Runs while the model is "answering" — see the override in `beforeAll`. */
  let refineDuringCall: (() => Promise<void>) | null = null;

  beforeEach(() => {
    refineCalls.length = 0;
    readaptCalls.length = 0;
    readaptDuringCall = null;
    readaptOutcome = {
      ok: true,
      text: "A concise channel post, written by the model.",
      reason: "Fits this channel while preserving the source.",
      usage: [],
    };
    refineDuringCall = null;
    refineOutcome = {
      ok: true,
      text: AI_REPLACEMENT,
      reason: AI_REASON,
      usage: [refineUsage()] as RefineOutcome["usage"],
    };
  });

  /**
   * A draft the model wrote, with a key stored to refine it against — the two
   * things a refine needs before it can happen at all.
   */
  async function refinableDraft() {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);
    await agent
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "sk-live-never-leak-this-0123456789" })
      .expect(200);
    return { agent, itemId, adaptationIds, orgId: await orgOf(itemId) };
  }

  /** The org an item belongs to, for the fixtures that write rows themselves. */
  async function orgOf(itemId: string): Promise<string> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
      .rows as { org_id: string }[];
    await pool.end();
    return row?.org_id as string;
  }

  /**
   * Ledger rows the allowance will count — or, with a different `step`, an
   * `orgId` or an age, exactly the rows it must NOT count.
   *
   * Written from underneath the API because the only other way to make one is
   * to spend money, and because each of the three predicates the allowance
   * carries has to be pinned by a row that fails it alone.
   */
  async function seedLedger(
    orgId: string,
    count: number,
    options: { step?: string; ageHours?: number } = {},
  ): Promise<void> {
    if (count === 0) return;
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db.insert(schema.usageLedger).values(
      Array.from({ length: count }, () => ({
        orgId,
        runId: null,
        step: options.step ?? REFINE_STEP,
        provider: "google" as const,
        modelId: "gemini-3.7-flash",
        costUsd: "0.002100",
        costSource: "price_table" as const,
        status: "ok" as const,
        outcome: "completed" as const,
        // The column is `timestamp` WITHOUT time zone, written by the
        // database's own `now()` in production; the window compares against
        // `now()` in SQL, so the fixture backdates in SQL too.
        ...(options.ageHours
          ? { createdAt: sql`now() - interval '${sql.raw(String(options.ageHours))} hours'` }
          : {}),
      })),
    );
    await pool.end();
  }

  /** Every staged proposal for one item, whoever wrote it. */
  async function proposalRows(itemId: string) {
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db
      .select({
        id: schema.refineProposals.id,
        orgId: schema.refineProposals.orgId,
        createdBy: schema.refineProposals.createdBy,
        verb: schema.refineProposals.verb,
        selectedText: schema.refineProposals.selectedText,
        startOffset: schema.refineProposals.startOffset,
        endOffset: schema.refineProposals.endOffset,
        proposal: schema.refineProposals.proposal,
        reason: schema.refineProposals.reason,
      })
      .from(schema.refineProposals)
      .where(eq(schema.refineProposals.contentItemId, itemId));
    await pool.end();
    return rows;
  }

  /** Every ledger row of one org, newest last. */
  async function ledgerRows(orgId: string) {
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db
      .select({
        step: schema.usageLedger.step,
        runId: schema.usageLedger.runId,
        contentItemId: schema.usageLedger.contentItemId,
        adaptationId: schema.usageLedger.adaptationId,
        attempt: schema.usageLedger.attempt,
        outcome: schema.usageLedger.outcome,
      })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, orgId))
      .orderBy(asc(schema.usageLedger.createdAt), asc(schema.usageLedger.id));
    await pool.end();
    return rows;
  }

  /** The author's own words, typed into the create form. No model wrote this. */
  const HUMAN_BODY = "J'écris ce texte moi-même. Voici les nouvelles du jour.";

  /**
   * A HAND-TYPED item whose CHANNEL text the model wrote: `content_items`
   * stays `origin = 'human'` with no version row of its own, and the adaptation
   * gets the AI's text plus the `ai` version row that records it.
   *
   * The shape increment 2b-2's refine verbs produce the first time anyone runs
   * one on a draft they typed, and the shape the gate used to walk straight
   * past — it entered on the ITEM's origin, so every check below it was skipped
   * and this item's channel text could ship with nobody having read a word.
   *
   * Deliberately not `aiDraft` with a tweak: what makes this shape what it is
   * is precisely what `aiDraft` writes and this does not.
   */
  async function handTypedWithAiAdaptation(
    agent: request.Agent,
    brandId: string,
    channelIds: string[],
  ) {
    const created = await agent
      .post("/api/content")
      .send({ brandId, title: "My own title", body: HUMAN_BODY, channelIds })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptations = created.body.adaptations as { id: string; channelId: string }[];
    const ordered = channelIds.map(
      (channelId) => adaptations.find((a) => a.channelId === channelId) as { id: string },
    );

    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
      .rows as { org_id: string }[];
    const orgId = row?.org_id as string;

    for (const [index, adaptation] of ordered.entries()) {
      await db
        .update(schema.adaptations)
        .set({ origin: "ai", body: aiAdapted(index) })
        .where(eq(schema.adaptations.id, adaptation.id));
    }
    await db.insert(schema.contentVersions).values(
      ordered.map((adaptation, index) => ({
        orgId,
        contentItemId: itemId,
        adaptationId: adaptation.id,
        body: aiAdapted(index),
        origin: "ai" as const,
      })),
    );
    await pool.end();

    return { itemId, adaptationIds: ordered.map((a) => a.id) };
  }

  /**
   * Waits until `count` backends are parked on a row lock inside a statement
   * naming `content_items` — i.e. until the interleaving a race test is about
   * is a FACT rather than a hope about how two requests happened to schedule.
   *
   * Matched on the statement text rather than on `wait_event_type = 'Lock'`
   * alone, which would also count a waiter belonging to whichever other spec
   * file vitest is running beside this one.
   */
  /**
   * Waits until a request is parked on a row lock inside the ADAPTATIONS walk —
   * `lockAdaptations`' own statement, whether or not it carries its ORDER BY.
   */
  async function waitForAdaptationLockWaiters(
    db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"],
    count: number,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await db.execute(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE '%from "adaptations"%for update%'`,
      );
      if ((rows[0] as { n: number }).n >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count} request(s) blocked on adaptations`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function waitForItemLockWaiters(
    db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"],
    count: number,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await db.execute(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE '%content_items%'`,
      );
      if ((rows[0] as { n: number }).n >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count} request(s) blocked on content_items`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Waits until `count` of THIS FILE'S app backends are parked on a row lock
   * inside a statement against `adaptations` — the interleaving as a fact
   * rather than a hope about promise scheduling.
   *
   * Scoped by `application_name`, never by statement text alone: other e2e
   * files run against this same database and reach `pg_stat_activity` with
   * statements of their own. It RAISES when every operation that should have
   * blocked has finished instead, because returning quietly would hand the
   * caller a green run for an interleaving that never happened.
   */
  async function waitForAdaptationRowWaiters(
    count: number,
    inFlight: Promise<unknown>,
  ): Promise<void> {
    let settled = false;
    void inFlight.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await db.execute(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database()
              AND application_name = '${APP_NAME}'
              AND wait_event_type = 'Lock'
              AND query ILIKE '%adaptations%for update%'`,
        );
        if ((rows[0] as { n: number }).n >= count) return;
        if (settled) {
          throw new Error(
            "every request that should have blocked on the adaptation row finished without " +
              "blocking: the interleaving under test did not happen",
          );
        }
        if (Date.now() > deadline) {
          throw new Error(`fewer than ${count} backend(s) blocked on the adaptation row`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await pool.end();
    }
  }

  async function publishJobCount(adaptationId: string): Promise<number> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
    );
    await pool.end();
    return (jobs.rows[0] as { n: number }).n;
  }

  /**
   * Appends `content_versions` rows at the MASTER level, the way the worker
   * does today and an accepted refine will from 2b-2.
   *
   * `origin` and `scope` default to what a generation writes (`ai`, `full`), so
   * a caller spelling either one out is being explicit about the thing its test
   * turns on. `unitDelta` is REQUIRED on a `fragment` and refused on a `full`
   * row — the database's own CHECK, restated in the fixture's type, so that a
   * test about a refine cannot be written without saying how many units it
   * replaced. A helper that defaulted it would have decided the answer of every
   * case below that turns on the count; a helper that omitted it could not
   * express the failing branch at all, which is exactly how this clause came to
   * be pinned by fixtures that could not fail.
   *
   * `replaceExisting` drops the item's own rows first, for the shapes
   * that are about what is MISSING. `createdAt` is spelled out only by the
   * tests that turn on ROW ORDER — `defaultNow()` would make "the fragment was
   * written before the full row" depend on how fast the inserts ran. `id` is
   * spelled out by the tests that turn on the ORDER BY's TIEBREAK, and by the
   * ones that must pin `created_at` itself: with random ids, dropping
   * `asc(created_at)` leaves `asc(id)` picking a first `full` row by coin
   * flip, and a mutation that survives half the time is not pinned at all.
   */
  async function addItemVersions(
    itemId: string,
    versions: ({
      id?: string;
      body: string;
      origin?: "ai" | "human";
      createdAt?: Date;
    } & ({ scope?: "full"; unitDelta?: never } | { scope: "fragment"; unitDelta: number }))[],
    options: { replaceExisting?: boolean } = {},
  ): Promise<void> {
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
      .rows as { org_id: string }[];
    if (options.replaceExisting) {
      await db
        .delete(schema.contentVersions)
        .where(
          and(
            eq(schema.contentVersions.contentItemId, itemId),
            isNull(schema.contentVersions.adaptationId),
          ),
        );
    }
    await db.insert(schema.contentVersions).values(
      versions.map((version) => ({
        orgId: row?.org_id as string,
        contentItemId: itemId,
        adaptationId: null,
        body: version.body,
        origin: version.origin ?? ("ai" as const),
        scope: version.scope ?? ("full" as const),
        unitDelta: version.scope === "fragment" ? version.unitDelta : null,
        ...(version.createdAt ? { createdAt: version.createdAt } : {}),
        ...(version.id ? { id: version.id } : {}),
      })),
    );
    await pool.end();
  }

  /**
   * EVERY version row of one item, both levels and BOTH origins, oldest first.
   *
   * Deliberately unfiltered, unlike every read in the repository: these tests
   * are about the rows a human save leaves behind, and a helper that filtered
   * `origin = 'ai'` the way the gate does could not tell "no human row was
   * written" from "the human row is invisible to the gate" — which are the two
   * separate things this file has to pin.
   */
  async function versionRows(itemId: string) {
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db
      .select({
        adaptationId: schema.contentVersions.adaptationId,
        body: schema.contentVersions.body,
        title: schema.contentVersions.title,
        origin: schema.contentVersions.origin,
        scope: schema.contentVersions.scope,
        // Read TOGETHER with `scope`, the way every production query that feeds
        // the gate must (CLAUDE.md): a fixture that showed one without the
        // other could assert a fragment exists while saying nothing about
        // whether it can state what it replaced.
        unitDelta: schema.contentVersions.unitDelta,
        createdBy: schema.contentVersions.createdBy,
      })
      .from(schema.contentVersions)
      .where(eq(schema.contentVersions.contentItemId, itemId))
      .orderBy(asc(schema.contentVersions.createdAt), asc(schema.contentVersions.id));
    await pool.end();
    return rows;
  }

  /**
   * Every adaptation pointing at one channel, whoever owns it.
   *
   * Deliberately unfiltered by org, like `versionRows`: the question is whether
   * a row exists AT ALL against another org's channel, and a read that filtered
   * by the asking org could not tell "no such row" from "the row is invisible
   * from here" — which is the whole difference between a refused create and a
   * cross-tenant one hidden behind a 404.
   */
  async function adaptationsForChannel(channelId: string) {
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.channelId, channelId));
    await pool.end();
    return rows;
  }

  /**
   * Writes an item's body straight to the row.
   *
   * A fixture, never a save: the API's own PATCH is the thing under test in
   * half this file, and going through it would file the very version row the
   * assertion is about.
   */
  async function setItemBody(itemId: string, body: string): Promise<void> {
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db.update(schema.contentItems).set({ body }).where(eq(schema.contentItems.id, itemId));
    await pool.end();
  }

  /** Another org, with a brand and channel of its own, and its `org_id`. */
  async function strangerOrg(): Promise<{ orgId: string; channelId: string }> {
    const stranger = await orgAgent();
    const { channelId } = await brandWithChannel(stranger);
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM channels WHERE id = '${channelId}'`))
      .rows as { org_id: string }[];
    await pool.end();
    return { orgId: row?.org_id as string, channelId };
  }

  /**
   * A version row carrying ANOTHER org's `org_id` while pointing at this item —
   * the shape a writer that passed the wrong orgId leaves behind.
   *
   * A stranger's 404 cannot pin any of the org filters on the version table:
   * the stranger is refused at the ITEM lookup and never reaches those reads.
   * This row is what they actually defend against, and it has to be planted
   * from underneath the API, because no endpoint will write it.
   */
  async function otherOrgVersionRow(itemId: string, body: string): Promise<void> {
    const { orgId } = await strangerOrg();
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db
      .insert(schema.contentVersions)
      .values({ orgId, contentItemId: itemId, adaptationId: null, body, origin: "ai" });
    await pool.end();
  }

  /**
   * The same shape one table over: another org's adaptation of this item.
   *
   * `adaptations.org_id` references only the organization, so nothing in the
   * database stops the row from existing — the gate's own `org_id` predicate is
   * the whole defence.
   */
  async function otherOrgAdaptation(itemId: string, body: string): Promise<string> {
    const { orgId, channelId } = await strangerOrg();
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const inserted = await db
      .insert(schema.adaptations)
      .values({ orgId, contentItemId: itemId, channelId, body, origin: "human" })
      .returning({ id: schema.adaptations.id });
    await pool.end();
    return inserted[0]?.id as string;
  }

  /** One `ai` version row at an adaptation's level, owned by the ITEM's org. */
  async function addAdaptationVersion(
    itemId: string,
    adaptationId: string,
    body: string,
  ): Promise<void> {
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
      .rows as { org_id: string }[];
    await db.insert(schema.contentVersions).values({
      orgId: row?.org_id as string,
      contentItemId: itemId,
      adaptationId,
      body,
      origin: "ai",
    });
    await pool.end();
  }

  /** The signed-in user behind an agent — what `created_by` must record. */
  async function sessionUserId(agent: request.Agent): Promise<string> {
    const session = await agent.get("/api/auth/get-session").expect(200);
    return session.body.user.id as string;
  }

  async function firstOpenedAt(itemId: string): Promise<string | null> {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = (
      await db.execute(`SELECT first_opened_at FROM content_items WHERE id = '${itemId}'`)
    ).rows as { first_opened_at: string | null }[];
    await pool.end();
    return rows[0]?.first_opened_at ?? null;
  }

  it("creates a draft with one adaptation per channel", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Hello world", channelIds: [channelId] })
      .expect(201);

    expect(created.body.status).toBe("draft");
    expect(created.body.adaptations).toHaveLength(1);
    expect(created.body.adaptations[0]).toMatchObject({ channelId, status: "pending" });
  });

  it("rejects a channel that belongs to another brand", async () => {
    const agent = await orgAgent();
    const { channelId } = await brandWithChannel(agent);
    const other = await agent.post("/api/brands").send({ name: "Other" }).expect(201);
    await agent
      .post("/api/content")
      .send({ brandId: other.body.id, body: "x", channelIds: [channelId] })
      .expect(404);
  });

  it("edits the item body and a per-channel override", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Original", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id;

    await agent.patch(`/api/content/${created.body.id}`).send({ body: "Edited" }).expect(200);
    const updated = await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "Channel-specific" })
      .expect(200);
    expect(updated.body.body).toBe("Channel-specific");
  });

  it("keeps structured hashtags, editorial CTA, preview text and restored versions aligned", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Master", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptationId = created.body.adaptations[0].id as string;

    const first = await agent
      .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
      .send({
        body: "Channel copy",
        hashtags: [" #new product ", "launch"],
        expectedHashtags: [],
        cta: "Ask a question",
        expectedCta: null,
      })
      .expect(200);
    expect(first.body).toMatchObject({
      body: "Channel copy\n\n#new_product #launch",
      hashtags: ["new_product", "launch"],
      cta: "Ask a question",
    });

    const second = await agent
      .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
      .send({
        body: "Channel copy",
        hashtags: ["launch"],
        expectedHashtags: ["new_product", "launch"],
        cta: "",
        expectedCta: "Ask a question",
      })
      .expect(200);
    expect(second.body).toMatchObject({
      body: "Channel copy\n\n#launch",
      hashtags: ["launch"],
      cta: "",
    });

    const versions = await agent
      .get(`/api/content/${itemId}/versions?adaptationId=${adaptationId}`)
      .expect(200);
    expect(versions.body[0]).toMatchObject({
      body: "Channel copy\n\n#launch",
      hashtags: ["launch"],
      cta: "",
    });
    const older = versions.body.find((row: { body: string }) => row.body.includes("#new_product"));
    expect(older).toMatchObject({ hashtags: ["new_product", "launch"], cta: "Ask a question" });
    await agent
      .post(`/api/content/${itemId}/versions/${older.id}/restore`)
      .send({ expectedBody: second.body.body })
      .expect(400);
    const restored = await agent
      .post(`/api/content/${itemId}/versions/${older.id}/restore`)
      .send({ expectedBody: second.body.body, expectedHashtags: ["launch"], expectedCta: "" })
      .expect(200);
    expect(restored.body.adaptations[0]).toMatchObject({
      body: "Channel copy\n\n#new_product #launch",
      hashtags: ["new_product", "launch"],
      cta: "Ask a question",
    });
  });

  it("bounds the canonical sent text including its hashtag suffix", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Master", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;
    const path = `/api/content/${created.body.id}/adaptations/${adaptationId}`;
    const suffix = "\n\n#tag";
    const limit = adaptationLimit("telegram") ?? MAX_BODY_LENGTH;
    const atLimit = await agent
      .patch(path)
      .send({
        body: "x".repeat(limit - suffix.length),
        hashtags: ["tag"],
        expectedHashtags: [],
      })
      .expect(200);
    expect(atLimit.body.body).toHaveLength(limit);
    await agent
      .patch(path)
      .send({
        body: `${"x".repeat(limit - suffix.length)}x`,
        hashtags: ["tag"],
        expectedHashtags: ["tag"],
      })
      .expect(400);
    const unchanged = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(unchanged.body.adaptations[0].body).toBe(atLimit.body.body);
  });

  it("rejects tags added to an existing body at the platform boundary", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Master", channelIds: [channelId] })
      .expect(201);
    const path = `/api/content/${created.body.id}/adaptations/${created.body.adaptations[0].id}`;
    const body = "x".repeat(adaptationLimit("telegram") ?? MAX_BODY_LENGTH);
    await agent.patch(path).send({ body }).expect(200);
    await agent
      .patch(path)
      .send({ hashtags: ["news"], expectedHashtags: [] })
      .expect(400);
    expect(
      (await agent.get(`/api/content/${created.body.id}`).expect(200)).body.adaptations[0],
    ).toMatchObject({ body, hashtags: [] });
  });

  it("changes tags on the locked current body without replacing a concurrent text edit", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Master", channelIds: [channelId] })
      .expect(201);
    const path = `/api/content/${created.body.id}/adaptations/${created.body.adaptations[0].id}`;
    await agent
      .patch(path)
      .send({ body: "First", hashtags: ["one"], expectedHashtags: [] })
      .expect(200);
    await agent.patch(path).send({ body: "Second" }).expect(200);
    const changed = await agent
      .patch(path)
      .send({ hashtags: ["two"], expectedHashtags: ["one"] })
      .expect(200);
    expect(changed.body).toMatchObject({ body: "Second\n\n#two", hashtags: ["two"] });
  });

  it("preserves an authored final tag paragraph across structured tag edits and restores", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Master", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;
    const path = `/api/content/${itemId}/adaptations/${created.body.adaptations[0].id}`;
    const first = await agent
      .patch(path)
      .send({ body: "A post.\n\n#organic", hashtags: ["organic", "launch"], expectedHashtags: [] })
      .expect(200);
    expect(first.body.body).toBe("A post.\n\n#organic\n\n#organic #launch");
    const second = await agent
      .patch(path)
      .send({ hashtags: ["news"], expectedHashtags: ["organic", "launch"] })
      .expect(200);
    expect(second.body.body).toBe("A post.\n\n#organic\n\n#news");
    const history = await agent
      .get(`/api/content/${itemId}/versions?adaptationId=${created.body.adaptations[0].id}`)
      .expect(200);
    const earlier = history.body.find((row: { body: string }) => row.body === first.body.body);
    const restored = await agent
      .post(`/api/content/${itemId}/versions/${earlier.id}/restore`)
      .send({ expectedBody: second.body.body, expectedHashtags: ["news"], expectedCta: null })
      .expect(200);
    expect(restored.body.adaptations[0].body).toBe(first.body.body);
  });

  it("rejects a stale metadata field but lets an independent field edit proceed", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Master", channelIds: [channelId] })
      .expect(201);
    const path = `/api/content/${created.body.id}/adaptations/${created.body.adaptations[0].id}`;
    await agent.patch(path).send({ body: "Copy" }).expect(200);
    await agent.patch(path).send({ cta: "New CTA", expectedCta: null }).expect(200);
    await agent.patch(path).send({ cta: "Old editor", expectedCta: null }).expect(409);
    const tags = await agent
      .patch(path)
      .send({ hashtags: ["news"], expectedHashtags: [] })
      .expect(200);
    expect(tags.body).toMatchObject({ body: "Copy\n\n#news", cta: "New CTA" });
  });

  it("edits a rejected item and its override: rejecting hands the text back to the author", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Original", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    await agent.post(`/api/content/${created.body.id}/reject`).send({}).expect(200);

    // The whole point of answering an edit-after-approval with 409 rather than
    // silently reopening the draft: "reject it first" has to actually work.
    await agent.patch(`/api/content/${created.body.id}`).send({ body: "Rewritten" }).expect(200);
    await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "Rewritten for this channel" })
      .expect(200);
  });

  it("edits a FAILED item: correcting the text the platform rejected is the whole point", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Far too long for Telegram", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // What markFailed + recomputeItemStatus leave behind when the only
    // adaptation fails permanently: nothing outstanding, nothing live, and no
    // approval left to revoke.
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'failed', attempt_count = 1,
           last_error = 'Telegram 400: message is too long' WHERE id = '${adaptationId}'`,
      );
      await db.execute(
        `UPDATE content_items SET status = 'failed' WHERE id = '${created.body.id}'`,
      );
      await pool.end();
    }

    await agent
      .patch(`/api/content/${created.body.id}`)
      .send({ body: "Short enough now" })
      .expect(200);
    await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "Short enough for this channel" })
      .expect(200);

    // ...and the correction is genuinely re-sendable. approve() already
    // re-targets a `failed` adaptation, which is exactly why refusing the edit
    // was incoherent: the same rejected text could be re-sent in one click,
    // but fixing it first demanded a reject.
    const reApproved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(reApproved.body.body).toBe("Short enough now");
    expect(reApproved.body.adaptations[0]).toMatchObject({
      status: "queued",
      body: "Short enough for this channel",
    });
  });

  it("409s with the message for the status on screen, not one sentence for every state", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Reviewed", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    const approvedDenial = await agent
      .patch(`/api/content/${created.body.id}`)
      .send({ body: "nope" })
      .expect(409);
    expect(approvedDenial.body.message).toBe("Approved content cannot be edited; reject it first");

    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(`UPDATE adaptations SET status = 'published' WHERE id = '${adaptationId}'`);
      await db.execute(
        `UPDATE content_items SET status = 'published' WHERE id = '${created.body.id}'`,
      );
      await pool.end();
    }

    // The old single sentence called this "Approved content" on a screen
    // labelled "Published" — and said the same about "Failed" until that
    // became editable.
    const publishedDenial = await agent
      .patch(`/api/content/${created.body.id}`)
      .send({ body: "nope" })
      .expect(409);
    expect(publishedDenial.body.message).toBe(
      "This content has already been published and can no longer be edited",
    );
  });

  /**
   * THE PER-ADAPTATION PIN, on an item that is itself editable.
   *
   * This test used to reach that shape through a REJECT of a fan-out with one
   * live channel, and that route is now a 409: rejecting a post with a live
   * post in it is a one-way door (`requireNotPublished`, reach "any
   * adaptation"). The same shape is reached the way the product now reaches it
   * — the fan-out ENDS in disagreement, and `partially_published` is editable
   * precisely so that closing reject does not leave the text uncorrectable.
   * The subject is unchanged: an item being editable says nothing about the
   * channel that already published.
   */
  it("a partly published fan-out is editable, except the channel that already published", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const second = await agent
      .post("/api/channels")
      .send({
        brandId,
        platform: "telegram",
        name: "Second",
        credentials: { botToken: "456:def", chatId: "-1009876543210" },
      })
      .expect(201);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Two channels", channelIds: [channelId, second.body.id] })
      .expect(201);
    const sent = (created.body.adaptations as { id: string; channelId: string }[]).find(
      (a) => a.channelId === channelId,
    );
    const other = (created.body.adaptations as { id: string; channelId: string }[]).find(
      (a) => a.channelId === second.body.id,
    );

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // The fan-out ends in disagreement: one channel delivered, the other
    // permanently refused. That is what the worker's recompute writes
    // `partially_published` for, and what the api answers here.
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(`UPDATE adaptations SET status = 'published' WHERE id = '${sent?.id}'`);
      await db.execute(
        `UPDATE adaptations SET status = 'failed', last_error = 'Telegram 400' WHERE id = '${other?.id}'`,
      );
      await db.execute(
        `UPDATE content_items SET status = 'partially_published' WHERE id = '${created.body.id}'`,
      );
      await pool.end();
    }

    // No reject anywhere: the item is editable as it stands, which is the
    // whole point of `partially_published` being in `EDITABLE_ITEM_STATUSES`.
    await agent.patch(`/api/content/${created.body.id}`).send({ body: "Revised" }).expect(200);
    await agent
      .patch(`/api/content/${created.body.id}/adaptations/${other?.id}`)
      .send({ body: "Revised for the channel that refused it" })
      .expect(200);

    // This is why the adaptation's own status is checked and not just the
    // item's: the item is editable, and this row is not.
    const denial = await agent
      .patch(`/api/content/${created.body.id}/adaptations/${sent?.id}`)
      .send({ body: "Rewriting history" })
      .expect(409);
    expect(denial.body.message).toBe(
      "This channel's post has already been published and can no longer be edited",
    );
  });

  it("409s an edit to an APPROVED item and leaves the reviewed body in place", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Reviewed and approved", channelIds: [channelId] })
      .expect(201);

    // Approved for an hour out — the post is scheduled, its job is live, and
    // the worker will read content_items.body at EXECUTION time.
    await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);

    // Before the fix this returned 200: the item stayed "approved", the
    // adaptation stayed "scheduled" with its live job, and the UNREVIEWED text
    // below is what would have gone out an hour later.
    await agent
      .patch(`/api/content/${created.body.id}`)
      .send({ body: "UNREVIEWED REPLACEMENT" })
      .expect(409);

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.body).toBe("Reviewed and approved");
    expect(fetched.body.status).toBe("approved");
    expect(fetched.body.adaptations[0].status).toBe("scheduled");
  });

  it("409s an override edit on a SCHEDULED adaptation and leaves the reviewed override in place", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Item body", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "Reviewed override" })
      .expect(200);
    await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);

    await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "UNREVIEWED REPLACEMENT" })
      .expect(409);

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.adaptations[0]).toMatchObject({
      body: "Reviewed override",
      status: "scheduled",
    });
  });

  it("409s approve AND reject on an already-published item, leaving its status alone", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Already out there", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // Exactly what the worker's markPublished + recomputeItemStatus leave
    // behind once the only adaptation has been delivered (the api never writes
    // these itself, so seed them the same way the link test above does).
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string }[];
      await db.execute(`UPDATE adaptations SET status = 'published' WHERE id = '${adaptationId}'`);
      await db.execute(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
         VALUES ('${row?.org_id}', '${adaptationId}', '${channelId}', 'published', '99', 'https://t.me/c/99', 1)`,
      );
      await db.execute(
        `UPDATE content_items SET status = 'published' WHERE id = '${created.body.id}'`,
      );
      await pool.end();
    }

    // Before the fix both returned 200 and setItemStatus wrote unconditionally,
    // so the item ended up stored as "rejected"/"approved" while the post was
    // live in the channel — and nothing ever repaired it, since
    // recomputeItemStatus only runs from the worker.
    await agent.post(`/api/content/${created.body.id}/reject`).send({}).expect(409);
    expect((await agent.get(`/api/content/${created.body.id}`).expect(200)).body.status).toBe(
      "published",
    );

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(409);
    expect((await agent.get(`/api/content/${created.body.id}`).expect(200)).body.status).toBe(
      "published",
    );
  });

  /**
   * The approve that arrives while the worker is COMMITTING the last channel.
   *
   * `requireNotPublished` read `content_items.status` without a row lock, so
   * this sequence returned 200 and stored `approved` over `published`: the
   * worker's transaction has written the adaptation, the delivery record and
   * the item's promotion but not committed, every other session therefore
   * still reads `approved`, the check passes — and approve's own UPDATE then
   * queues behind the worker's row lock and lands AFTER it. The lasting damage
   * is not the wrong word on a screen: an item stored as `approved` beside a
   * live post can be REJECTED, which is how a published item ends up reading
   * `rejected` next to a post nobody can take back.
   *
   * The comment that justified the unlocked read claimed a `FOR UPDATE` here
   * "would invert the lock order". It would not, and that wrong reason is
   * exactly how this comes back: `approve` and `reject` have already taken the
   * adaptation locks by this point, so locking the item AFTER them is the
   * documented order, not against it.
   */
  it("409s an approve that arrives while the worker is committing the last channel's publish", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Going out right now", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptationId = created.body.adaptations[0].id as string;
    await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    try {
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string }[];
      const orgId = row?.org_id as string;
      // The worker claimed this channel (`markPublishing`) and is now landing it.
      await db.execute(`UPDATE adaptations SET status = 'publishing' WHERE id = '${adaptationId}'`);

      // `markPublished` + `recomputeItemStatus`, statement for statement, held
      // OPEN: adaptation published, delivery logged, item promoted — none of it
      // committed, so every other session still reads `approved`.
      const worker = await pool.connect();
      await worker.query("BEGIN");
      await worker.query(
        "UPDATE adaptations SET status = 'published', last_error = NULL WHERE id = $1",
        [adaptationId],
      );
      await worker.query(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
         VALUES ($1, $2, $3, 'published', '99', 'https://t.me/c/99', 1)`,
        [orgId, adaptationId, channelId],
      );
      await worker.query("UPDATE content_items SET status = 'published' WHERE id = $1", [itemId]);

      // The adaptation is `publishing`, which `approve` deliberately does NOT
      // target, so nothing about the adaptation locks makes this request wait:
      // the item's own lock is the only thing that can serialise the two.
      const approve = Promise.resolve(agent.post(`/api/content/${itemId}/approve`).send({}));
      try {
        await waitForItemLockWaiters(db, 1);
      } finally {
        await worker.query("COMMIT");
        worker.release();
      }

      expect((await approve).status).toBe(409);
      const after = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(after.body.status).toBe("published");
      expect(after.body.adaptations[0].status).toBe("published");
    } finally {
      await pool.end();
    }
  });

  /**
   * An edit that lands UNDER an approve, judged by the gate that had already
   * read the old text.
   *
   * `requireHumanInvolvement` read the body without the item lock, so approve
   * could pass its gate on one body and pin a different one: the editor's
   * transaction holds the row lock, approve reads the committed (old) body,
   * decides, enqueues, and only then queues behind that lock — the editor
   * commits the replacement, approve commits `approved` on top of it, and the
   * text that goes to the channel is text the gate never saw.
   *
   * The replacement here is a REVERT to the model's verbatim draft, because
   * that makes the damage a fact rather than a matter of taste: the item is now
   * an unopened, untouched AI draft, precisely the shape the product promises
   * never to publish, queued for delivery with a 200. Under the lock the gate
   * reads the body the editor actually left behind and refuses it.
   */
  it("409s an approve whose gate would otherwise judge a body the editor is replacing", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);
    // The author rewrote the master body — so the gate passes, even though
    // nobody has OPENED the item (no POST /opened anywhere in this test).
    await agent.patch(`/api/content/${itemId}`).send({ body: HUMAN_BODY }).expect(200);

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    try {
      const holder = await pool.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM content_items WHERE id = $1 FOR UPDATE", [itemId]);

      // The editor first in the lock queue, the approver second: whatever the
      // two requests do internally, the edit is the write that lands first.
      const edit = Promise.resolve(agent.patch(`/api/content/${itemId}`).send({ body: AI_BODY }));
      await waitForItemLockWaiters(db, 1);
      const approve = Promise.resolve(agent.post(`/api/content/${itemId}/approve`).send({}));
      try {
        await waitForItemLockWaiters(db, 2);
      } finally {
        await holder.query("COMMIT");
        holder.release();
      }

      expect((await edit).status).toBe(200);
      const refused = await approve;
      expect(refused.status).toBe(409);
      expect(refused.body.message).toContain("No one has read this AI-written draft yet");

      const after = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(after.body.status).toBe("draft");
      expect(after.body.body).toBe(AI_BODY);
      expect(after.body.adaptations[0].status).toBe("pending");
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    } finally {
      await pool.end();
    }
  });

  /**
   * Approving an item with NO adaptations at all: 200 and "approved" while
   * enqueueing nothing — a post that looks sent and never was.
   *
   * The api cannot create this shape (`channelIds` is `min(1)`), but deleting a
   * channel cascades its adaptations away, and the generation path names the
   * same shape and refuses it: losing every channel mid-run is a terminal
   * `every_channel_deleted` rather than an item with zero adaptations, exactly
   * because "`approve` would happily mark approved while enqueueing nothing at
   * all" (generate.service.ts). Approve now says the same thing.
   */
  it("409s an approve on an item whose channels are all gone: nothing to enqueue is not an approval", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Nowhere to go", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;

    await agent.delete(`/api/channels/${channelId}`).expect(200);
    expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.adaptations).toHaveLength(
      0,
    );

    const refused = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
    expect(refused.body.message).toContain("channel");
    expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.status).toBe("draft");
  });

  it("approves immediately: item approved, adaptation queued", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Ship it", channelIds: [channelId] })
      .expect(201);

    const approved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.adaptations[0].status).toBe("queued");
  });

  it("approves with a schedule: adaptation scheduled with the timestamp", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Later", channelIds: [channelId] })
      .expect(201);
    const when = new Date(Date.now() + 3_600_000).toISOString();

    const approved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: when })
      .expect(200);
    expect(approved.body.adaptations[0].status).toBe("scheduled");
    expect(new Date(approved.body.adaptations[0].scheduledAt).toISOString()).toBe(when);
  });

  it("returns an unsent scheduled approval to the draft and invalidates its old job", async () => {
    const agent = await orgAgent();
    const outsider = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Review this once more", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptationId = created.body.adaptations[0].id as string;
    const when = new Date(Date.now() + 3_600_000).toISOString();
    await agent.post(`/api/content/${itemId}/approve`).send({ scheduledAt: when }).expect(200);

    await outsider.post(`/api/content/${itemId}/retract-approval`).expect(404);
    const retracted = await agent.post(`/api/content/${itemId}/retract-approval`).expect(200);
    expect(retracted.body).toMatchObject({
      status: "draft",
      adaptations: [{ status: "pending", scheduledAt: null, attemptCount: 1 }],
    });

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    try {
      const oldJobs = await db.execute(sql`
        SELECT state FROM pgboss.job
        WHERE name = 'publish' AND data->>'adaptationId' = ${adaptationId}
      `);
      expect(oldJobs.rows.map((row) => row.state)).toEqual(["cancelled"]);
      await agent.post(`/api/content/${itemId}/approve`).send({ scheduledAt: when }).expect(200);
      const jobs = await db.execute(sql`
        SELECT state FROM pgboss.job
        WHERE name = 'publish' AND data->>'adaptationId' = ${adaptationId}
      `);
      expect(jobs.rows.map((row) => row.state).sort()).toEqual(["cancelled", "created"]);
    } finally {
      await pool.end();
    }
  });

  it("refuses to undo approval after any delivery attempt, preserving the send", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Delivery was attempted", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptationId = created.body.adaptations[0].id as string;
    await agent
      .post(`/api/content/${itemId}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
      .expect(200);

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    try {
      await db.execute(sql`
        INSERT INTO publications (org_id, adaptation_id, channel_id, status)
        SELECT org_id, id, channel_id, 'failed' FROM adaptations WHERE id = ${adaptationId}
      `);
      const refused = await agent.post(`/api/content/${itemId}/retract-approval`).expect(409);
      expect(refused.body.code).toBe("approval_retraction_delivery_started");
      const item = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(item.body.status).toBe("approved");
      expect(item.body.adaptations[0].status).toBe("scheduled");
    } finally {
      await pool.end();
    }
  });

  it("waits for a worker claim before deciding whether approval can be undone", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Claim race", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptationId = created.body.adaptations[0].id as string;
    await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const worker = await pool.connect();
    try {
      await worker.query("BEGIN");
      // The claim is invisible outside this transaction, but already owns the
      // adaptation row. Undo must wait rather than reading the old queued state.
      await worker.query("UPDATE adaptations SET status = 'publishing' WHERE id = $1", [
        adaptationId,
      ]);
      const retract = Promise.resolve(agent.post(`/api/content/${itemId}/retract-approval`).send());
      try {
        await waitForAdaptationLockWaiters(db, 1);
      } finally {
        await worker.query("COMMIT");
      }
      const refused = await retract;
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("approval_retraction_delivery_started");
      const after = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(after.body.status).toBe("approved");
      expect(after.body.adaptations[0].status).toBe("publishing");
    } finally {
      worker.release();
      await pool.end();
    }
  });

  it("enqueues exactly one publish job per adaptation, even when approve is called twice", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Once", channelIds: [channelId] })
      .expect(201);

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${created.body.adaptations[0].id}'`,
    );
    await pool.end();
    expect((jobs.rows[0] as { n: number }).n).toBe(1);
    // Note: this does NOT exercise the pg-boss id-collision/dedup path. After the
    // first approve the adaptation's status is "queued", so approve()'s own
    // `status === "pending" || status === "failed"` filter excludes it from
    // `targets` on the second call — enqueuePublish() is simply never invoked
    // again. The count staying at 1 here is a consequence of that filter, not
    // of publishJobId producing the same id twice. The re-approve-after-failure
    // test below is what actually drives two calls into enqueuePublish() for
    // the same adaptation and checks the id derivation.
  });

  /**
   * `approve` MUST NOT TAKE A CHANNEL BACK OFF A LIVE ATTEMPT.
   *
   * `lockAdaptations` is asked for `pending`/`failed`/`scheduled` and for
   * nothing else, and the repository says why in prose — a `publishing`
   * adaptation is mid-attempt, possibly mid-retry-chain, and re-enqueueing it
   * cancels a live job for no user-visible gain. Nothing tested it. The
   * "approve twice" case above cannot: after one approve the adaptation is
   * `queued` at the same `attempt_count`, so `publishJobId` derives the id the
   * first approve already used and pg-boss's ON CONFLICT DO NOTHING keeps the
   * count at one whether the status filter is there or not — the test says so
   * itself.
   *
   * A `publishing` row separates them, because `markPublishing` has already
   * advanced `attempt_count`: a second enqueue for it derives a DIFFERENT job
   * id, so it lands, and the adaptation the worker is currently sending is
   * flipped back to `queued` under a job that is still running. Two jobs, one
   * channel, and the second one sends again.
   */
  it("leaves an adaptation the worker is mid-send alone: approve targets neither its row nor its queue", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Going out now", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptationId = created.body.adaptations[0].id as string;
    await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

    // What `markPublishing` leaves behind: the attempt is claimed and its count
    // advanced, which is what makes a second enqueue a genuinely new job.
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'publishing', attempt_count = 1 WHERE id = '${adaptationId}'`,
      );
      await pool.end();
    }

    const reApproved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    expect(reApproved.body.adaptations[0].status).toBe("publishing");

    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'publish'
         AND data->>'adaptationId' = '${adaptationId}'`,
    );
    await pool.end();
    expect((jobs.rows[0] as { n: number }).n).toBe(1);
  });

  /**
   * MOVING A POST THAT IS ALREADY ON ITS WAY — the 200 that changed nothing.
   *
   * `approve` re-targets `pending`, `failed` and `scheduled` and leaves
   * `queued` and `publishing` alone, which is the right behaviour and is not
   * what these cases are about. They are about the ANSWER. An item whose only
   * channel was already queued matched nothing, wrote no `scheduled_at`,
   * enqueued nothing — and answered 200 with an item the screen then painted as
   * approved, while the post went out at the time the reader had just tried to
   * change.
   *
   * Driven through HTTP rather than through the repository on purpose: the
   * thing being fixed is what a person is TOLD, and the code that carries it —
   * the one field a screen can translate — only exists on the wire.
   */
  it("409s a new schedule for a post that is already queued, and names the recovery", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Already on its way", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptationId = created.body.adaptations[0].id as string;
    await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

    const when = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const refused = await agent
      .post(`/api/content/${itemId}/approve`)
      .send({ scheduledAt: when })
      .expect(409);
    expect(refused.body.code).toBe("schedule_already_queued");
    // The sentence names the one thing that actually moves the post: reject,
    // which cancels the queued job and returns the channel to `pending`.
    expect(refused.body.message).toContain("reject");

    // And it changed NOTHING — which is the half a 200 could also have claimed.
    const after = await agent.get(`/api/content/${itemId}`).expect(200);
    expect(after.body.adaptations[0].status).toBe("queued");
    expect(after.body.adaptations[0].scheduledAt).toBeNull();

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n, min(start_after)::text AS starts FROM pgboss.job
        WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
    );
    await pool.end();
    const job = jobs.rows[0] as { n: number; starts: string };
    expect(job.n).toBe(1);
    // The one live job still fires now, not tomorrow: the queue was not touched.
    expect(new Date(job.starts).getTime()).toBeLessThan(Date.now() + 60_000);
  });

  /**
   * The other half of the distinction: `publishing` is not `queued`.
   *
   * One is committed; the other is mid-send and may already be live in the
   * channel. Rejecting recovers the first and cannot unsend the second, so the
   * two get different codes and different sentences — the same argument the
   * per-status pinned-edit codes make.
   */
  it("409s a new schedule for a post mid-send, with a code of its own", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Going out now", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptationId = created.body.adaptations[0].id as string;
    await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

    // What `markPublishing` leaves behind.
    {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'publishing', attempt_count = 1 WHERE id = '${adaptationId}'`,
      );
      await pool.end();
    }

    const refused = await agent
      .post(`/api/content/${itemId}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 24 * 3_600_000).toISOString() })
      .expect(409);
    expect(refused.body.code).toBe("schedule_already_publishing");
    // No recovery is offered, because there is none: the send is out there.
    expect(refused.body.message).not.toContain("reject");
  });

  /**
   * A PARTIAL move is refused whole, and nothing lands.
   *
   * The tempting alternative is to move the channels that can move and stay
   * quiet about the one that cannot — which produces one post going out at two
   * different times from a single decision, discovered rather than announced.
   * The assertion that matters is the second one: the movable channel is still
   * `pending`, so the refusal really did roll the transaction back rather than
   * half-applying and then complaining.
   */
  it("refuses a schedule that cannot reach every channel, and moves none of them", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const second = await agent
      .post("/api/channels")
      .send({
        brandId,
        platform: "telegram",
        name: "Second",
        credentials: { botToken: "123:abc", chatId: "-1009876543210" },
      })
      .expect(201);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Two channels", channelIds: [channelId, second.body.id] })
      .expect(201);
    const itemId = created.body.id as string;
    const adaptations = created.body.adaptations as { id: string; channelId: string }[];
    const queued = adaptations.find((a) => a.channelId === channelId) as { id: string };
    const pending = adaptations.find((a) => a.channelId !== channelId) as { id: string };

    // One channel committed, the other untouched — the shape a partial answer
    // would have been tempted by.
    {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db.execute(`UPDATE adaptations SET status = 'queued' WHERE id = '${queued.id}'`);
      await pool.end();
    }

    const refused = await agent
      .post(`/api/content/${itemId}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 24 * 3_600_000).toISOString() })
      .expect(409);
    expect(refused.body.code).toBe("schedule_already_queued");

    const after = await agent.get(`/api/content/${itemId}`).expect(200);
    const rows = after.body.adaptations as { id: string; status: string }[];
    expect(rows.find((a) => a.id === pending.id)?.status).toBe("pending");
    expect(rows.find((a) => a.id === queued.id)?.status).toBe("queued");
    expect(after.body.status).toBe("draft");
  });

  /**
   * AND THE REQUEST THAT IS STILL HONEST AT 200: "Publish now".
   *
   * The refusal above is scoped to a request that names a time, and this is the
   * assertion that keeps it scoped. A caller with no time is asking for the
   * post to be on its way; a queued channel already is, so nothing about their
   * belief is wrong and there is nothing to refuse. Widening the guard to every
   * approve would turn the ordinary double-click into a 409.
   */
  it("still approves a queued item with no schedule, because that request is already true", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Now, again", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;

    await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    const again = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    expect(again.body.adaptations[0].status).toBe("queued");
  });

  /**
   * `lockAdaptations` WALKS ITS SET `ORDER BY id`, and nothing observed it.
   *
   * The order is not decoration and not a preference: it is one half of the
   * product's single lock order (`docs/lock-order.md`), and the worker's sweep
   * has a test of its own for the other half —
   * "sweepAbandoned locks in id order, so it cannot deadlock against an item's
   * ordered lock". That test writes the API's ordered walk out BY HAND, in its
   * own session, so it passes whether or not the repository still orders
   * anything. Dropping `.orderBy(schema.adaptations.id)` here left all 90 tests
   * in this file green.
   *
   * Without it a bulk-locking SELECT takes rows in scan order — heap order,
   * which reverses freely as rows are rewritten and has nothing to do with id
   * order. Two writers over one item's adaptations then walk the same set in
   * opposite directions, Postgres kills one of them with 40P01, and if the
   * victim is the request, somebody publishing or cancelling a delivery gets a
   * 500 for a thing they did once.
   *
   * The two rows are inserted HIGH id first so heap order IS the reverse of id
   * order — the same premise, and the same shape, as the worker's test. The
   * other session stands in for any writer that obeys the order: it holds the
   * LOW row and then walks on. Ordered, `approve` is parked on that same LOW row
   * holding nothing, and both finish. Unordered, `approve` is holding HIGH and
   * waiting for LOW while the other session waits for HIGH, and one of the two
   * assertions below is the deadlock victim.
   */
  it("locks an item's adaptations in id order, so a second writer over the same set cannot deadlock it", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const second = await agent
      .post("/api/channels")
      .send({
        brandId,
        platform: "telegram",
        name: "Second",
        credentials: { botToken: "123:abc", chatId: "-1009876543210" },
      })
      .expect(201);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Two channels", channelIds: [channelId, second.body.id] })
      .expect(201);
    const itemId = created.body.id as string;

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    try {
      const [owner] = (
        await db.execute(
          `SELECT org_id FROM adaptations WHERE content_item_id = '${itemId}' LIMIT 1`,
        )
      ).rows as { org_id: string }[];
      const orgId = owner?.org_id as string;

      // Re-seeded with ids of our own, written high-first: the API's own ids are
      // random, and this test is about which of two known rows is taken first.
      const run = randomUUID().slice(0, 8);
      const ids = [2, 1].map((n) => `${run}-0000-4000-8000-${String(n).padStart(12, "0")}`);
      // SORTED, and that is the load-bearing detail. Postgres plans this
      // predicate as an index scan on `adaptations_one_live_per_item_channel`
      // — `(content_item_id, channel_id)` — so an UNORDERED walk takes the rows
      // in ascending CHANNEL id, not in heap order. Channel ids are random, so
      // pairing the rows arbitrarily makes the unordered walk a coin toss and
      // the deadlock appear in about half of runs: measured, one kill in three.
      // Giving the HIGH adaptation id the LOW channel id makes every plan
      // available here — this index, the item index, a seq scan of rows written
      // high-first — agree on taking the high row first.
      const channels = [channelId, second.body.id as string].sort();
      await db.execute(`DELETE FROM adaptations WHERE content_item_id = '${itemId}'`);
      for (const [index, id] of ids.entries()) {
        await db.execute(
          `INSERT INTO adaptations (id, org_id, content_item_id, channel_id, status, attempt_count)
           VALUES ('${id}', '${orgId}', '${itemId}', '${channels[index]}', 'pending', 0)`,
        );
      }
      const [low] = [...ids].sort() as [string, string];

      const other = await pool.connect();
      let otherError: string | null = null;
      let approve: Promise<request.Response> | undefined;
      try {
        await other.query("BEGIN");
        await other.query("SELECT id FROM adaptations WHERE id = $1 FOR UPDATE", [low]);

        approve = Promise.resolve(agent.post(`/api/content/${itemId}/approve`).send({}));
        // The interleaving is a fact rather than a hope: approve is parked on a
        // row lock — on LOW when it is ordered, on nothing but HIGH's successor
        // when it is not.
        await waitForAdaptationLockWaiters(db, 1);

        otherError = await other
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
        await other.query("COMMIT");
      } finally {
        await other.query("ROLLBACK").catch(() => {});
        other.release();
      }

      expect(otherError, "the other writer was the deadlock victim").toBeNull();
      expect((await (approve as Promise<request.Response>)).status).toBe(200);
    } finally {
      await pool.end();
    }
  });

  it("re-approves a failed adaptation: attemptCount makes the retry's job id fresh, so it actually enqueues", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Retry me", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // First approve: attemptCount is 0, enqueues job id uuidv5(`${id}:0`, ...).
    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // Simulate what the worker does after a failed publish attempt: bump
    // attemptCount and flip the adaptation back to "failed" so approve()'s
    // targets filter picks it up again.
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'failed', attempt_count = 1 WHERE id = '${adaptationId}'`,
      );
      await pool.end();
    }

    // Second approve: attemptCount is now 1, so publishJobId derives a DIFFERENT
    // id than the first attempt — send() must not be suppressed as a duplicate.
    const reApproved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(reApproved.body.adaptations[0].status).toBe("queued");

    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
    );
    await pool.end();
    // Two distinct job rows: one per attempt, proving the retry was not silently
    // swallowed by pg-boss's ON CONFLICT DO NOTHING on a stale job id.
    expect((jobs.rows[0] as { n: number }).n).toBe(2);
  });

  it("surfaces the published link once the worker logs a publications row", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Went out", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // Simulate what the worker's markPublished does: flip the adaptation to
    // "published" and log the terminal publications row with the link. The
    // api never writes here itself — this is the worker's write path
    // (apps/worker/src/publish/publish.repository.ts) — so seed it directly.
    // org_id is read back off the adaptation row rather than hardcoded: it's
    // a NOT NULL FK to organization(id), and the agent helpers above never
    // hand the test the org id they generated internally.
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`))
      .rows as { org_id: string }[];
    const orgId = row?.org_id;
    await db.execute(`UPDATE adaptations SET status = 'published' WHERE id = '${adaptationId}'`);
    await db.execute(
      `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
       VALUES ('${orgId}', '${adaptationId}', '${channelId}', 'published', '4711', 'https://t.me/mychannel/4711', 1)`,
    );
    await pool.end();

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.adaptations[0]).toMatchObject({
      status: "published",
      externalUrl: "https://t.me/mychannel/4711",
    });
  });

  it("reports link unavailable (null) for a failed adaptation, not a stale link", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Never went out", channelIds: [channelId] })
      .expect(201);

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.adaptations[0]).toMatchObject({ status: "pending", externalUrl: null });
  });

  /**
   * A DELIVERY WHOSE ANSWER NEVER CAME BACK, end to end.
   *
   * The distinction is worth a `publications` status of its own because the two
   * endings need opposite actions from a human: a `failed` adaptation delivered
   * nothing and is safe to approve again, while an `unknown` one may already be
   * live in the channel and approving it again posts a SECOND copy. The
   * adaptation column cannot hold the difference — `failed` is its only
   * terminal-and-not-published value — so the api joins the receipt in and ships
   * `deliveryOutcome`.
   *
   * Everything here goes through the HTTP response on purpose. The screens read
   * a JSON body, not a repository return value, and the hop this replaces was a
   * browser matching an English sentence out of `last_error`: a test that called
   * the repository could not have told whether the field survived the wire at
   * all. The worker's write is seeded directly, as every worker-shaped fixture
   * in this file is — and the sentence it stores is NEVER asserted on, because
   * the whole point of the field is that rewording it changes nothing.
   */
  describe("an outcome nobody knows", () => {
    /**
     * What `PublishService.recordUnknownOutcome` leaves behind: the adaptation
     * `failed` with the operator's sentence, and the attempt's receipt resolved
     * to `unknown` with NO link — there was no answer to learn one from.
     */
    async function seedUnknownDelivery(adaptationId: string, channelId: string) {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string }[];
      const orgId = row?.org_id;
      await db.execute(
        `UPDATE adaptations SET status = 'failed', last_error =
       'DELIVERY OUTCOME UNKNOWN: the post was sent to the platform but the outcome could not be confirmed. A copy may already be live.'
       WHERE id = '${adaptationId}'`,
      );
      await db.execute(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
       VALUES ('${orgId}', '${adaptationId}', '${channelId}', 'unknown', NULL, NULL, 1)`,
      );
      await pool.end();
    }

    /** The other ending: the attempt never reached the platform. */
    async function seedFailedDelivery(adaptationId: string, channelId: string) {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string }[];
      const orgId = row?.org_id;
      await db.execute(
        `UPDATE adaptations SET status = 'failed', last_error = 'Telegram: chat not found' WHERE id = '${adaptationId}'`,
      );
      await db.execute(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
       VALUES ('${orgId}', '${adaptationId}', '${channelId}', 'failed', NULL, NULL, 1)`,
      );
      await pool.end();
    }

    async function itemWithOneChannel(agent: request.Agent, body: string) {
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body, channelIds: [channelId] })
        .expect(201);
      return {
        itemId: created.body.id as string,
        adaptationId: created.body.adaptations[0].id as string,
        channelId,
      };
    }

    it("reaches the browser as deliveryOutcome, on the item and on the queue alike", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(agent, "Maybe out");
      await seedUnknownDelivery(adaptationId, channelId);

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0]).toMatchObject({
        status: "failed",
        deliveryOutcome: "unknown",
        // No link, and that absence IS the outcome: the answer that would have
        // carried one never arrived. The screen says where the post may have
        // gone by naming the channel instead.
        externalUrl: null,
      });

      const listed = await agent.get("/api/content").expect(200);
      const item = (
        listed.body as { id: string; adaptations: { deliveryOutcome: string }[] }[]
      ).find((i) => i.id === itemId);
      expect(item?.adaptations[0]?.deliveryOutcome).toBe("unknown");
    });

    /**
     * THE CODED REASON, AND THE LATENESS THE SCREEN SAYS OUT LOUD.
     *
     * `failure_reason` is what a screen asks to tell a missed slot from a dead
     * credential, and until it is in the allowlist it exists only in the
     * database: the web would be back to reading `last_error`'s prose, which is
     * the defect `deliveryOutcome` was added next door to end.
     *
     * `lateBySeconds` rides with it because the sentence has a number in it,
     * and the number must be FROZEN. `scheduled_at` survives a failure, so a
     * browser subtracting it from its own clock would report a lateness that
     * grows every time the page is opened and disagrees with the stored
     * sentence beside it. It is measured from the receipt: 26 hours past the
     * slot, refused 2 hours ago, is 24 hours late — NOT 26.
     */
    it("ships failure_reason and a lateness frozen at the receipt, item and queue alike", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(agent, "Too late");

      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        const [row] = (
          await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
        ).rows as { org_id: string }[];
        await db.execute(
          `UPDATE adaptations SET status = 'failed', failure_reason = 'schedule_missed',
             last_error = 'Missed its scheduled slot: ...',
             scheduled_at = now() - interval '26 hours' WHERE id = '${adaptationId}'`,
        );
        await db.execute(
          `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt, created_at)
           VALUES ('${row?.org_id}', '${adaptationId}', '${channelId}', 'failed', NULL, NULL, 1, now() - interval '2 hours')`,
        );
      } finally {
        await pool.end();
      }

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0]).toMatchObject({
        status: "failed",
        deliveryOutcome: "failed",
        failureReason: "schedule_missed",
      });
      // A window, not an equality: the seed and the read are separate
      // statements and `now()` moved between them.
      expect(fetched.body.adaptations[0].lateBySeconds).toBeGreaterThan(24 * 3600 - 60);
      expect(fetched.body.adaptations[0].lateBySeconds).toBeLessThan(24 * 3600 + 60);

      // The queue card and the screen it opens must not answer this
      // differently, which is why it is one expression in ADAPTATION_COLUMNS.
      const listed = await agent.get("/api/content").expect(200);
      const item = (
        listed.body as {
          id: string;
          adaptations: { failureReason: string | null; lateBySeconds: number | null }[];
        }[]
      ).find((i) => i.id === itemId);
      expect(item?.adaptations[0]?.failureReason).toBe("schedule_missed");
      expect(item?.adaptations[0]?.lateBySeconds).toBeGreaterThan(24 * 3600 - 60);
    });

    /**
     * THREE FIELDS, ONE RECEIPT — asserted, not merely promised in a docstring.
     *
     * `lateBySeconds`, `deliveryOutcome`, `assertedByName` and `assertedAt` are
     * four subqueries over `publications` that must all pick the SAME row: the
     * last FINISHED attempt. The docstrings say so; nothing proved it, because
     * every other case in this file seeds exactly ONE receipt, and with one
     * receipt every predicate agrees. Changing the lateness subquery alone to
     * `p.status = 'failed'` left the suite green — three fields captioning one
     * row off different attempts is exactly how a screen tells a story about a
     * delivery that never happened.
     *
     * TWO finished receipts, and the newer one deliberately NOT `failed`, which
     * is what makes each predicate answer differently when it drifts: the older
     * attempt's refusal is 20 h past the slot, the newer receipt is 24 h past
     * it and carries a person's name. Any of the four reading the older row
     * reports the wrong number, or nobody's name, instead of agreeing.
     *
     * Assembled directly rather than driven through the resolver: what is under
     * test is the predicate these fields share, and the sharpest fixture for it
     * is one no single API call produces.
     */
    it("answers the lateness, the outcome and the asserter off ONE receipt — the newest finished", async () => {
      const agent = await orgAgent();
      const userId = await sessionUserId(agent);
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(agent, "Two receipts");

      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        const [row] = (
          await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
        ).rows as { org_id: string }[];
        await db.execute(
          `UPDATE adaptations SET status = 'failed', failure_reason = 'schedule_missed',
             last_error = 'Missed its scheduled slot: ...',
             scheduled_at = now() - interval '26 hours' WHERE id = '${adaptationId}'`,
        );
        // The OLDER attempt: refused 6 h ago, i.e. 20 h past the slot, and
        // nobody's word.
        await db.execute(
          `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt, created_at)
           VALUES ('${row?.org_id}', '${adaptationId}', '${channelId}', 'failed', NULL, NULL, 1, now() - interval '6 hours')`,
        );
        // The NEWER one: 2 h ago, 24 h past the slot, settled by a person.
        await db.execute(
          `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt, created_at, asserted_by, asserted_at)
           VALUES ('${row?.org_id}', '${adaptationId}', '${channelId}', 'published', NULL, NULL, 2, now() - interval '2 hours', '${userId}', now() - interval '2 hours')`,
        );
      } finally {
        await pool.end();
      }

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      const adaptation = fetched.body.adaptations[0];
      // A window, not an equality: the seed and the read are separate
      // statements and `now()` moved between them.
      expect(adaptation.lateBySeconds).toBeGreaterThan(24 * 3600 - 60);
      expect(adaptation.lateBySeconds).toBeLessThan(24 * 3600 + 60);
      // 20 h is the OLDER attempt's answer — the one a drifted predicate gives.
      expect(adaptation.lateBySeconds).toBeGreaterThan(20 * 3600 + 60);
      expect(adaptation.assertedByName).toBe("U");
      expect(typeof adaptation.assertedAt).toBe("string");
      // The newest finished receipt is not `unknown`, so the outcome is the
      // adaptation's own status — and reading the older receipt would not
      // change that, which is why this is the field the other three are
      // anchored to rather than the field that catches the drift.
      expect(adaptation.deliveryOutcome).toBe("failed");
    });

    /**
     * NULL WHERE THERE IS NOTHING TO MEASURE, and that is what the screen's
     * "no hours" sentence is for. A "publish now" delivery has no slot it could
     * have missed — the worker's own bound answers null for exactly this row —
     * and a zero here would be read as "missed it by nothing".
     */
    it("answers null for a failed delivery that never had a slot", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(agent, "No slot");

      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        const [row] = (
          await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
        ).rows as { org_id: string }[];
        await db.execute(
          `UPDATE adaptations SET status = 'failed', failure_reason = 'platform_rejected',
             last_error = 'Telegram: chat not found' WHERE id = '${adaptationId}'`,
        );
        await db.execute(
          `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
           VALUES ('${row?.org_id}', '${adaptationId}', '${channelId}', 'failed', NULL, NULL, 1)`,
        );
      } finally {
        await pool.end();
      }

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0]).toMatchObject({
        failureReason: "platform_rejected",
        lateBySeconds: null,
      });
    });

    /**
     * THE POINT OF THE FIELD, asserted directly: the sentence on `last_error`
     * is a log line, and nothing outside the worker may depend on how it is
     * worded. This seeds an unknown delivery whose message is deliberately NOT
     * the one the worker writes today, and the answer is the same.
     *
     * It is what the deleted ratchet in `apps/web/src/lib/adaptations.test.ts`
     * was standing in for. That test read the worker's source off disk and
     * pinned the prefix, because the web recognised an unknown outcome by
     * `startsWith` on this very string — so rewording a log line turned every
     * unknown delivery into a plain red "Failed", which invites the
     * re-approval that posts a second copy. The receipt is what carries the
     * distinction now, and it has a column, not a paragraph.
     */
    it("does not care how the worker worded its log line", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(agent, "Reworded");
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string }[];
      await db.execute(
        `UPDATE adaptations SET status = 'failed', last_error =
         'Nobody has ever written this sentence in the worker, and nothing here reads it.'
         WHERE id = '${adaptationId}'`,
      );
      await db.execute(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
         VALUES ('${row?.org_id}', '${adaptationId}', '${channelId}', 'unknown', NULL, NULL, 1)`,
      );
      await pool.end();

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0].deliveryOutcome).toBe("unknown");
    });

    /**
     * A CLAIM IS NOT AN OUTCOME. The worker writes an `in_flight` receipt
     * BEFORE it calls the platform and resolves it on every ending it survives
     * — but one can be left behind (a release that could not reach the
     * database, an attempt whose verdict lost a fence race), and nothing sweeps
     * a leaked claim off an adaptation that is already terminal. Reading the
     * newest receipt without excluding it would let that leftover hide the last
     * FINISHED attempt's verdict, and the verdict it would hide here is the one
     * that says "go and look at the channel before you approve again".
     */
    it("looks past a leftover in-flight claim to the last finished attempt", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(
        agent,
        "Claim left over",
      );
      await seedUnknownDelivery(adaptationId, channelId);

      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string }[];
      // Newer than the unknown receipt, so "most recent row" and "most recent
      // FINISHED row" are different rows and the query has to pick the right one.
      await db.execute(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt, created_at)
         VALUES ('${row?.org_id}', '${adaptationId}', '${channelId}', 'in_flight', NULL, NULL, 2, now() + interval '1 minute')`,
      );
      await pool.end();

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0].deliveryOutcome).toBe("unknown");
    });

    /**
     * TWO FINISHED ATTEMPTS, AND ONLY THE LAST ONE DESCRIBES THIS DELIVERY.
     *
     * Every other test in this block seeds exactly ONE finished receipt, which
     * makes "first" and "last" the same row — so `order by created_at desc`
     * flipped to `asc` is invisible to all of them, and an ordering the api
     * consumes silently rather than returns has nothing else that could notice.
     * A retried adaptation has a receipt per attempt, and the two orderings
     * then disagree about the one question this field exists to answer.
     *
     * The history is the ordinary one: an attempt whose answer never came back,
     * a human who opened the channel and found nothing, a re-approve — and then
     * a second attempt that ended differently from the first. Both directions
     * are seeded because the two wrong answers are wrong in opposite ways, and
     * one of them is the expensive one.
     */
    async function seedAttempts(
      adaptationId: string,
      channelId: string,
      statuses: readonly string[],
    ) {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string }[];
      await db.execute(
        `UPDATE adaptations SET status = 'failed', last_error = 'whatever the worker logged'
         WHERE id = '${adaptationId}'`,
      );
      // `created_at` is written explicitly, oldest attempt first. Two inserts in
      // one statement share `now()`, and receipts a millisecond apart would make
      // "most recent" a coin toss rather than the thing under test.
      for (const [index, status] of statuses.entries()) {
        await db.execute(
          `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt, created_at)
           VALUES ('${row?.org_id}', '${adaptationId}', '${channelId}', '${status}', NULL, NULL, ${index + 1},
                   now() - interval '${statuses.length - index} minutes')`,
        );
      }
      await pool.end();
    }

    it("reads the LAST attempt's verdict: an unknown after a clean failure is still unknown", async () => {
      // The expensive direction. The first attempt never reached Telegram; the
      // retry did reach it and never answered. Reading the older receipt calls
      // that `failed` — a status the queue offers as re-approvable — and the
      // re-approve puts a second copy in the channel, which is the entire
      // reason this field is not just `adaptations.status`.
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(
        agent,
        "Failed, then lost",
      );
      await seedAttempts(adaptationId, channelId, ["failed", "unknown"]);

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0].deliveryOutcome).toBe("unknown");
    });

    it("reads the LAST attempt's verdict: a clean failure after an unknown is a plain failure", async () => {
      // The other direction, so this pair cannot be satisfied by a query that
      // simply prefers `unknown`. Here the human already did what the first
      // attempt asked — checked the channel, found nothing, approved again —
      // and the retry failed outright. Sending them back to look a second time
      // is a worse answer than the truth.
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(
        agent,
        "Lost, then failed",
      );
      await seedAttempts(adaptationId, channelId, ["unknown", "failed"]);

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0].deliveryOutcome).toBe("failed");
    });

    /**
     * The link is THIS adaptation's own, whoever else has published lately.
     *
     * The subquery is correlated on `adaptation_id`, and nothing above could
     * tell that predicate from its absence: every test here has exactly one
     * adaptation with receipts, so "this adaptation's newest published row" and
     * "the newest published row in the table" are the same row. A stranger org
     * with a NEWER published receipt separates them, and the failure it guards
     * against is one org's post appearing as another org's link.
     */
    it("takes the link from this adaptation's own receipt, not the newest one in the database", async () => {
      const stranger = await orgAgent();
      const strangerItem = await itemWithOneChannel(stranger, "Someone else's post");
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(agent, "No link yet");
      await seedUnknownDelivery(adaptationId, channelId);

      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${strangerItem.adaptationId}'`)
      ).rows as { org_id: string }[];
      await db.execute(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt, created_at)
         VALUES ('${row?.org_id}', '${strangerItem.adaptationId}', '${strangerItem.channelId}',
                 'published', '5150', 'https://t.me/someoneelse/5150', 1, now() + interval '1 hour')`,
      );
      await pool.end();

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0].externalUrl).toBeNull();
    });

    it("keeps a failure that delivered nothing a plain failure", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(agent, "Never out");
      await seedFailedDelivery(adaptationId, channelId);

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0]).toMatchObject({
        status: "failed",
        deliveryOutcome: "failed",
      });
    });

    it("calls a delivery that landed published, receipt and all", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(agent, "Went out");
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string }[];
      await db.execute(`UPDATE adaptations SET status = 'published' WHERE id = '${adaptationId}'`);
      await db.execute(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
       VALUES ('${row?.org_id}', '${adaptationId}', '${channelId}', 'published', '4711', 'https://t.me/mychannel/4711', 1)`,
      );
      await pool.end();

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0]).toMatchObject({
        deliveryOutcome: "published",
        externalUrl: "https://t.me/mychannel/4711",
      });
    });

    /**
     * THE OTHER HALF OF THE CONDITION. An unknown attempt leaves its receipt
     * behind for ever, and a row that is on its way out again must not be
     * labelled with the verdict of the attempt before it — `status = 'failed'`
     * is what scopes the receipt to the delivery being described.
     *
     * THE ROUTE TO THAT STATE CHANGED, and the state is seeded rather than
     * driven now. This test used to reach `queued` by approving the unknown row
     * — which was the defect: approving a delivery that may be live posts a
     * second copy, so `approve` skips such a row and refuses when it is the
     * only one left. What a person does instead is say what they found (the
     * resolver, `settling a delivery nobody can speak for`), and either verdict
     * files a FINISHED receipt of its own, so the unknown one stops being the
     * last. The pairing is asserted there, on the route people actually take.
     *
     * The clause is kept and kept tested all the same, because it is the half
     * that says WHICH delivery a receipt describes, and nothing else in the
     * expression says it. `deliveryOutcome` is what `approve`'s own skip reads,
     * so a condition that answered from a receipt two attempts old would refuse
     * sends that are perfectly safe — the fail-safe direction, but wrong, and
     * silently so.
     */
    it("stops describing a delivery on its way out with the previous attempt's verdict", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(agent, "Try once more");
      await seedUnknownDelivery(adaptationId, channelId);

      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db.execute(`UPDATE adaptations SET status = 'queued' WHERE id = '${adaptationId}'`);
      await pool.end();

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.adaptations[0]).toMatchObject({
        status: "queued",
        deliveryOutcome: "queued",
      });
    });

    /**
     * The field travels on a PATCH's response too — it is one expression in
     * `ADAPTATION_COLUMNS`, so the RETURNING gets it exactly as the SELECTs do.
     * Worth a test rather than a comment: a `failed` adaptation IS editable
     * (`EDITABLE_ADAPTATION_STATUSES`), so this response is a real way for an
     * unknown delivery to reach a screen, and a mapping applied per call site
     * instead of in the column list would have missed this one.
     */
    it("comes back from an adaptation PATCH, not only from the reads", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await itemWithOneChannel(agent, "Editable");
      await seedUnknownDelivery(adaptationId, channelId);

      const patched = await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "A channel-specific take" })
        .expect(200);
      expect(patched.body).toMatchObject({ status: "failed", deliveryOutcome: "unknown" });
    });

    /*
     * DELETED: "can carry every adaptation status, plus the one the column
     * cannot hold". It compared `DELIVERY_OUTCOMES` against
     * `schema.ADAPTATION_STATUSES + "unknown"` when those were two hand-written
     * lists in two packages. `DELIVERY_OUTCOMES` is now literally
     * `[...ADAPTATION_STATUSES, "unknown"]` in `@pubrick/shared`, so the
     * assertion compared a value with itself. What it was protecting is now
     * structural at both ends: the union is derived, and the SQL above ends
     * `else adaptations.status`, which forwards a status it has never heard of.
     */
  });

  /**
   * A NUL byte is not a body Postgres can store — the insert throws `22021`
   * after every schema has passed — so before this was refused at the DTO the
   * person who pasted an article out of a PDF got a 500 for a request that was
   * merely unstorable. The status is the whole assertion: a 400 with
   * `invalid_request` is a refusal the web already renders in four languages,
   * and a 500 is a bug report.
   */
  it("400s a body carrying a NUL byte instead of 500ing on the insert", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Something", channelIds: [channelId] })
      .expect(201);

    const refused = await agent
      .patch(`/api/content/${created.body.id}`)
      .send({ body: `Edited.\u0000` })
      .expect(400);
    expect(refused.body.code).toBe("invalid_request");

    // ...and nothing was written: the draft still holds what it held.
    const unchanged = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(unchanged.body.body).toBe("Something");
  });

  it('400s an empty PATCH instead of 500ing on drizzle\'s "No values to set"', async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Something", channelIds: [channelId] })
      .expect(201);

    await agent.patch(`/api/content/${created.body.id}`).send({}).expect(400);
  });

  it('400s a scheduledAt in the past — pg-boss would treat it as "publish immediately"', async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Yesterday", channelIds: [channelId] })
      .expect(201);

    await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() - 60_000).toISOString() })
      .expect(400);

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.status).toBe("draft");
    expect(fetched.body.adaptations[0].status).toBe("pending");
  });

  it("rescheduling: approving an already-scheduled item cancels the old job and enqueues a new one at the new time", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Move me", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // Checked, and its effect pinned: this request is the whole premise of the
    // test — it is what makes the adaptation `scheduled` and gives the
    // reschedule below something to cancel. Left unchecked, a failure here was
    // swallowed and resurfaced twenty lines down as "expected [ { state:
    // 'created' } ] to have a length of 2 but got 1": the second approve finds
    // the adaptation still `pending`, cancels nothing, and enqueues its single
    // job. That reads like a job that went missing rather than like the first
    // approve never happening, which is the wrong bug to go looking for.
    const first = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const scheduled = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: first })
      .expect(200);
    expect(new Date(scheduled.body.adaptations[0].scheduledAt).toISOString()).toBe(first);

    const second = new Date(Date.now() + 48 * 3_600_000).toISOString();
    const rescheduled = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: second })
      .expect(200);
    expect(new Date(rescheduled.body.adaptations[0].scheduledAt).toISOString()).toBe(second);

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state, start_after FROM pgboss.job WHERE name = 'publish'
         AND data->>'adaptationId' = '${adaptationId}' ORDER BY created_on`,
    );
    await pool.end();

    // Two rows: the original, now cancelled, and a live one at the NEW time.
    // Before the fix, "scheduled" was excluded from approve()'s targets, so the
    // request returned 200 with nothing enqueued and the post still fired at
    // the ORIGINAL time — the UI reported a reschedule that never happened.
    const rows = jobs.rows as { state: string; start_after: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.state).toBe("cancelled");
    expect(rows[1]?.state).toBe("created");
    expect(new Date(rows[1]?.start_after as string).toISOString()).toBe(second);
  });

  /**
   * A POST THAT MISSED ITS SLOT MUST NOT BE UNSENDABLE FOR EVER.
   *
   * The worker fails a delivery whose slot passed more than
   * `PUBLISH_MAX_LATENESS_HOURS` ago, and it leaves `scheduled_at` where it was
   * — nothing clears it on failure, and the stored sentence names it. The only
   * way back is "Publish now", which works because this method writes
   * `scheduled_at` UNCONDITIONALLY. Written conditionally — the tempting
   * `...(scheduledAt && { scheduledAt })` — the re-approved row would carry the
   * same overdue slot, the worker would find itself past the bound again, and
   * the post could never be sent by any route: an infinite refusal loop with a
   * 200 in front of it.
   */
  it("publish-now clears the slot a missed post is still carrying", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Missed the window", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // Exactly what the worker's bound leaves behind: `failed`, with the slot
    // still on the row and the coded reason beside it. Written directly because
    // `approve` refuses a past time, which is why an outage is the only way to
    // reach this shape at all.
    const { createDb, schema } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    try {
      await db
        .update(schema.adaptations)
        .set({
          status: "failed",
          scheduledAt: sql`now() - interval '26 hours'`,
          lastError: "Missed its scheduled slot: ...",
          failureReason: "schedule_missed",
        })
        .where(eq(schema.adaptations.id, adaptationId));

      const now = await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
      expect(now.body.adaptations[0].status).toBe("queued");
      expect(now.body.adaptations[0].scheduledAt).toBeNull();

      const [row] = await db
        .select()
        .from(schema.adaptations)
        .where(eq(schema.adaptations.id, adaptationId));
      // The slot is gone from the row itself, not merely from the response.
      expect(row?.scheduledAt).toBeNull();
      // And so is the verdict, beside the `last_error` this method already
      // cleared — otherwise the screen would caption a live delivery "Missed
      // its slot".
      expect(row?.failureReason).toBeNull();
      expect(row?.lastError).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it("approve now on a scheduled item actually publishes now: the old job is cancelled and a fresh one is queued", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Now instead", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 24 * 3_600_000).toISOString() })
      .expect(200);

    const now = await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    expect(now.body.adaptations[0].status).toBe("queued");
    expect(now.body.adaptations[0].scheduledAt).toBeNull();

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'publish'
         AND data->>'adaptationId' = '${adaptationId}' ORDER BY created_on`,
    );
    await pool.end();
    const states = (jobs.rows as { state: string }[]).map((r) => r.state);
    expect(states).toEqual(["cancelled", "created"]);
  });

  it("rejects a draft", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "No", channelIds: [channelId] })
      .expect(201);
    const rejected = await agent
      .post(`/api/content/${created.body.id}/reject`)
      .send({})
      .expect(200);
    expect(rejected.body.status).toBe("rejected");
  });

  it("rejecting an approved item cancels delivery: adaptations go back to pending and the job is cancelled", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Do not send this", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // Approve with a schedule, exactly as a user would before changing their mind.
    await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: new Date(Date.now() + 24 * 3_600_000).toISOString() })
      .expect(200);

    const rejected = await agent
      .post(`/api/content/${created.body.id}/reject`)
      .send({})
      .expect(200);

    expect(rejected.body.status).toBe("rejected");
    // Before the fix this stayed "scheduled" with a live pg-boss job, so the
    // post went out the next day despite having been rejected.
    expect(rejected.body.adaptations[0].status).toBe("pending");
    expect(rejected.body.adaptations[0].scheduledAt).toBeNull();

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
    );
    await pool.end();
    const states = (jobs.rows as { state: string }[]).map((r) => r.state);
    // No job left that can still be fetched by a worker.
    expect(states).toEqual(["cancelled"]);
  });

  it("an item rejected after approval can be approved again and genuinely re-enqueues", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Changed my mind twice", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    await agent.post(`/api/content/${created.body.id}/reject`).send({}).expect(200);

    // A cancelled pg-boss job keeps its id, so without reject() advancing
    // attempt_count this re-approve would derive the same job id, send() would
    // suppress it as a duplicate and the request would 409 forever.
    const reApproved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(reApproved.body.status).toBe("approved");
    expect(reApproved.body.adaptations[0].status).toBe("queued");

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'publish'
         AND data->>'adaptationId' = '${adaptationId}' ORDER BY created_on`,
    );
    await pool.end();
    expect((jobs.rows as { state: string }[]).map((r) => r.state)).toEqual([
      "cancelled",
      "created",
    ]);
  });

  it("rejecting an item stuck mid-attempt (publishing) unsticks it instead of stranding it forever", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Telegram is down", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // Exactly what a transient platform failure leaves behind: the worker
    // claimed the attempt (status "publishing", attempt_count bumped) and
    // recordTransient stored the reason without moving the status, so the row
    // stays like this for the whole retry chain. The pg-boss job is still the
    // one enqueued at attempt_count 0 — its id does NOT track the bumped
    // count, which is why cancellation has to find the job by payload.
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'publishing', attempt_count = 1,
           last_error = 'Too Many Requests' WHERE id = '${adaptationId}'`,
      );
      await pool.end();
    }

    const rejected = await agent
      .post(`/api/content/${created.body.id}/reject`)
      .send({})
      .expect(200);

    // Before the fix "publishing" was in neither reject()'s lock set nor
    // approve()'s target set: nothing matched, the row kept its "publishing"
    // status, and the next retry saw the rejected item and completed the job —
    // ending the chain AND the dead-letter rescue. The adaptation was then
    // stuck in "publishing" forever with no job behind it, and re-approve
    // silently did nothing.
    expect(rejected.body.adaptations[0].status).toBe("pending");

    {
      const { db, pool } = createDb(url as string);
      const jobs = await db.execute(
        `SELECT state FROM pgboss.job WHERE name = 'publish'
           AND data->>'adaptationId' = '${adaptationId}'`,
      );
      await pool.end();
      expect((jobs.rows as { state: string }[]).map((r) => r.state)).toEqual(["cancelled"]);
    }

    // And the row is genuinely usable again, not just cosmetically reset.
    const reApproved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(reApproved.body.adaptations[0].status).toBe("queued");

    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'publish'
         AND data->>'adaptationId' = '${adaptationId}' ORDER BY created_on`,
    );
    await pool.end();
    expect((jobs.rows as { state: string }[]).map((r) => r.state)).toEqual([
      "cancelled",
      "created",
    ]);
  });

  it("rejecting a draft leaves its pending adaptations alone (nothing was ever enqueued)", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Never approved", channelIds: [channelId] })
      .expect(201);

    const rejected = await agent
      .post(`/api/content/${created.body.id}/reject`)
      .send({})
      .expect(200);
    expect(rejected.body.adaptations[0].status).toBe("pending");
    expect(rejected.body.adaptations[0].attemptCount).toBe(0);
  });

  describe("the publish promise: nothing publishes that no human opened or touched", () => {
    it("refuses to approve an AI draft nobody opened or touched, and enqueues nothing", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      const res = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/no one has read/i);

      // The refusal is the whole product promise, so it has to be a refusal and
      // not a message: nothing queued, nothing scheduled, status untouched.
      const after = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(after.body.status).toBe("draft");
      expect(after.body.adaptations[0].status).toBe("pending");
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("refuses the same draft when it is approved WITH A SCHEDULE", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // Scheduling is the same door to enqueuePublish, just later.
      await agent
        .post(`/api/content/${itemId}/approve`)
        .send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
        .expect(409);
    });

    it("allows approval once a human opened it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      expect(approved.body.adaptations[0].status).toBe("queued");
    });

    it("allows approval once a human edited the master body, even unopened", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      await agent.patch(`/api/content/${itemId}`).send({ body: "My own words." }).expect(200);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    });

    it("allows approval when a human edited ONE channel's override, even unopened", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const second = await agent
        .post("/api/channels")
        .send({
          brandId,
          platform: "telegram",
          name: "Second",
          credentials: { botToken: "456:def", chatId: "-1009876543210" },
        })
        .expect(201);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId, second.body.id]);

      // Two channels, one edited: the item body is still verbatim AI, and so is
      // the OTHER channel's text. A human has still been here, so approval
      // proceeds — and with `some` in place of `every` this would 409.
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationIds[0]}`)
        .send({ body: "My own words for this channel." })
        .expect(200);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    });

    it("asks whether a human was involved, not whether every channel was reviewed", async () => {
      // Deliberately spelled out rather than left implicit: the rule asks
      // whether a HUMAN HAS BEEN INVOLVED, not whether each channel's text was
      // individually reviewed. Editing the master body of a two-channel item
      // clears the refusal even though both channels still ship untouched AI
      // adaptations (the adaptation body wins over the item body in the
      // worker). The generation-engine spec's §6 defines the refusal as the conjunction of all three
      // clauses, so this is the rule working, not a hole in it — but it is the
      // rule's real reach, and a reader deserves to see it asserted.
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const second = await agent
        .post("/api/channels")
        .send({
          brandId,
          platform: "telegram",
          name: "Second",
          credentials: { botToken: "789:ghi", chatId: "-1005555555555" },
        })
        .expect(201);
      const { itemId } = await aiDraft(agent, brandId, [channelId, second.body.id]);

      await agent.patch(`/api/content/${itemId}`).send({ body: "Rewritten master." }).expect(200);
      const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      const bodies = (approved.body.adaptations as { body: string }[]).map((a) => a.body);
      expect(bodies).toContain(aiAdapted(0));
      expect(bodies).toContain(aiAdapted(1));
    });

    it("refuses after a cleared override: the channel then ships the item's own AI text", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const second = await agent
        .post("/api/channels")
        .send({
          brandId,
          platform: "telegram",
          name: "Second",
          credentials: { botToken: "321:cba", chatId: "-1007777777777" },
        })
        .expect(201);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId, second.body.id]);

      // Emptying an override textarea sends exactly this, and the shipped UI
      // does it (content/[id]/page.tsx: `value.trim() === "" ? null : value`).
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationIds[0]}`)
        .send({ body: null })
        .expect(200);

      // Clearing removed text; it wrote none. The channel now falls back to the
      // item body, which is verbatim what the AI wrote — so EVERY character
      // this item would publish is still unread AI, and the gate must hold.
      // Comparing the fallback text against the ADAPTATION's AI version (a
      // different string by construction — the adapter rewrites for the
      // platform) reads this as a human edit and publishes the lot.
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
      expect(await publishJobCount(adaptationIds[1] as string)).toBe(0);
    });

    it("reads the ai rows only — a human version ordered first is not the reference", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // The version history increment 2 will actually produce: a human draft,
      // the AI's rewrite of it, and a later AI refinement. The item body is the
      // AI's own output, so the rule must refuse.
      //
      // This test used to be called "compares against the FIRST ai version",
      // and that stopped being true when the gate started asking whether EVERY
      // SENTENCE is the model's: the mask now ORs across every `ai` row, and
      // only the deletion clause's anchor is a single row (the first with
      // `scope = 'full'`). What the fixture pins is the `origin` filter, and it
      // pins it through that anchor: the human's own first attempt sorts before
      // both `ai` rows, and it is THREE sentences long. Let it into the
      // evidence and it becomes the first `full` row, so a two-sentence body
      // counts as a deletion, the gate reads a human touch that never happened,
      // and this unopened AI draft publishes.
      //
      // The three sentences are the whole fixture. With a one-sentence human
      // row — which is what this test carried until the count clause existed —
      // dropping the `origin` filter changes nothing: the mask only ever grows
      // by OR-ing, and `2 >= 1` holds, so the test passed either way and the
      // comment above it was describing a guard it did not exercise.
      // Timestamps are explicit, not `defaultNow()`, so the order does not
      // depend on the database's session timezone.
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
        .rows as { org_id: string }[];
      const orgId = row?.org_id as string;
      await db
        .delete(schema.contentVersions)
        .where(
          and(
            eq(schema.contentVersions.contentItemId, itemId),
            isNull(schema.contentVersions.adaptationId),
          ),
        );
      await db.insert(schema.contentVersions).values([
        {
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "Mon premier jet. Écrit à la main. Avant le modèle.",
          origin: "human",
          createdAt: new Date("2026-08-01T10:00:00Z"),
        },
        {
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: AI_BODY,
          origin: "ai",
          createdAt: new Date("2026-08-01T11:00:00Z"),
        },
        {
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "A later AI refinement.",
          origin: "ai",
          createdAt: new Date("2026-08-01T12:00:00Z"),
        },
      ]);
      await pool.end();

      // Taking the first row of any origin compares the body against text it
      // was never equal to and calls that a human.
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
    });

    it("still refuses a refined draft — the fragment proves the new sentence is the model's too", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // The shape this whole increment exists for, and the one the old formula
      // let through: a `fragment` row carrying the sentence the model proposed,
      // and a body equal to NEITHER stored row. Whole-body equality reads that
      // as a human touch and publishes a draft nobody opened. Per sentence
      // there is nothing human in it — the first sentence is the full row's,
      // the second is the fragment's.
      await addItemVersions(itemId, [{ body: AI_FRAGMENT, scope: "fragment", unitDelta: 0 }]);
      await agent.patch(`/api/content/${itemId}`).send({ body: REFINED_BODY }).expect(200);

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    /**
     * THE defect this increment is built around, and the ordinary path rather
     * than a corner: press Shorten once and this is what the tables hold.
     *
     * A three-sentence `full` row; a `fragment` carrying the single line the
     * model returned in place of the last two; `unit_delta = -1`; and a body of
     * two sentences, every word of which the model wrote. Counted against the
     * anchor alone the body is a sentence short, which reads as a human
     * deletion — so the gate opens on a draft nobody has read and the badge
     * captions the model's own words "Human-edited". That is the inversion
     * increment 2b-1 exists to prevent, arriving from the flagship verb
     * WORKING.
     *
     * Everything else about this fixture is deliberately correct, so that the
     * delta is the only thing that can move the answer: nobody has opened the
     * item, the channel still carries the model's adapted text and its own `ai`
     * row, and every sentence of the body matches a row, so the mask is all
     * true and clause 2 has nothing to say. The counterweight below shares
     * every one of those and differs by one unit of body.
     */
    it("refuses a draft the model SHORTENED for you, and the badge still says AI-drafted", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      await addItemVersions(
        itemId,
        [
          { body: AI_LONG_BODY },
          { body: AI_SHORTENING_FRAGMENT, scope: "fragment", unitDelta: -1 },
        ],
        { replaceExisting: true },
      );
      const patched = await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: SHORTENED_BODY })
        .expect(200);

      // The badge, on the very response that stored the merged body.
      expect(patched.body.bodyIsAiVerbatim).toBe(true);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("still sees a deletion THROUGH a shortening refine — one unit fewer opens it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // Byte for byte the fixture above, one unit of body removed: the same
      // rows, the same −1, the same untouched channel, nobody opening anything.
      // Every sentence LEFT is still the model's — it is the fragment's own
      // line — so the mask cannot see the human and only the running
      // expectation can: three units anchored, one replaced away, two owed, one
      // present. A gate that simply refused every fragment-bearing level would
      // pass the test above and fail this one.
      await addItemVersions(
        itemId,
        [
          { body: AI_LONG_BODY },
          { body: AI_SHORTENING_FRAGMENT, scope: "fragment", unitDelta: -1 },
        ],
        { replaceExisting: true },
      );
      const patched = await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: AI_SHORTENING_FRAGMENT })
        .expect(200);

      expect(patched.body.bodyIsAiVerbatim).toBe(false);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(1);
    });

    /**
     * The invariant the deltas compose under, asserted on rows rather than
     * remembered: a level holds at most ONE `ai` `full` row.
     *
     * `allSentencesAi` anchors on the first `full` row and adds every fragment
     * row's `unit_delta` to it. Both halves describe the same text only while
     * there is one such row: a second — a re-generation over an existing item —
     * leaves the anchor describing one body and the deltas another, and the
     * disagreement runs UNSAFE (a long first draft, a short re-generation, and
     * a body that is every word the model's reads "Human-edited").
     *
     * Nothing writes a second one today, and this walks the whole write surface
     * that could: both PATCH routes, the read receipt and approve, on an item
     * that already carries the model's own rows. 2c's re-adaptation is the work
     * that makes the shape reachable; it must decide whether the anchor becomes
     * the LAST full row and whether earlier deltas are dropped, and this is the
     * test that should be failing while it does.
     */
    it("leaves every level with at most one `ai` `full` row — the shape 2c must not create", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      await agent.patch(`/api/content/${itemId}`).send({ body: "Une phrase à moi." }).expect(200);
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationIds[0]}`)
        .send({ body: "Mon propre texte pour ce canal." })
        .expect(200);
      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

      // Scoped to this item's own rows, never a count over the table: the
      // suites share one database and never truncate it.
      const perLevel = new Map<string, number>();
      for (const row of await versionRows(itemId)) {
        if (row.origin !== "ai" || row.scope !== "full") continue;
        const level = row.adaptationId ?? "the master body";
        perLevel.set(level, (perLevel.get(level) ?? 0) + 1);
      }
      expect(perLevel.size).toBe(2); // the master body, and its one channel
      expect([...perLevel.values()]).toEqual([1, 1]);
    });

    it("opens as soon as one sentence is the human's own", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // The counterweight to the test above, which a gate that simply refused
      // everything would also satisfy. Same refined body, one sentence of the
      // author's own added: no `ai` row wrote that sentence, so the mask has a
      // false in it and the gate opens.
      await addItemVersions(itemId, [{ body: AI_FRAGMENT, scope: "fragment", unitDelta: 0 }]);
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: `${REFINED_BODY} On vous attend dès sept heures.` })
        .expect(200);

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    });

    it("allows a deletion — trimming a draft is a human act", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // Every sentence left IS the model's, so the mask alone answers "still
      // untouched AI" and would refuse the commonest API-side edit there is,
      // with a message telling the caller to edit the draft they just edited.
      // Only the count against the first `full` row says a human was here.
      await agent.patch(`/api/content/${itemId}`).send({ body: "Café ouvert." }).expect(200);

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    });

    /**
     * WHICH row the gate counts against, pinned on the gate's own path.
     *
     * The badge's two order tests below (a deletion counted against the first
     * `full` row, and the same-instant tiebreak) read the ORDER BACK: `get`
     * returns the rows and `list` returns a verdict computed from them, so a
     * wrong order shows up in an assertion. The gate returns neither — it
     * consumes the order inside `collectAiEvidence` and answers 200 or 409 —
     * and every other fixture in this file inserts its versions in
     * chronological order, where heap order and `created_at` order agree and an
     * unordered read is right by accident. Deleting this query's `ORDER BY`
     * outright changed nothing in the whole file before these two tests.
     *
     * Two `full` rows, and the gate's verdict is opposite for each:
     *
     * - the model's FIRST full draft — two sentences, exactly the body the item
     *   still carries — is the only correct anchor. Untouched AI, nobody opened
     *   it: the gate must refuse.
     * - a LONGER re-generation, three sentences, written FIRST physically and
     *   lowest by id but stamped an hour LATER. Anchor on it and the body has
     *   fewer sentences than "the model wrote", which reads as a human's
     *   deletion — the gate opens and publishes a draft no human ever saw.
     *
     * The ids are spelled out for the same reason the timestamps are: with
     * random ones, dropping `asc(created_at)` alone would leave `asc(id)`
     * choosing between the two `full` rows by coin flip.
     */
    it("refuses on the FIRST full row by created_at, not on whichever row comes back first", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      const [lowId, highId] = [randomUUID(), randomUUID()].sort() as [string, string];
      await addItemVersions(
        itemId,
        [
          {
            id: lowId,
            body: `${AI_BODY} On vous attend dès sept heures.`,
            createdAt: new Date("2026-08-01T11:00:00Z"),
          },
          { id: highId, body: AI_BODY, createdAt: new Date("2026-08-01T10:00:00Z") },
        ],
        { replaceExisting: true },
      );

      const refused = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(refused.status).toBe(409);
      // The body HAS a complete `ai` version to be judged against, so the
      // refusal is the one an edit can clear — not the dead-end sentence.
      expect(refused.body.message).toMatch(/open it, or edit it/i);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    /**
     * The other half of the same order, and the other direction of being wrong.
     *
     * The worker writes an item's versions and all its adaptations' in ONE
     * transaction, where `now()` — and therefore `created_at` — is identical
     * across them, so `created_at` alone is not a total order and the tiebreak
     * decides which row is "first". Here the two `full` rows share an instant
     * and the ids are chosen so heap order and id order DISAGREE: the
     * one-sentence row is written first physically, the two-sentence one is
     * first by id.
     *
     * A human then deletes one of the model's two sentences — every sentence
     * LEFT is still the model's, so only the count against the first `full` row
     * can see the human. Anchored correctly (two sentences) it does, and the
     * publish goes through. Anchored on the row the planner happened to return
     * (one sentence) the count matches, the draft reads as untouched AI, and
     * the caller who really did edit it is told to go and edit it.
     */
    it("breaks a same-instant tie by id, so a real edit is not refused", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      const [lowId, highId] = [randomUUID(), randomUUID()].sort() as [string, string];
      const sameInstant = new Date("2026-08-01T10:00:00Z");
      await addItemVersions(
        itemId,
        [
          { id: highId, body: "Passez nous voir.", createdAt: sameInstant },
          { id: lowId, body: AI_BODY, createdAt: sameInstant },
        ],
        { replaceExisting: true },
      );
      await agent.patch(`/api/content/${itemId}`).send({ body: "Café ouvert." }).expect(200);

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(1);
    });

    it("refuses a level whose only ai evidence is a fragment", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // Partial evidence refuses exactly as no evidence does. With no `full`
      // row there is no sentence count to measure against, so a deletion and a
      // rewrite are indistinguishable — and the body here is the model's own
      // text, untouched. Judging it against the fragment alone (one sentence
      // against two) reads a human edit that never happened.
      await addItemVersions(itemId, [{ body: AI_FRAGMENT, scope: "fragment", unitDelta: 0 }], {
        replaceExisting: true,
      });

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("a human save leaves a row the gate cannot see: same refusal, same sentence", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // The one shape where letting a `human` row count as evidence would
      // CHANGE an answer, which is why the assertion is on this shape and not
      // on an ordinary draft. With the item's only `ai` row a fragment there is
      // no `ai` full row, so the gate takes its missing-evidence branch and
      // says the refusal cannot be edited away. A human save then writes a
      // `full` row — and it is the FIRST full row this level has ever had, so a
      // gate that read it would find a reference equal to the body in front of
      // it, take the other branch, and print the other sentence.
      await addItemVersions(itemId, [{ body: AI_FRAGMENT, scope: "fragment", unitDelta: 0 }], {
        replaceExisting: true,
      });
      const before = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(before.status).toBe(409);
      expect(before.body.message).toMatch(/editing the body cannot clear this refusal/i);

      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Chaque phrase ici est de moi. Le modèle n'a rien écrit." })
        .expect(200);
      expect(await versionRows(itemId)).toContainEqual(
        expect.objectContaining({ origin: "human", scope: "full", adaptationId: null }),
      );

      const after = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(after.status).toBe(409);
      expect(after.body.message).toBe(before.body.message);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);

      // The other half of "invisible": the lens's reference text, read through
      // the same `origin = 'ai'` filter, is untouched by the save.
      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.aiVersionBodies.item).toEqual([AI_FRAGMENT]);
    });

    it("tells an AI draft that already published about the POST, not about reading it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // An AI item that went out (its human opened it once, long ago — the
      // stamp is irrelevant here, and deliberately left NULL to make the point
      // that BOTH refusals apply). Two 409s are available; the honest one is
      // about the post that is live in someone's channel.
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'published' WHERE id = '${adaptationIds[0]}'`,
      );
      await db.execute(`UPDATE content_items SET status = 'published' WHERE id = '${itemId}'`);
      await pool.end();

      const denial = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(denial.body.message).toBe(
        "This content has already been published; it can no longer be approved or rejected",
      );
    });

    it("a GET does not stamp the read receipt — the public API and the MCP server issue GETs", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      await agent.get("/api/content").expect(200);
      await agent.get(`/api/content/${itemId}`).expect(200);
      expect(await firstOpenedAt(itemId)).toBeNull();

      // The point of the separate endpoint: reading the item over the API is
      // not a human reading the draft, and must not open the publish gate.
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
    });

    it("a reflow and an NFD paste are not a human touch — both sides normalise the same way", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // Titled for what it exercises: extra SPACES and Unicode composition.
      // "Whitespace" in general is not true of this claim — U+000A is a
      // sentence boundary, so turning one into a space IS a human touch here,
      // and the version-writing test "records the newline a human turned into
      // a space" is where that half lives.
      //
      // A reflow and a copy-paste that arrived decomposed. Raw string equality
      // anywhere in the rule would read this as a human edit and let an
      // untouched AI draft through.
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: `  ${AI_BODY.normalize("NFD").replace(". ", ".  ")} ` })
        .expect(200);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
    });

    it("refuses when the AI's version rows are missing: unprovable is not the same as touched", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      // A terminal write that wrote the item and its adaptation but no version
      // rows — the shape a worker bug leaves behind. There is then nothing to
      // compare against, and `adaptations.origin` defaults to `human`, so a
      // rule that inferred "touched" from missing evidence would publish an
      // untouched AI draft.
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db
        .delete(schema.contentVersions)
        .where(eq(schema.contentVersions.contentItemId, itemId));
      await pool.end();

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("does not let another org's version row put a hand-typed draft behind the refusal", async () => {
      // The gate's OWN org filter, on the read that decides whether the gate is
      // even entered. Nothing about this draft is the model's, so clause 1 lets
      // it straight out — unless a row belonging to somebody else is counted as
      // evidence about it. Then the gate enters, that row IS the body, nobody
      // has opened it, and a draft the author typed by hand is refused as an
      // unread AI one, in a message telling them to edit text they wrote.
      //
      // The query moved above the bail-out with this increment, which is what
      // made a foreign row enough to change the ANSWER rather than just the
      // work done to reach it.
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;

      await otherOrgVersionRow(itemId, HUMAN_BODY);

      expect(await firstOpenedAt(itemId)).toBeNull();
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    });

    it("does not let another org's adaptation vouch that a channel was edited", async () => {
      // The same wrong-`org_id` shape, one table over, in the dangerous
      // direction: a channel whose text reads human-written makes
      // `everyChannelIsAi` false, and an AI draft nobody has opened publishes.
      //
      // It takes BOTH rows to move the verdict, and that is worth saying out
      // loud, because it is what the filter is really guarding. A foreign
      // adaptation on its own is harmless: its level has no `ai` evidence, so
      // `allSentencesAi` takes the missing-evidence branch and answers "still
      // the model's" — the fail-safe doing its job. The row that makes the
      // foreign channel judgeable is an `ai` version at ITS level carrying THIS
      // org's `org_id` — one writer passing the wrong org to the adaptation and
      // the right one to the version, which is exactly the class of bug the
      // repository's "every read is scoped" convention exists for.
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      const foreign = await otherOrgAdaptation(itemId, "Je l'ai réécrit moi-même pour ce canal.");
      await addAdaptationVersion(itemId, foreign, "Le modèle a écrit ce canal.");

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("refuses a hand-typed item whose channel text the model wrote, until someone opens it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await handTypedWithAiAdaptation(agent, brandId, [
        channelId,
      ]);

      // The gate's entry is the whole test: `content_items.origin` is `human`
      // here, so a gate entered on the ITEM's origin never looks at anything —
      // and what this item would actually publish is the ADAPTATION's body,
      // every word of it the model's, with nobody having read it.
      const res = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/editing the body cannot clear this refusal/i);

      const after = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(after.body.status).toBe("draft");
      expect(after.body.adaptations[0].status).toBe("pending");
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(0);
    });

    it("means what it says: rewriting that item's body does NOT clear the refusal", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await handTypedWithAiAdaptation(agent, brandId, [channelId]);

      // The cost the widening pays, pinned so the message cannot drift back to
      // promising it: with no `ai` version of the BODY, `allSentencesAi` takes
      // its missing-evidence branch and answers "still the model's" for every
      // body there is. The author can replace every word — as here — and be
      // refused again. This is exactly why the sentence they are shown offers
      // opening it and nothing else.
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Chaque mot ici est le mien. Rien de tout cela ne vient du modèle." })
        .expect(200);

      const res = await agent.post(`/api/content/${itemId}/approve`).send({});
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/editing the body cannot clear this refusal/i);
    });

    it("approves that same hand-typed item once someone opens it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await handTypedWithAiAdaptation(agent, brandId, [channelId]);

      // The one recovery the message promises, and it has to work: one click,
      // no edit, and the AI-written channel text goes out having been read.
      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      expect(approved.body.adaptations[0].status).toBe("queued");
    });

    it("leaves an ordinary human draft alone: no ai row anywhere is no gate", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, title: "Mine", body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;

      // The counterweight to the three above, and the thing the widening must
      // NOT break: an item nobody generated, never opened, with a `human`
      // version row of its own (what increment 2's saves append) and a
      // hand-typed override. The gate reads `ai` rows and there are none, so it
      // must not even ask its questions — every one of them would answer
      // "cannot prove otherwise" and refuse the product's ordinary flow.
      await addItemVersions(itemId, [{ body: HUMAN_BODY, origin: "human" }]);
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "My own words for this channel." })
        .expect(200);

      const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      expect(approved.body.adaptations[0].status).toBe("queued");
    });

    it("stamps the read receipt once: a second POST is still 204 and does not move the timestamp", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      const first = await firstOpenedAt(itemId);
      expect(first).not.toBeNull();

      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      // `WHERE first_opened_at IS NULL`: the column answers "has anyone ever
      // read this", so every later visit must leave the first answer alone.
      expect(await firstOpenedAt(itemId)).toEqual(first);
    });

    it("404s an opened for an item that does not exist", async () => {
      const agent = await orgAgent();
      await agent.post("/api/content/00000000-0000-4000-8000-000000000000/opened").expect(404);
    });

    it("returns the ai version bodies so the editor can dim untouched sentences", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);

      expect(fetched.body.aiVersionBodies.item).toEqual([AI_BODY]);
      expect(fetched.body.aiVersionBodies.adaptations[adaptationIds[0] as string]).toEqual([
        aiAdapted(0),
      ]);
    });

    it("returns EVERY ai version, oldest first — the lens dims against all of them", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // The lens dims a sentence that still matches ANY `ai` version, so this
      // endpoint must return them all — increment 2b's refine verbs write that
      // second row, and returning one of them would leave refined AI text
      // rendering as the human's own, silently. The `human` row in between is
      // the origin filter's turn: a version the author typed is not a
      // reference for "is this still the AI's text".
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
        .rows as { org_id: string }[];
      const orgId = row?.org_id as string;
      await db
        .delete(schema.contentVersions)
        .where(
          and(
            eq(schema.contentVersions.contentItemId, itemId),
            isNull(schema.contentVersions.adaptationId),
          ),
        );
      await db.insert(schema.contentVersions).values([
        {
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: AI_BODY,
          origin: "ai",
          createdAt: new Date("2026-08-01T10:00:00Z"),
        },
        {
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "The human's own sentence.",
          origin: "human",
          createdAt: new Date("2026-08-01T11:00:00Z"),
        },
        {
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "A later AI refinement.",
          origin: "ai",
          createdAt: new Date("2026-08-01T12:00:00Z"),
        },
      ]);
      await pool.end();

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.aiVersionBodies.item).toEqual([AI_BODY, "A later AI refinement."]);
    });

    /**
     * The tiebreak in `aiVersionRows`' ORDER BY, which the fixtures above
     * cannot exercise: they give every row its own timestamp, so `created_at`
     * alone already totally orders them and `asc(id)` could be deleted with
     * nothing turning red. The worker writes an item's versions and all its
     * adaptations' in ONE transaction, where `now()` is identical across them —
     * that is the shape this seeds, and the ids are chosen so heap order and id
     * order DISAGREE. Without the tiebreak the result is whatever the planner
     * felt like; with it, it is the same list every time.
     */
    it("orders same-instant version rows by id, so 'oldest first' is a total order", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`))
        .rows as { org_id: string }[];
      const orgId = row?.org_id as string;
      await db
        .delete(schema.contentVersions)
        .where(
          and(
            eq(schema.contentVersions.contentItemId, itemId),
            isNull(schema.contentVersions.adaptationId),
          ),
        );
      const sameInstant = new Date("2026-08-01T10:00:00Z");
      // Fresh ids, then sorted: the pair must be unique per run (this database
      // is not reset between them) and their ORDER must be known.
      const [lowId, highId] = [randomUUID(), randomUUID()].sort() as [string, string];
      // Inserted high-id first, so heap order is ["second", "first"] while id
      // order is the reverse. Only the tiebreak can tell the two apart.
      await db.insert(schema.contentVersions).values([
        {
          id: highId,
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "Written second by id.",
          origin: "ai",
          createdAt: sameInstant,
        },
        {
          id: lowId,
          orgId,
          contentItemId: itemId,
          adaptationId: null,
          body: "Written first by id.",
          origin: "ai",
          createdAt: sameInstant,
        },
      ]);
      await pool.end();

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.aiVersionBodies.item).toEqual([
        "Written first by id.",
        "Written second by id.",
      ]);
    });

    it("returns empty lists for a human-written item, which has no ai versions", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "I typed this myself.", channelIds: [channelId] })
        .expect(201);

      const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);

      expect(fetched.body.aiVersionBodies.item).toEqual([]);
      // Keyed, not absent: the web must never have to tell "this adaptation has
      // no AI text" apart from "the response forgot to mention it".
      expect(fetched.body.aiVersionBodies.adaptations[created.body.adaptations[0].id]).toEqual([]);
    });

    it("never leaks another org's version bodies", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const stranger = await orgAgent();
      await stranger.get(`/api/content/${itemId}`).expect(404);
    });

    it("reads version rows this org owns, not every row hanging off the item", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      // The 404 above cannot pin the version query's own org filter: `get` has
      // already refused on the ITEM lookup, so the stranger never reaches this
      // read. What the filter defends against is a version row carrying another
      // org's `org_id` while pointing at this item — the shape a writer that
      // passed the wrong orgId would leave behind — so that row is written here
      // and this org's response must not contain it. Drop
      // `eq(contentVersions.orgId, orgId)` and this is the test that fails.
      await otherOrgVersionRow(itemId, "Another org's words.");

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.aiVersionBodies.item).toEqual([AI_BODY]);
    });

    it("exposes origin on the list and on the item, for both levels", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.origin).toBe("ai");
      expect(fetched.body.adaptations[0].origin).toBe("ai");

      const listed = (await agent.get("/api/content").expect(200)).body as {
        id: string;
        origin: string;
        adaptations: { origin: string }[];
      }[];
      const mine = listed.find((item) => item.id === itemId);
      expect(mine?.origin).toBe("ai");
      expect(mine?.adaptations[0]?.origin).toBe("ai");

      // The badge's other branch: a human-composed draft, and the adaptations
      // it created with it.
      const human = await agent
        .post("/api/content")
        .send({ brandId, body: "Mine", channelIds: [channelId] })
        .expect(201);
      expect(human.body.origin).toBe("human");
      expect(human.body.adaptations[0].origin).toBe("human");
    });

    /**
     * The origin badge's fourth value, on the CARD as well as on the item.
     *
     * The provenance-lens design's §5 ships the lens off by default on the strength of one sentence:
     * the badge already carries the claim at a glance on every card. It could
     * not — the list has no reference text — so a rewritten item read
     * "AI-drafted" in the queue and "Human-edited" one click later. The list
     * carries the VERDICT instead: a boolean the api computes with the same
     * `allSentencesAi` the item response and the publish gate use, and none of
     * the version text a badge would have no use for.
     */
    it("answers the badge on the list too, not only on the item", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const bodyIsAiVerbatim = async () => {
        const listed = (await agent.get("/api/content").expect(200)).body as {
          id: string;
          bodyIsAiVerbatim: boolean;
        }[];
        return listed.find((item) => item.id === itemId)?.bodyIsAiVerbatim;
      };

      expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.bodyIsAiVerbatim).toBe(
        true,
      );
      expect(await bodyIsAiVerbatim()).toBe(true);

      const edited = await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "I rewrote the whole thing myself." })
        .expect(200);

      expect(edited.body.bodyIsAiVerbatim).toBe(false);
      // The card and the screen it opens now agree.
      expect(await bodyIsAiVerbatim()).toBe(false);
    });

    /**
     * The badge asks the gate's question, on the same rows.
     *
     * A fragment can never EQUAL a whole body, so whole-body equality captioned
     * a refined draft "Human-edited" on text that is one hundred percent the
     * model's — the product's one distinctive claim running backwards, on the
     * card and in the editor, while the gate refused the very same draft. Two
     * answers to one question on one screen.
     */
    it("reads AI-drafted for a refined body — every sentence is still the model's", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const listedVerdict = async () => {
        const listed = (await agent.get("/api/content").expect(200)).body as {
          id: string;
          bodyIsAiVerbatim: boolean;
        }[];
        return listed.find((item) => item.id === itemId)?.bodyIsAiVerbatim;
      };

      await addItemVersions(itemId, [{ body: AI_FRAGMENT, scope: "fragment", unitDelta: 0 }]);
      const edited = await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: REFINED_BODY })
        .expect(200);

      expect(edited.body.bodyIsAiVerbatim).toBe(true);
      const fetched = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(fetched.body.bodyIsAiVerbatim).toBe(true);
      expect(await listedVerdict()).toBe(true);
    });

    /**
     * A deletion is still a human act, and the CARD has to know it.
     *
     * This is the test that pins WHICH row the count runs against, and it is
     * the only one that can: everywhere else the item's single `full` row is
     * also its oldest row, so `aiRows[0]`, "some full row" and "the FIRST full
     * row" all name the same string and no mutation between them shows.
     *
     * Three rows, each with a job, written in an insert order that is NOT their
     * chronological order — because the list's version read carried no
     * `ORDER BY` at all while the badge asked whether the body matched ANY row
     * ("any" has no first), and an unordered read of "the first full row" is
     * wrong silently:
     *
     * - the FRAGMENT is the oldest, so `aiRows[0]` is a one-sentence row.
     *   Counting against it makes "at least as many sentences as the model
     *   wrote" true for every body — the deletion clause becomes a no-op and
     *   every deletion reads AI-drafted.
     * - a SECOND, shorter `full` row (the model regenerated the draft) is
     *   written first physically but stamped last, so a read that takes rows in
     *   table order rather than in `created_at` order anchors on one sentence
     *   and excuses the deletion below.
     * - the FIRST `full` row, two sentences, is the only correct anchor.
     *
     * The ids are spelled out so that id order disagrees with `created_at`
     * order too — the shorter `full` row sorts first by id. Left random, this
     * fixture pinned only the ORDER BY as a whole: dropping `asc(created_at)`
     * and keeping the tiebreak picked between the two `full` rows by coin
     * flip, and a mutation that survives half the runs is not pinned at all.
     */
    it("reads Human-edited for a deletion, counting against the first FULL row", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const [lowId, midId, highId] = [randomUUID(), randomUUID(), randomUUID()].sort() as [
        string,
        string,
        string,
      ];
      await addItemVersions(
        itemId,
        [
          {
            id: midId,
            body: AI_FRAGMENT,
            scope: "fragment",
            // One sentence replaced by one: this fragment moves no count, so
            // the deletion below is countable against the first `full` row and
            // nothing else — which is what this test is about.
            unitDelta: 0,
            createdAt: new Date("2026-08-01T09:00:00Z"),
          },
          { id: lowId, body: "Passez nous voir.", createdAt: new Date("2026-08-01T11:00:00Z") },
          { id: highId, body: AI_BODY, createdAt: new Date("2026-08-01T10:00:00Z") },
        ],
        { replaceExisting: true },
      );
      // One of the model's two sentences, deleted. Every sentence LEFT is the
      // model's, so the mask alone says "untouched" and only the count against
      // the first full row says a human was here.
      const edited = await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Café ouvert." })
        .expect(200);

      expect(edited.body.bodyIsAiVerbatim).toBe(false);
      const listed = (await agent.get("/api/content").expect(200)).body as {
        id: string;
        bodyIsAiVerbatim: boolean;
      }[];
      expect(listed.find((item) => item.id === itemId)?.bodyIsAiVerbatim).toBe(false);
    });

    /**
     * The same-instant tiebreak, asked of the CARD.
     *
     * `get` returns the version rows, so the tiebreak in its read is pinned by
     * reading the order back ("orders same-instant version rows by id" above).
     * The queue's read returns no rows at all — only this boolean — so nothing
     * here reads an order back, and every other list fixture gives its rows
     * distinct timestamps, under which `created_at` alone already totally
     * orders them. Deleting `asc(id)` from the queue's query changed nothing in
     * this file before this test.
     *
     * One transaction's worth of rows: two `full` versions at the same instant,
     * ids chosen so heap order and id order disagree, the one-sentence row
     * written first physically. A human then deletes one of the model's two
     * sentences — countable only against the two-sentence row that is first by
     * id. Anchored on the other, the card captions a trimmed draft "AI-drafted"
     * and the deletion clause is a no-op on every card in the queue.
     */
    it("breaks a same-instant tie by id on the card, which returns no rows to check", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const [lowId, highId] = [randomUUID(), randomUUID()].sort() as [string, string];
      const sameInstant = new Date("2026-08-01T10:00:00Z");
      await addItemVersions(
        itemId,
        [
          { id: highId, body: "Passez nous voir.", createdAt: sameInstant },
          { id: lowId, body: AI_BODY, createdAt: sameInstant },
        ],
        { replaceExisting: true },
      );
      await agent.patch(`/api/content/${itemId}`).send({ body: "Café ouvert." }).expect(200);

      const listed = (await agent.get("/api/content").expect(200)).body as {
        id: string;
        bodyIsAiVerbatim: boolean;
      }[];
      expect(listed.find((item) => item.id === itemId)?.bodyIsAiVerbatim).toBe(false);
    });

    it("keeps reading verbatim when there is no ai version to compare against", async () => {
      // Missing evidence is not evidence of an edit: a human-written item has
      // no version rows at all, and must not read as one somebody edited.
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "I typed this myself.", channelIds: [channelId] })
        .expect(201);

      expect(created.body.bodyIsAiVerbatim).toBe(true);
      const listed = (await agent.get("/api/content").expect(200)).body as {
        id: string;
        bodyIsAiVerbatim: boolean;
      }[];
      expect(listed.find((item) => item.id === created.body.id)?.bodyIsAiVerbatim).toBe(true);
    });

    it("compares the badge against the ITEM's own ai rows — not a channel's, not a human's", async () => {
      // An adapter rewrites the text for its platform, so an adaptation's `ai`
      // body never matches the master body. Letting one into the item's
      // reference would make every card read "human-edited".
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const listedVerdict = async () => {
        const listed = (await agent.get("/api/content").expect(200)).body as {
          id: string;
          bodyIsAiVerbatim: boolean;
        }[];
        return listed.find((item) => item.id === itemId)?.bodyIsAiVerbatim;
      };
      expect(await listedVerdict()).toBe(true);

      // The direction an untouched draft cannot pin, and the one that inverts
      // the product's claim: the author's own rewrite, which HAPPENS to be the
      // text the adapter wrote for the channel. Two sentences, so the deletion
      // clause cannot rescue the verdict either. Widen either filter on the
      // card's query — `adaptation_id IS NULL`, or `origin = 'ai'`, which would
      // admit the author's own version row as evidence that the MODEL wrote
      // this — and the author's own words are captioned "AI-drafted".
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: aiAdapted(0) })
        .expect(200);
      expect(await listedVerdict()).toBe(false);
      // ...and the same question on the screen that card opens, where the
      // evidence is keyed by LEVEL in TypeScript rather than filtered in SQL.
      // Collapse that key and the card and the screen disagree again — the
      // exact split this increment exists to close.
      expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.bodyIsAiVerbatim).toBe(
        false,
      );
    });

    it("answers the badge from version rows this org owns, on the card and on the item", async () => {
      // `get`'s twin, one query over: a stranger's 404 cannot pin either org
      // filter, because the stranger never reaches these reads. A row carrying
      // another org's `org_id` while pointing at this item is what they defend
      // against — and reading it here would caption a rewrite the author typed
      // as the model's own text.
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);

      const myOwn = "J'ai tout réécrit. Chaque phrase est la mienne.";
      await agent.patch(`/api/content/${itemId}`).send({ body: myOwn }).expect(200);
      await otherOrgVersionRow(itemId, myOwn);

      const listed = (await agent.get("/api/content").expect(200)).body as {
        id: string;
        bodyIsAiVerbatim: boolean;
      }[];
      expect(listed.find((item) => item.id === itemId)?.bodyIsAiVerbatim).toBe(false);
      expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.bodyIsAiVerbatim).toBe(
        false,
      );
    });

    /**
     * The character a `<textarea>` silently drops.
     *
     * The API stored a CRLF body verbatim, and the provenance lens renders its
     * overlay from the React string while the field holds the DOM's normalised
     * value — so the two layers laid down different numbers of characters, the
     * counter reported a length the field did not have, and the first keystroke
     * anywhere rewrote every CR out of the document. The DTOs normalise, which
     * is the boundary the public API, the MCP server and a script all cross.
     */
    it("stores a CRLF body with plain newlines, whatever the caller sent", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Line one.\r\nLine two.", channelIds: [channelId] })
        .expect(201);

      expect(created.body.body).toBe("Line one.\nLine two.");
      const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
      expect(fetched.body.body).toBe("Line one.\nLine two.");
      expect(fetched.body.body).not.toContain("\r");

      const patched = await agent
        .patch(`/api/content/${created.body.id}`)
        .send({ body: "Edited one.\rEdited two." })
        .expect(200);
      expect(patched.body.body).toBe("Edited one.\nEdited two.");

      const adaptationId = fetched.body.adaptations[0].id as string;
      const override = await agent
        .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
        .send({ body: "Override one.\r\nOverride two." })
        .expect(200);
      // The adaptation PATCH answers with the adaptation row itself.
      expect(override.body.body).toBe("Override one.\nOverride two.");
    });
  });

  describe("archiving content", () => {
    it("keeps a rejected post and its history, hides it from the queue, and restores its exact status", async () => {
      const agent = await orgAgent();
      const otherOrg = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, title: "Saved post", body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Edited before filing." })
        .expect(200);
      await agent.post(`/api/content/${itemId}/reject`).expect(200);
      const historyBefore = await versionRows(itemId);

      await otherOrg.post(`/api/content/${itemId}/archive`).expect(404);
      const archived = await agent.post(`/api/content/${itemId}/archive`).expect(200);
      expect(archived.body.status).toBe("archived");
      expect(archived.body.body).toBe("Edited before filing.");
      expect(archived.body.adaptations[0].status).toBe("pending");
      const delivery = await agent
        .post(`/api/content/${itemId}/adaptations/${created.body.adaptations[0].id}/delivery`)
        .send({ delivered: true })
        .expect(409);
      expect(delivery.body.code).toBe("content_archived");
      expect((await agent.get("/api/content").expect(200)).body).toHaveLength(0);
      const archive = await agent.get("/api/content?status=archived").expect(200);
      expect(archive.body.map((item: { id: string }) => item.id)).toEqual([itemId]);
      await agent.post(`/api/content/${itemId}/archive`).expect(200);

      await agent.patch(`/api/content/${itemId}`).send({ body: "Changed" }).expect(409);
      const approve = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(approve.body.code).toBe("content_archived");
      const reject = await agent.post(`/api/content/${itemId}/reject`).expect(409);
      expect(reject.body.code).toBe("content_archived");
      await otherOrg.post(`/api/content/${itemId}/restore`).expect(404);

      const restored = await agent.post(`/api/content/${itemId}/restore`).expect(200);
      expect(restored.body.status).toBe("rejected");
      expect(restored.body.body).toBe("Edited before filing.");
      expect(await versionRows(itemId)).toEqual(historyBefore);
      await agent.post(`/api/content/${itemId}/restore`).expect(200);
      expect((await agent.get("/api/content").expect(200)).body).toHaveLength(1);
      expect((await agent.get("/api/content?status=archived").expect(200)).body).toHaveLength(0);
    });

    it("refuses active deliveries until they are explicitly rejected", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;
      // Each delivery state that can still send is guarded by the same archive
      // decision. The fixture changes only this row's status, never a job.
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        for (const status of ["queued", "scheduled", "publishing", "manual_ready"] as const) {
          await db
            .update(schema.adaptations)
            .set({ status })
            .where(eq(schema.adaptations.id, adaptationId));
          const refused = await agent.post(`/api/content/${itemId}/archive`).expect(409);
          expect(refused.body.code).toBe("content_archive_delivery_active");
        }
      } finally {
        await pool.end();
      }
      await agent.post(`/api/content/${itemId}/reject`).expect(200);
      expect((await agent.post(`/api/content/${itemId}/archive`).expect(200)).body.status).toBe(
        "archived",
      );
    });

    it("preserves published receipts and restores a published post without another send", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;
      const orgId = await orgOf(itemId);
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        await db
          .update(schema.adaptations)
          .set({ status: "published" })
          .where(eq(schema.adaptations.id, adaptationId));
        await db
          .update(schema.contentItems)
          .set({ status: "published" })
          .where(eq(schema.contentItems.id, itemId));
        await db.insert(schema.publications).values({
          orgId,
          adaptationId,
          channelId,
          status: "published",
          externalUrl: "https://example.com/published-post",
        });

        await agent.post(`/api/content/${itemId}/archive`).expect(200);
        const restored = await agent.post(`/api/content/${itemId}/restore`).expect(200);
        expect(restored.body.status).toBe("published");
        expect(restored.body.adaptations[0].externalUrl).toBe("https://example.com/published-post");
        expect(
          await db
            .select({ id: schema.publications.id })
            .from(schema.publications)
            .where(eq(schema.publications.adaptationId, adaptationId)),
        ).toHaveLength(1);
      } finally {
        await pool.end();
      }
    });
  });

  describe("permanently deleting content", () => {
    it("deletes an archived draft and its drafts, while preserving its AI cost ledger", async () => {
      const agent = await orgAgent();
      const otherOrg = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;
      const orgId = await orgOf(itemId);
      await agent.patch(`/api/content/${itemId}`).send({ body: "A revised draft." }).expect(200);
      expect(await versionRows(itemId)).toHaveLength(1);

      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        const [ledger] = await db
          .insert(schema.usageLedger)
          .values({
            orgId,
            contentItemId: itemId,
            adaptationId,
            step: "test/delete",
            provider: "google",
            modelId: "gemini-test",
            costSource: "price_table",
            status: "ok",
            outcome: "completed",
          })
          .returning({ id: schema.usageLedger.id });
        if (!ledger) throw new Error("Expected a cost ledger row");

        const unarchived = await agent.delete(`/api/content/${itemId}`).expect(409);
        expect(unarchived.body.code).toBe("content_delete_requires_archive");
        const archived = await agent.post(`/api/content/${itemId}/archive`).expect(200);
        expect(archived.body.archivedFromStatus).toBe("draft");
        await otherOrg.delete(`/api/content/${itemId}`).expect(404);
        await agent.delete(`/api/content/${itemId}`).expect(204);
        await agent.get(`/api/content/${itemId}`).expect(404);
        await agent.delete(`/api/content/${itemId}`).expect(404);
        expect(await versionRows(itemId)).toHaveLength(0);
        expect(
          await db
            .select({ id: schema.adaptations.id })
            .from(schema.adaptations)
            .where(eq(schema.adaptations.id, adaptationId)),
        ).toHaveLength(0);
        const [cost] = await db
          .select({
            contentItemId: schema.usageLedger.contentItemId,
            adaptationId: schema.usageLedger.adaptationId,
          })
          .from(schema.usageLedger)
          .where(eq(schema.usageLedger.id, ledger.id));
        expect(cost).toEqual({ contentItemId: null, adaptationId: null });
      } finally {
        await pool.end();
      }
    });

    it("allows a rejected archive but refuses one that was previously approved", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const rejected = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const rejectedId = rejected.body.id as string;
      await agent.post(`/api/content/${rejectedId}/reject`).expect(200);
      expect(
        (await agent.post(`/api/content/${rejectedId}/archive`).expect(200)).body
          .archivedFromStatus,
      ).toBe("rejected");
      await agent.delete(`/api/content/${rejectedId}`).expect(204);

      const approved = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const approvedId = approved.body.id as string;
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        await db
          .update(schema.contentItems)
          .set({ status: "approved" })
          .where(eq(schema.contentItems.id, approvedId));
        await agent.post(`/api/content/${approvedId}/archive`).expect(200);
        const refused = await agent.delete(`/api/content/${approvedId}`).expect(409);
        expect(refused.body.code).toBe("content_delete_not_draft");
        expect((await agent.get(`/api/content/${approvedId}`).expect(200)).body.status).toBe(
          "archived",
        );
      } finally {
        await pool.end();
      }
    });

    it("preserves every publication receipt, including a failed attempt on an archived draft", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;
      const orgId = await orgOf(itemId);
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        const [receipt] = await db
          .insert(schema.publications)
          .values({
            orgId,
            adaptationId,
            channelId,
            status: "failed",
            error: "Rejected by platform",
          })
          .returning({ id: schema.publications.id });
        if (!receipt) throw new Error("Expected a publication receipt");
        await agent.post(`/api/content/${itemId}/archive`).expect(200);
        const refused = await agent.delete(`/api/content/${itemId}`).expect(409);
        expect(refused.body.code).toBe("content_delete_has_delivery_history");
        expect(
          await db
            .select({ id: schema.publications.id })
            .from(schema.publications)
            .where(eq(schema.publications.id, receipt.id)),
        ).toHaveLength(1);
        expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.status).toBe(
          "archived",
        );
      } finally {
        await pool.end();
      }
    });

    it("refuses an attempted delivery even without a surviving receipt", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        await db
          .update(schema.adaptations)
          .set({ attemptCount: 1, status: "failed" })
          .where(eq(schema.adaptations.id, adaptationId));
        await agent.post(`/api/content/${itemId}/archive`).expect(200);
        const refused = await agent.delete(`/api/content/${itemId}`).expect(409);
        expect(refused.body.code).toBe("content_delete_has_delivery_history");
      } finally {
        await pool.end();
      }
    });

    it("retains generated drafts while their run checkpoints remain readable", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const orgId = await orgOf(itemId);
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        await db.insert(schema.pipelineRuns).values({
          orgId,
          brandId,
          contentItemId: itemId,
          input: { kind: "brief", text: "A private generation brief", channelIds: [channelId] },
          status: "succeeded",
        });
        await agent.post(`/api/content/${itemId}/archive`).expect(200);
        const refused = await agent.delete(`/api/content/${itemId}`).expect(409);
        expect(refused.body.code).toBe("content_delete_has_generation_history");
        expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.status).toBe(
          "archived",
        );
      } finally {
        await pool.end();
      }
    });

    it("retains a draft when channel deletion orphaned its publication receipt", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;
      const orgId = await orgOf(itemId);
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      try {
        const [receipt] = await db
          .insert(schema.publications)
          .values({ orgId, adaptationId, channelId, status: "failed", error: "Rejected" })
          .returning({ id: schema.publications.id });
        if (!receipt) throw new Error("Expected receipt");
        await agent.delete(`/api/channels/${channelId}`).expect(200);
        const [orphan] = await db
          .select({ adaptationId: schema.publications.adaptationId })
          .from(schema.publications)
          .where(eq(schema.publications.id, receipt.id));
        expect(orphan?.adaptationId).toBeNull();
        await agent.post(`/api/content/${itemId}/archive`).expect(200);
        const refused = await agent.delete(`/api/content/${itemId}`).expect(409);
        expect(refused.body.code).toBe("content_delete_has_delivery_history");
        expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.status).toBe(
          "archived",
        );
      } finally {
        await pool.end();
      }
    });
  });

  /**
   * WHAT A QUEUE CARD IS, AND IN WHAT ORDER THE CARDS ARRIVE — the two halves
   * of design 0009's first commit that a caller can see.
   */
  describe("the shape of the queue", () => {
    /** Long enough that its absence from a list row is unmistakable. */
    const CARD_BODY = "Nous ouvrons à sept heures et le café est déjà prêt.";

    /**
     * The list row has no `body`; the item still does.
     *
     * Both halves through the SHARED schemas rather than by hand, so the two
     * ends of the wire are held to one declaration: `contentListItemDtoSchema`
     * is `strictObject`, which is what makes a `body` finding its way back onto
     * the list a failed parse here instead of 44 % of a response nobody reads.
     * The parse also fails the other way — a column the card does need going
     * missing — which `expect(...).not.toHaveProperty` alone could never see.
     */
    it("draws a card without the text, while the item it opens keeps it", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, title: "A card", body: CARD_BODY, channelIds: [channelId] })
        .expect(201);

      const listed = (await agent.get("/api/content").expect(200)).body as unknown[];
      expect(listed).toHaveLength(1);
      const card = contentListItemDtoSchema.parse(listed[0]);
      expect(card.id).toBe(created.body.id);
      expect(card).not.toHaveProperty("body");
      expect(card.adaptations[0]?.channelId).toBe(channelId);

      const fetched = (await agent.get(`/api/content/${card.id}`).expect(200)).body;
      expect(contentDetailDtoSchema.parse(fetched).body).toBe(CARD_BODY);
    });

    /**
     * THE CHANNEL STRIP IS IN CREATION ORDER, on the card and on the item.
     *
     * The screen renders `item.adaptations.map(...)` straight through
     * (`apps/web/src/app/[locale]/content/page.tsx`), so the order these rows
     * come back in IS the order of the channel strip a reader sees — and
     * neither read asked for one. This commit's whole argument about the cards
     * applies one level down, and harder since the batched read: the strip of
     * ONE item now depends on a scan over every item on the page, so a second
     * draft written by somebody else could reshuffle the first one's channels.
     * `lockAdaptations` already orders these rows for a reason of its own.
     *
     * The item is created through the route with one channel, and the second
     * row is written afterwards with an OLDER `created_at` — so insertion
     * order, physical order and creation order are three different answers, and
     * a strip that came back the way the rows were written would name the wrong
     * channel first.
     *
     * Both paths, because they are two queries: the list's batched
     * `adaptationsForMany` and the item's `adaptationsFor`.
     */
    it("lists an item's channels in the order they were created, not the planner's", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const second = await agent
        .post("/api/channels")
        .send({
          brandId,
          platform: "telegram",
          name: "Second",
          credentials: { botToken: "123:abc", chatId: "-1009876543210" },
        })
        .expect(201);
      const created = await agent
        .post("/api/content")
        .send({ brandId, title: "Two channels", body: CARD_BODY, channelIds: [channelId] })
        .expect(201);

      const { createDb, schema } = await import("@pubrick/db");
      const seed = createDb(url as string);
      try {
        const [row] = (await seed.db.execute(`SELECT org_id FROM brands WHERE id = '${brandId}'`))
          .rows as { org_id: string }[];
        const orgId = row?.org_id as string;
        // Written last, created first: the route stamped the row above with
        // `now()`, and this one is backdated a day.
        await seed.db.insert(schema.adaptations).values({
          orgId,
          contentItemId: created.body.id as string,
          channelId: second.body.id as string,
          createdAt: new Date("2026-09-09T08:00:00.000Z"),
        });
      } finally {
        await seed.pool.end();
      }

      const [card] = (await agent.get("/api/content").expect(200)).body as {
        adaptations: { channelId: string }[];
      }[];
      expect(card?.adaptations.map((a) => a.channelId)).toEqual([second.body.id, channelId]);

      const fetched = (await agent.get(`/api/content/${created.body.id}`).expect(200)).body as {
        adaptations: { channelId: string }[];
      };
      expect(fetched.adaptations.map((a) => a.channelId)).toEqual([second.body.id, channelId]);
    });

    /**
     * NEWEST FIRST, TIES BROKEN BY `id`, AND THE SAME BOTH TIMES.
     *
     * `list` had no `ORDER BY` at all, so the answer was the planner's — which
     * on a small table is the physical order of the rows and looks like a
     * decision. The three items below are written in an order that is none of
     * the three: physically first is the OLDEST, and the two newest share a
     * `created_at` to the microsecond, which is what the generate worker's
     * single-transaction write produces. Planner order is `a, b, c`; the answer
     * is `c, b, a`.
     *
     * Written straight into the table because both facts being asserted are
     * facts about columns a caller cannot set: `POST /api/content` stamps
     * `created_at` with `now()` and hands out a random `id`, so through the
     * route there is no tie to break and no way to put the oldest row first.
     *
     * THE IDS ARE ASSIGNED SO THAT THE TWO KEYS DISAGREE. Sorted ascending and
     * handed out `tieLow, tieHigh, oldest`, the OLDEST row carries the LARGEST
     * id — so `ORDER BY id DESC` alone answers `oldest, tieHigh, tieLow`, which
     * is not what is expected below. Assigned the other way round (ascending
     * into `oldest, tieLow, tieHigh`, as this test first had it) an id-only
     * order produces the expected answer exactly, and the test passes while
     * saying nothing about `created_at` at all.
     *
     * IT STILL CANNOT TELL THE CLAUSE FROM THE PLANNER. Deleting the `ORDER BY`
     * leaves whatever plan the statistics of the moment buy — measured on this
     * seed, a bitmap heap scan plus a sort, which returns these three rows in
     * insertion order and can change with the next `ANALYZE`. The clause itself
     * is pinned in `content-list-cost.e2e.spec.ts`, on the text of the
     * statement and on its plan, where no accident can stand in for it. What
     * this test holds is the CONTRACT: the order a caller is promised, tie
     * included.
     */
    it("answers newest first, breaking a tie on created_at by id", async () => {
      const agent = await orgAgent();
      const { brandId } = await brandWithChannel(agent);
      const { createDb, schema } = await import("@pubrick/db");
      const seed = createDb(url as string);
      // Ascending, so the roles below are assigned by a known order rather than
      // by whatever three random uuids happen to compare as — and assigned so
      // the oldest row holds the largest id (see the docstring).
      const [tieLow, tieHigh, oldest] = [randomUUID(), randomUUID(), randomUUID()].sort();
      const tied = new Date("2026-09-10T08:00:00.000Z");
      try {
        const [brandRow] = (
          await seed.db.execute(`SELECT org_id FROM brands WHERE id = '${brandId}'`)
        ).rows as { org_id: string }[];
        const orgId = brandRow?.org_id as string;
        await seed.db.insert(schema.contentItems).values([
          {
            id: oldest,
            orgId,
            brandId,
            body: "Written first, and the oldest of the three.",
            createdAt: new Date("2026-09-09T08:00:00.000Z"),
          },
          { id: tieLow, orgId, brandId, body: "Second.", createdAt: tied },
          { id: tieHigh, orgId, brandId, body: "Third.", createdAt: tied },
        ]);
      } finally {
        await seed.pool.end();
      }

      const ids = async () =>
        ((await agent.get("/api/content").expect(200)).body as { id: string }[]).map(
          (item) => item.id,
        );
      expect(await ids()).toEqual([tieHigh, tieLow, oldest]);
      // A read of an unchanged queue that answers differently the second time
      // is the same defect as the wrong order, and the tiebreak is what rules
      // it out for the two rows one `created_at` cannot separate.
      expect(await ids()).toEqual([tieHigh, tieLow, oldest]);
    });
  });

  /**
   * The other half of the history: until now exactly one thing wrote
   * `content_versions`, the worker's terminal write, always `origin: 'ai'`. No
   * human action wrote a row at all — so the version history increment 2c
   * renders had nothing to show, and Restore nothing to restore to.
   */
  describe("saved version history and restore", () => {
    it("lists whole-body snapshots on demand and restores an earlier body as a human edit", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "First draft.", channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      await agent.patch(`/api/content/${itemId}`).send({ body: "Second draft." }).expect(200);
      await agent.patch(`/api/content/${itemId}`).send({ body: "Third draft." }).expect(200);

      const history = await agent.get(`/api/content/${itemId}/versions`).expect(200);
      expect(history.body.map((row: { body: string }) => row.body)).toEqual([
        "Third draft.",
        "Second draft.",
      ]);
      expect(
        history.body.every((row: { adaptationId: string | null }) => row.adaptationId === null),
      ).toBe(true);

      const restored = await agent
        .post(`/api/content/${itemId}/versions/${history.body[1].id}/restore`)
        .send({ expectedBody: "Third draft." })
        .expect(200);
      expect(restored.body.body).toBe("Second draft.");
      const after = await agent.get(`/api/content/${itemId}/versions`).expect(200);
      expect(after.body[0].body).toBe("Second draft.");
      expect(after.body[0].origin).toBe("human");

      // A stale reader cannot overwrite a newer edit, even with a real version id.
      await agent
        .post(`/api/content/${itemId}/versions/${history.body[0].id}/restore`)
        .send({ expectedBody: "Third draft." })
        .expect(409);
      expect((await agent.get(`/api/content/${itemId}`).expect(200)).body.body).toBe(
        "Second draft.",
      );

      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      const pinned = await agent
        .post(`/api/content/${itemId}/versions/${history.body[0].id}/restore`)
        .send({ expectedBody: "Second draft." })
        .expect(409);
      expect(pinned.body.code).toBe("content_pinned_approved");
    });

    it("pages equal-timestamp drafts without repeating a boundary or listing refine fragments", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Current draft.", channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      await addItemVersions(itemId, [
        ...Array.from({ length: 23 }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          body: `Saved draft ${index}.`,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        })),
        { body: "A refine fragment, never a whole draft.", scope: "fragment", unitDelta: 1 },
      ]);

      const first = await agent.get(`/api/content/${itemId}/versions`).expect(200);
      expect(first.body).toHaveLength(20);
      const cursor = first.headers["x-next-cursor"] as string;
      expect(cursor).toBe(first.body[19].id);
      const second = await agent
        .get(`/api/content/${itemId}/versions?cursor=${cursor}`)
        .expect(200);
      expect(second.body).toHaveLength(3);
      expect(second.headers["x-next-cursor"]).toBeUndefined();
      expect([...first.body, ...second.body].map((row: { body: string }) => row.body)).toEqual(
        Array.from({ length: 23 }, (_, index) => `Saved draft ${22 - index}.`),
      );
    });

    it("keeps each channel's versions separate and refuses a cross-org restore", async () => {
      const agent = await orgAgent();
      const stranger = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Master copy.", channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "First channel copy." })
        .expect(200);
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "Second channel copy." })
        .expect(200);

      const master = await agent.get(`/api/content/${itemId}/versions`).expect(200);
      expect(master.body).toEqual([]);
      const history = await agent
        .get(`/api/content/${itemId}/versions?adaptationId=${adaptationId}`)
        .expect(200);
      expect(history.body.map((row: { body: string }) => row.body)).toEqual([
        "Second channel copy.",
        "First channel copy.",
      ]);
      await stranger
        .get(`/api/content/${itemId}/versions?adaptationId=${adaptationId}`)
        .expect(404);
      await stranger
        .post(`/api/content/${itemId}/versions/${history.body[1].id}/restore`)
        .send({ expectedBody: "Second channel copy.", expectedHashtags: [], expectedCta: null })
        .expect(404);
      const restored = await agent
        .post(`/api/content/${itemId}/versions/${history.body[1].id}/restore`)
        .send({ expectedBody: "Second channel copy.", expectedHashtags: [], expectedCta: null })
        .expect(200);
      expect(restored.body.body).toBe("Master copy.");
      expect(restored.body.adaptations[0].body).toBe("First channel copy.");
    });
  });

  describe("a human edit leaves a version behind", () => {
    it("records a version when a human changes the body, and none when nothing changed", async () => {
      const agent = await orgAgent();
      const userId = await sessionUserId(agent);
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, title: "Mine", body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;

      // Creating a draft is not a save: the body is already the row, and a
      // version of it would be history of an edit nobody made.
      expect(await versionRows(itemId)).toHaveLength(0);

      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Voici ma version éditée." })
        .expect(200);
      const afterEdit = await versionRows(itemId);
      expect(afterEdit).toEqual([
        {
          adaptationId: null,
          body: "Voici ma version éditée.",
          // Not written, exactly as the worker's own rows do not write it: the
          // rule is "only when the BODY changed", so a title carried along here
          // would be a title history with the title-only saves missing from it.
          title: null,
          origin: "human",
          scope: "full",
          // Null on a `full` row, and the CHECK requires it to be: a whole body
          // anchors the deletion clause, it does not move it.
          unitDelta: null,
          createdBy: userId,
        },
      ]);

      // Saving the same text again is the Save button pressed twice, and the
      // commonest thing a form does. It is not a version.
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Voici ma version éditée." })
        .expect(200);
      expect(await versionRows(itemId)).toHaveLength(1);

      // Nor is a reflow: the comparison is `normalizeForComparison`, the same
      // one the gate and the badge judge a human touch by, so a collapsed
      // space, a zero-width space or an NFD paste writes no row either — as
      // none of them moves a verdict.
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "  Voici   ma\tversion \u200Béditée. ".normalize("NFD") })
        .expect(200);
      expect(await versionRows(itemId)).toHaveLength(1);
    });

    /**
     * The save that a whole-body comparison could not see, end to end.
     *
     * `normalizeForComparison` collapses every whitespace run, so swapping one
     * U+000A for a space is nothing to it. The gate and the badge SPLIT first,
     * and a newline is a sentence boundary — so that same keystroke is the one
     * thing that turns their 409 into an approval. Two definitions of "did the
     * body change" in one file, and the lax one owned the version writer: the
     * model's text shipped, byte for byte, with no row naming the human act
     * that authorised it.
     *
     * Line-structured copy, because that is what the splitter is written for
     * and what social posts actually look like.
     */
    it("records the newline a human turned into a space — the save that opens the gate", async () => {
      const agent = await orgAgent();
      const userId = await sessionUserId(agent);
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);

      const lines = "Notre collection est arrivée\nVenez la découvrir en boutique.";
      await setItemBody(itemId, lines);
      await addItemVersions(itemId, [{ body: lines }], { replaceExisting: true });

      // Nobody has read it and every sentence is still the model's.
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);

      const joined = lines.replace("\n", " ");
      await agent.patch(`/api/content/${itemId}`).send({ body: joined }).expect(200);

      // The row that says who did it. Without it the publish below has no
      // author anywhere in the database.
      expect((await versionRows(itemId)).filter((row) => row.origin === "human")).toEqual([
        {
          adaptationId: null,
          body: joined,
          title: null,
          origin: "human",
          scope: "full",
          unitDelta: null,
          createdBy: userId,
        },
      ]);

      // ...and the gate really does open on it, which is why the row matters.
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      expect(await publishJobCount(adaptationIds[0] as string)).toBe(1);
    });

    it("writes no version for a title-only edit, and none for a cleared override", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, title: "Mine", body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;

      const titled = await agent
        .patch(`/api/content/${itemId}`)
        .send({ title: "A better headline" })
        .expect(200);
      expect(titled.body.title).toBe("A better headline");
      expect(await versionRows(itemId)).toHaveLength(0);

      // An override, then the emptied textarea the shipped UI sends as `null`
      // (content/[id]/page.tsx). Clearing removes text and writes none, and
      // `content_versions.body` is NOT NULL — there is no row shape for it.
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "My own words for this channel." })
        .expect(200);
      expect(await versionRows(itemId)).toHaveLength(1);

      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: null })
        .expect(200);
      expect(await versionRows(itemId)).toHaveLength(1);
    });

    it("records a channel override at that channel's level, not the item's", async () => {
      // `updateAdaptation` is governed by the same rule as `update` — the point
      // the spec's earlier draft was silent on. The row must name the
      // adaptation, or 2c's history would file one channel's text as the
      // master body's and Restore would put it there.
      const agent = await orgAgent();
      const userId = await sessionUserId(agent);
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId, adaptationIds } = await aiDraft(agent, brandId, [channelId]);
      const adaptationId = adaptationIds[0] as string;

      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "Ma propre version pour ce canal." })
        .expect(200);

      const rows = await versionRows(itemId);
      expect(rows.filter((row) => row.origin === "human")).toEqual([
        {
          adaptationId,
          body: "Ma propre version pour ce canal.",
          title: null,
          origin: "human",
          scope: "full",
          unitDelta: null,
          createdBy: userId,
        },
      ]);

      // Same override saved again: no row, one level down, for the same reason.
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "Ma propre version pour ce canal." })
        .expect(200);
      expect((await versionRows(itemId)).filter((row) => row.origin === "human")).toHaveLength(1);
    });

    it("writes nothing when the edit is refused", async () => {
      // The row goes in the SAME transaction as the body write, so a 409 must
      // leave no history of an edit that never landed.
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);
      await agent.post(`/api/content/${itemId}/opened`).expect(204);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

      const before = await versionRows(itemId);
      await agent.patch(`/api/content/${itemId}`).send({ body: "Too late." }).expect(409);
      expect(await versionRows(itemId)).toEqual(before);
    });
  });

  it("isolates content between organizations", async () => {
    const a = await orgAgent();
    const b = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(a);
    const created = await a
      .post("/api/content")
      .send({ brandId, body: "Mine", channelIds: [channelId] })
      .expect(201);

    const itemId = created.body.id as string;
    const adaptationId = created.body.adaptations[0].id as string;

    expect((await b.get("/api/content").expect(200)).body).toHaveLength(0);
    await b.get(`/api/content/${itemId}`).expect(404);
    await b.post(`/api/content/${itemId}/approve`).send({}).expect(404);
    // reject is no longer a status flip — it cancels jobs and rewrites
    // adaptations — so it needs the same isolation guarantee as approve.
    await b.post(`/api/content/${itemId}/reject`).send({}).expect(404);
    // ...and neither can org B stamp org A's read receipt, which would open
    // org A's publish gate for a draft nobody in org A has seen.
    await b.post(`/api/content/${itemId}/opened`).expect(404);

    // PATCH, at both levels — and the 404 is NOT what pins it. Drop
    // `eq(contentItems.orgId, orgId)` from `requireEditableItem` and every
    // response above is still exactly what it is now: the item write is
    // org-scoped and matches nothing, and the reread at the end of `update` is
    // org-scoped and 404s. What lands underneath is a `content_versions` row
    // against org A's item, stamped with org B's `org_id` and org B's user —
    // a cross-tenant WRITE hidden behind a 404, and a row that would then
    // appear in a history someone restores from. So the rows are the assertion.
    await b.patch(`/api/content/${itemId}`).send({ body: "Not yours." }).expect(404);
    await b
      .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
      .send({ body: "Nor is this." })
      .expect(404);
    expect(await versionRows(itemId)).toEqual([]);

    // ...and org A's item was not touched by any of that.
    const mine = await a.get(`/api/content/${itemId}`).expect(200);
    expect(mine.body.status).toBe("draft");
    expect(mine.body.adaptations[0].status).toBe("pending");
    expect(mine.body.body).toBe("Mine");
    expect(mine.body.adaptations[0].body).toBeNull();
  });

  it("shows an item's OWN adaptations, never another org's row hanging off the same item", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Mine.", channelIds: [channelId] })
      .expect(201);
    const itemId = created.body.id as string;
    const own = created.body.adaptations[0].id as string;

    // `adaptations.org_id` references only the organization, so a row can point
    // at this item while belonging to someone else. Every 404-based tenancy
    // test stops at the ITEM lookup and never reaches the adaptations read, so
    // this row — planted from underneath the API, because no endpoint writes
    // it — is the only thing that observes its org filter at all.
    const planted = await otherOrgAdaptation(itemId, "Their channel's text.");

    for (const path of [`/api/content/${itemId}`, "/api/content"]) {
      const body = (await agent.get(path).expect(200)).body;
      const item = Array.isArray(body)
        ? (body as { id: string }[]).find((row) => row.id === itemId)
        : body;
      const adaptations = (item as { adaptations: { id: string }[] }).adaptations;
      expect(adaptations.map((adaptation) => adaptation.id)).toEqual([own]);
      expect(JSON.stringify(item)).not.toContain(planted);
      // The body matters more than the id: this array is what the editor
      // renders as "your channels", and a stranger's draft rendered there is
      // a text this org can approve and publish.
      expect(JSON.stringify(item)).not.toContain("Their channel's text.");
    }
  });

  it("refuses a create that names another org's channel, and queues nothing against it", async () => {
    const owner = await orgAgent();
    const theirs = await brandWithChannel(owner);

    const stranger = await orgAgent();
    const mine = await brandWithChannel(stranger);

    // The stranger names the OWNER's brand and the OWNER's channel. Nothing but
    // the org predicate in `create`'s channel lookup refuses this: the brand id
    // is never checked against the caller's org directly — the channels ARE the
    // check — and both of the other two predicates (`brand_id`, `id in (…)`)
    // match perfectly, because the ids really do belong together.
    await stranger
      .post("/api/content")
      .send({ brandId: theirs.brandId, body: "Not yours.", channelIds: [theirs.channelId] })
      .expect(404);

    // The same call against the stranger's own brand DOES work, so the 404
    // above is scoping rather than an endpoint that refuses everything.
    const own = await stranger
      .post("/api/content")
      .send({ brandId: mine.brandId, body: "Mine.", channelIds: [mine.channelId] })
      .expect(201);
    expect(own.body.adaptations).toHaveLength(1);

    // And the rows are the real assertion, not the status code. What the org
    // predicate stops is an adaptation pointing at ANOTHER org's channel —
    // a row `approve` would happily enqueue, sending a stranger's text out of
    // this org's Telegram bot.
    expect(await adaptationsForChannel(theirs.channelId)).toEqual([]);
  });

  it("refuses an override edit that files one item's id against another item's adaptation", async () => {
    const agent = await orgAgent();
    const first = await brandWithChannel(agent);
    const second = await brandWithChannel(agent);

    const pinned = await agent
      .post("/api/content")
      .send({
        brandId: first.brandId,
        body: "Reviewed and approved.",
        channelIds: [first.channelId],
      })
      .expect(201);
    await agent.post(`/api/content/${pinned.body.id}/approve`).send({}).expect(200);

    const editable = await agent
      .post("/api/content")
      .send({ brandId: second.brandId, body: "Still a draft.", channelIds: [second.channelId] })
      .expect(201);
    const otherAdaptation = editable.body.adaptations[0].id as string;

    // Same org, both rows the caller's own: the ONLY thing wrong with this
    // request is that the adaptation hangs off a different item. It is refused
    // by the composite in `updateAdaptation`'s locked read, and the status code
    // says which check spoke — 404 (no such adaptation UNDER THIS ITEM), not the
    // 409 the approved item in the path would produce if the adaptation were
    // located first and the item's editability asked afterwards.
    //
    // The same composite is spelled a second time on the UPDATE below it, and
    // that copy is unobservable: `adaptations.id` is the primary key, so no row
    // can satisfy the locked read's `content_item_id` and fail the UPDATE's.
    // Deleting the READ's copy is therefore the mutation that matters, and this
    // is the test that catches it — the UPDATE's copy cannot stand in for it.
    const denied = await agent
      .patch(`/api/content/${pinned.body.id}/adaptations/${otherAdaptation}`)
      .send({ body: "Wrong drawer." })
      .expect(404);
    expect(denied.body.message).toBe("Adaptation not found");

    // Nothing moved: the other item's override is untouched, and no version row
    // was filed against the item named in the path.
    const untouched = await agent.get(`/api/content/${editable.body.id}`).expect(200);
    expect(untouched.body.adaptations[0].body).toBeNull();
    expect(await versionRows(pinned.body.id)).toEqual([]);

    // ...and that adaptation IS editable through its own item, so the 404 above
    // is the composite rather than a row that was pinned anyway.
    await agent
      .patch(`/api/content/${editable.body.id}/adaptations/${otherAdaptation}`)
      .send({ body: "Right drawer." })
      .expect(200);
  });
  /**
   * EVERY REFUSAL A PERSON CAN PROVOKE NAMES ITSELF.
   *
   * Asserted through the HTTP response, not through a repository call, because
   * the code has to survive the whole path a browser's failure takes: a Nest
   * exception filter, JSON serialisation, and the web's own body parser. A test
   * that called `content.approve()` and inspected the thrown exception would
   * pass over a filter that dropped every field but `message`.
   *
   * The English sentence is asserted alongside the code EVERY time, and that is
   * not belt-and-braces: it is the contract. It is what a developer reads in a
   * network tab, what a public-API consumer and the MCP server get, and what a
   * web build older than the code still shows the reader. A change that swapped
   * the sentence for the code would pass a code-only assertion.
   */

  /**
   * THE EDITOR ASKS THE MODEL TO REVISE A SELECTION.
   *
   * The first route in this product a person can make spend money repeatedly,
   * by hand, so these tests are about three things in roughly that order: that
   * the proposal is the SERVER's text and not a caller's, that nothing is spent
   * before every free refusal has been made, and that the hourly allowance is
   * a limit rather than a decoration.
   */
  describe("refine: the editor asks the model to revise a selection", () => {
    /** `AI_BODY` is "Café ouvert. Passez nous voir." — this is its first sentence. */
    const SELECTION = { start: 0, end: 12 };
    const SELECTED_TEXT = "Café ouvert.";

    it("stages the model's own words, and answers with what it actually refined", async () => {
      const { agent, itemId } = await refinableDraft();

      const staged = await agent
        .post(`/api/content/${itemId}/refine`)
        .send({ verb: "shorten", ...SELECTION })
        .expect(201);

      expect(staged.body).toMatchObject({
        verb: "shorten",
        proposal: AI_REPLACEMENT,
        reason: AI_REASON,
        start: SELECTION.start,
        end: SELECTION.end,
        // What the SERVER selected, so a caller whose idea of the body had
        // moved can see that it had.
        selectedText: SELECTED_TEXT,
      });
      expect(typeof staged.body.id).toBe("string");

      // The model saw the body cut at the splice offsets, never overlapping:
      // exactly one copy of the selection, under exactly one label.
      expect(refineCalls).toHaveLength(1);
      expect(refineCalls[0]?.verb).toBe("shorten");
      expect(refineCalls[0]?.input).toEqual({
        selection: SELECTED_TEXT,
        before: "",
        after: AI_BODY.slice(SELECTION.end),
      });
      // The brand's own voice and language reach the step; `instructionsFor`
      // emits that language directive on every call, so a refine that skipped
      // it would answer a French draft in English.
      expect(refineCalls[0]?.brand.contentLanguage).toBe("en");

      const rows = await proposalRows(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: staged.body.id,
        verb: "shorten",
        selectedText: SELECTED_TEXT,
        startOffset: SELECTION.start,
        endOffset: SELECTION.end,
        proposal: AI_REPLACEMENT,
        reason: AI_REASON,
      });
      // The PERSON is recorded on the request, which is why the version row
      // Accept writes can carry `created_by = NULL` and mean it.
      expect(rows[0]?.createdBy).not.toBeNull();
    });

    /**
     * THE PROPOSAL IS THE SERVER'S, FROM THE FIRST STEP.
     *
     * A caller that could supply the selected text could choose what the model
     * is asked about — and the row this call stages is what Accept turns into
     * evidence that a MODEL wrote a sentence. The request schema carries
     * offsets and no text at all, so text sent anyway is stripped, and the
     * anchor stored is the slice of the stored body.
     */
    it("ignores text a caller sends, and anchors on its own body", async () => {
      const { agent, itemId } = await refinableDraft();

      const staged = await agent
        .post(`/api/content/${itemId}/refine`)
        .send({
          verb: "warmer",
          ...SELECTION,
          selectedText: "Words the caller made up.",
          proposal: "Text the caller wants attributed to the model.",
        })
        .expect(201);

      expect(staged.body.selectedText).toBe(SELECTED_TEXT);
      expect(staged.body.proposal).toBe(AI_REPLACEMENT);
      expect(refineCalls[0]?.input.selection).toBe(SELECTED_TEXT);
      expect((await proposalRows(itemId))[0]?.selectedText).toBe(SELECTED_TEXT);
    });

    /**
     * ONE PROPOSAL PER DRAFT. "Try again" is Discard-then-Propose, and a person
     * who simply presses again must not end up with a proposal nobody can see:
     * the later press supersedes the earlier row rather than joining it.
     */
    it("supersedes the proposal already staged rather than adding a second", async () => {
      const { agent, itemId } = await refinableDraft();

      const first = await agent
        .post(`/api/content/${itemId}/refine`)
        .send({ verb: "shorten", ...SELECTION })
        .expect(201);

      refineOutcome = {
        ok: true,
        text: "Encore ouvert.",
        reason: "Plus court.",
        usage: [refineUsage()] as RefineOutcome["usage"],
      };
      const second = await agent
        .post(`/api/content/${itemId}/refine`)
        .send({ verb: "punchier", ...SELECTION })
        .expect(201);

      const rows = await proposalRows(itemId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(second.body.id);
      expect(rows[0]?.proposal).toBe("Encore ouvert.");
      // A NEW id, not the old row edited: the two are different proposals with
      // different text and a different verb, and giving them one identity
      // would let an Accept aimed at the first apply the second.
      expect(second.body.id).not.toBe(first.body.id);
    });

    it("records the spend against the draft, with no run to attribute it to", async () => {
      const { agent, itemId, orgId } = await refinableDraft();

      await agent
        .post(`/api/content/${itemId}/refine`)
        .send({ verb: "shorten", ...SELECTION })
        .expect(201);

      const rows = await ledgerRows(orgId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        step: REFINE_STEP,
        // A refine belongs to no run, so `content_item_id` is the only answer
        // to "what did refining this draft cost".
        runId: null,
        contentItemId: itemId,
        // This increment does not refine a per-channel override.
        adaptationId: null,
      });
    });

    describe("what is refused before a cent is spent", () => {
      it("refuses a draft the model never wrote", async () => {
        const agent = await orgAgent();
        const { brandId, channelId } = await brandWithChannel(agent);
        const { itemId } = await handTypedWithAiAdaptation(agent, brandId, [channelId]);
        await agent
          .put("/api/ai-credentials")
          .send({ provider: "google", apiKey: "sk-live-never-leak-this-0123456789" })
          .expect(200);

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", start: 0, end: 20 })
          .expect(409);

        expect(refused.body.code).toBe("refine_needs_ai_draft");
        expect(refineCalls, "a hand-typed draft must cost nothing").toEqual([]);
        expect(await proposalRows(itemId)).toEqual([]);
      });

      /**
       * An adaptation's own `ai` row says nothing about the body being refined
       * here — the item's text is still the author's. The fixture above has
       * exactly that shape, so this is the assertion that the check reads the
       * MASTER level rather than any `ai` row it can find.
       */
      it("refuses even when a CHANNEL's text was written by the model", async () => {
        const agent = await orgAgent();
        const { brandId, channelId } = await brandWithChannel(agent);
        const { itemId, adaptationIds } = await handTypedWithAiAdaptation(agent, brandId, [
          channelId,
        ]);
        expect(adaptationIds).toHaveLength(1);
        await agent
          .put("/api/ai-credentials")
          .send({ provider: "google", apiKey: "sk-live-never-leak-this-0123456789" })
          .expect(200);

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", start: 0, end: 20 })
          .expect(409);
        expect(refused.body.code).toBe("refine_needs_ai_draft");
        expect(refineCalls).toEqual([]);
      });

      it("refuses a pinned item, and pays nothing to find out", async () => {
        const { agent, itemId } = await refinableDraft();
        await agent.post(`/api/content/${itemId}/opened`).expect(204);
        await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(409);

        expect(refused.body.code).toBe("content_pinned_approved");
        expect(refineCalls, "an approved post must cost nothing").toEqual([]);
      });

      it("refuses an org with no key stored, and says which one it is", async () => {
        const agent = await orgAgent();
        const { brandId, channelId } = await brandWithChannel(agent);
        const { itemId } = await aiDraft(agent, brandId, [channelId]);

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(409);

        expect(refused.body.code).toBe("refine_no_credential");
        expect(refineCalls).toEqual([]);
      });

      /**
       * A range the body cannot hold means the caller is indexing a string this
       * server does not have. The shipped editor cannot produce one — it reports
       * its selection against the exact string it renders — and a request that
       * does is the validation boundary's own kind of fault.
       */
      it("refuses a range that is outside the body", async () => {
        const { agent, itemId } = await refinableDraft();

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", start: 0, end: AI_BODY.length + 1 })
          .expect(400);

        expect(refused.body.code).toBe("invalid_request");
        expect(refineCalls).toEqual([]);
      });

      it("refuses a selection that is only whitespace", async () => {
        const { agent, itemId } = await refinableDraft();
        await setItemBody(itemId, "Café ouvert.\n\nPassez nous voir.");

        // The two newlines between the sentences: a real range, over nothing
        // to revise.
        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", start: 12, end: 14 })
          .expect(400);

        expect(refused.body.code).toBe("invalid_request");
        expect(refineCalls).toEqual([]);
      });

      it("refuses another org's draft as a 404, not a 403", async () => {
        const { itemId } = await refinableDraft();
        const stranger = await orgAgent();
        await stranger
          .put("/api/ai-credentials")
          .send({ provider: "google", apiKey: "sk-live-never-leak-this-0123456789" })
          .expect(200);

        const refused = await stranger
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(404);

        expect(refused.body.code).toBe("content_not_found");
        expect(refineCalls).toEqual([]);
        expect(await proposalRows(itemId)).toEqual([]);
      });
    });

    /**
     * THE HOURLY ALLOWANCE, and the four things that have to be true of it
     * before it is a limit rather than a decoration: it admits the call at one
     * below, it refuses at exactly the limit, it counts CALLS rather than
     * presses, and each of its three predicates — the org, the step, the window
     * — is doing work no other one does.
     */
    describe("the hourly allowance", () => {
      it("admits the call that brings the hour to the limit, and refuses the next", async () => {
        const { agent, itemId, orgId } = await refinableDraft();
        await seedLedger(orgId, MAX_REFINE_CALLS_PER_HOUR - 1);

        await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);
        expect(refineCalls).toHaveLength(1);

        // That press wrote the row that reaches the limit.
        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(409);
        expect(refused.body.code).toBe("refine_limit_reached");
        expect(refineCalls, "the refused press must not reach a provider").toHaveLength(1);
        // And the proposal the first press paid for is untouched.
        expect(await proposalRows(itemId)).toHaveLength(1);
      });

      /**
       * ONE PRESS, TWO ROWS. A schema violation costs a second billed round
       * trip, and the ledger writes one row per PHYSICAL call — so a press that
       * met the repair retry consumes two of the allowance. That is the whole
       * reason the limit counts rows: what is bounded is money, not clicks.
       */
      it("counts calls, not presses", async () => {
        const { agent, itemId, orgId } = await refinableDraft();
        await seedLedger(orgId, MAX_REFINE_CALLS_PER_HOUR - 2);
        refineOutcome = {
          ok: true,
          text: AI_REPLACEMENT,
          reason: AI_REASON,
          usage: [refineUsage(), refineUsage({ attempt: 2 })] as RefineOutcome["usage"],
        };

        await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);
        expect(await ledgerRows(orgId)).toHaveLength(MAX_REFINE_CALLS_PER_HOUR);

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(409);
        expect(refused.body.code).toBe("refine_limit_reached");
      });

      it("is one org's allowance, not the deployment's", async () => {
        const { agent, itemId } = await refinableDraft();
        const { orgId: strangerOrgId } = await strangerOrg();
        await seedLedger(strangerOrgId, MAX_REFINE_CALLS_PER_HOUR);

        await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);
      });

      /**
       * A generation run's calls must not lock the editor, and a Test button's
       * must not either: each allowance names its own step. The mirror of the
       * Test button's own test, from the other side.
       */
      it("counts refines, and not a generation run's spend or a Test press", async () => {
        const { agent, itemId, orgId } = await refinableDraft();
        await seedLedger(orgId, MAX_REFINE_CALLS_PER_HOUR, { step: "writer" });
        await seedLedger(orgId, MAX_REFINE_CALLS_PER_HOUR, { step: "test" });

        await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);
      });

      it("is a ROLLING hour, so yesterday's calls do not spend today's allowance", async () => {
        const { agent, itemId, orgId } = await refinableDraft();
        await seedLedger(orgId, MAX_REFINE_CALLS_PER_HOUR, { ageHours: 2 });

        await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);
      });

      /**
       * The other half of "rolling", and the half a window that is too WIDE
       * cannot fail: a call made half an hour ago is inside the hour and has to
       * count. Without a row in that band the interval can be narrowed from an
       * hour to a couple of minutes with the suite green — and a narrower
       * window is a WEAKER bound, not a stricter one: 120 calls per two minutes
       * is thirty times the ceiling the constant reasons about.
       */
      it("counts a call made inside the hour, not only one made this minute", async () => {
        const { agent, itemId, orgId } = await refinableDraft();
        await seedLedger(orgId, MAX_REFINE_CALLS_PER_HOUR, { ageHours: 0.5 });

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(409);

        expect(refused.body.code).toBe("refine_limit_reached");
        expect(refineCalls, "a refused press must cost nothing").toEqual([]);
      });
    });

    /**
     * WHEN THE CALL DOES NOT PRODUCE A PROPOSAL. Three refusals, and one rule
     * underneath all of them: the money is recorded whatever happened, and
     * whatever was staged before is left alone — a person whose Try again
     * failed still has the proposal they already paid for.
     */
    describe("when the model produces nothing usable", () => {
      it("reports a timeout as a timeout, and still records what it may have cost", async () => {
        const { agent, itemId, orgId } = await refinableDraft();
        refineOutcome = {
          ok: false,
          failure: "timed_out",
          // A call lost after dispatch may have been generated and billed in
          // full while we were hanging up: zero tokens, `outcome: 'unknown'`,
          // which is what puts the "≥" on the org's total.
          usage: [
            refineUsage({ inputTokens: 0, outputTokens: 0, costUsd: null, outcome: "unknown" }),
          ] as RefineOutcome["usage"],
        };

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(409);

        expect(refused.body.code).toBe("refine_timed_out");
        expect(await proposalRows(itemId)).toEqual([]);
        const ledger = await ledgerRows(orgId);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ step: REFINE_STEP, outcome: "unknown" });
      });

      it("reports every other model failure as one refusal, and never the provider's words", async () => {
        const { agent, itemId, orgId } = await refinableDraft();
        refineOutcome = {
          ok: false,
          failure: "failed",
          usage: [refineUsage(), refineUsage({ attempt: 2 })] as RefineOutcome["usage"],
        };

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(409);

        expect(refused.body.code).toBe("refine_failed");
        // The provider's own error text quotes the submitted API key back, so
        // nothing of it may reach a browser.
        expect(JSON.stringify(refused.body)).not.toContain("sk-live");
        // A failed press still cost two round trips, and the allowance counts
        // exactly the calls most worth counting.
        expect(await ledgerRows(orgId)).toHaveLength(2);
      });

      it("leaves the proposal already staged alone when a Try again fails", async () => {
        const { agent, itemId } = await refinableDraft();
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);

        refineOutcome = {
          ok: false,
          failure: "failed",
          usage: [refineUsage()] as RefineOutcome["usage"],
        };
        await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "punchier", ...SELECTION })
          .expect(409);

        const rows = await proposalRows(itemId);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe(staged.body.id);
        expect(rows[0]?.proposal).toBe(AI_REPLACEMENT);
      });

      /**
       * THE DRAFT DELETED WHILE THE MODEL WAS ANSWERING.
       *
       * A refine spends forty-five seconds outside any transaction, and
       * `DELETE /api/brands/:id` cascades into `content_items`, so this
       * interleaving is real rather than exotic. Two things must survive it,
       * and neither does by default: the request must not be a 500 about a
       * foreign key, and the MONEY must still be recorded — the ledger's
       * `content_item_id` is `ON DELETE SET NULL` precisely so a tidy-up
       * cannot erase spend history, and the org's total sums by `org_id`
       * alone.
       */
      it("records the spend even when the draft is deleted mid-call, and refuses without a 500", async () => {
        const { agent, itemId, orgId } = await refinableDraft();
        refineDuringCall = async () => {
          const { createDb, schema } = await import("@pubrick/db");
          const { db, pool } = createDb(url as string);
          await db.delete(schema.contentItems).where(eq(schema.contentItems.id, itemId));
          await pool.end();
        };

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(404);

        expect(refused.body.code).toBe("content_not_found");
        const ledger = await ledgerRows(orgId);
        expect(ledger, "the money was spent and must still be counted").toHaveLength(1);
        expect(ledger[0]).toMatchObject({ step: REFINE_STEP, contentItemId: null });
      });

      /**
       * THE PROPOSE-TIME BOUND ON THE MERGED BODY.
       *
       * The model's schema bounds the REPLACEMENT by `MAX_BODY_LENGTH` and
       * nothing bounds `before + replacement + after` — so a near-full body and
       * a long reply pass every check upstream of this one. Without it the pair
       * would be staged as a proposal a person reads, presses Accept on, and is
       * refused by, after the call was paid for.
       */
      it("refuses a reply that would make the body too long, and stages nothing", async () => {
        const { agent, itemId, orgId } = await refinableDraft();
        const nearlyFull = `Café ouvert. ${"x".repeat(MAX_BODY_LENGTH - 20)}`;
        await setItemBody(itemId, nearlyFull);
        refineOutcome = {
          ok: true,
          text: "Ouvert dès sept heures, et jusqu'à dix-neuf heures tous les jours.",
          reason: AI_REASON,
          usage: [refineUsage()] as RefineOutcome["usage"],
        };

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(409);

        expect(refused.body.code).toBe("refine_too_long");
        expect(await proposalRows(itemId)).toEqual([]);
        // The call happened, so the money is recorded: this refusal is about
        // what the answer would do to the body, not about the answer failing.
        expect(await ledgerRows(orgId)).toHaveLength(1);
      });

      /**
       * THE BOUND'S EDGE, both sides of it.
       *
       * The case above overflows by thousands of characters, which proves the
       * check exists and nothing about where it sits. An off-by-one here stages
       * exactly the proposal it exists to stop — one Accept can only ever
       * refuse, after the call was paid for — or refuses a reply that would
       * have fit.
       *
       * The body is built backwards from the reply so the merge lands on the
       * limit exactly: `before` is empty, so the merged length is the reply's
       * plus everything after the selection.
       */
      it("stages a reply that fills the body to exactly the limit", async () => {
        const { agent, itemId } = await refinableDraft();
        await setItemBody(
          itemId,
          `${SELECTED_TEXT}${"x".repeat(MAX_BODY_LENGTH - AI_REPLACEMENT.length)}`,
        );

        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);

        expect(staged.body.proposal).toBe(AI_REPLACEMENT);
        expect(await proposalRows(itemId)).toHaveLength(1);
      });

      it("refuses the same reply one character past it", async () => {
        const { agent, itemId } = await refinableDraft();
        await setItemBody(
          itemId,
          `${SELECTED_TEXT}${"x".repeat(MAX_BODY_LENGTH - AI_REPLACEMENT.length + 1)}`,
        );

        const refused = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(409);

        expect(refused.body.code).toBe("refine_too_long");
        expect(await proposalRows(itemId)).toEqual([]);
      });

      /**
       * WHAT IS MEASURED AND WHAT IS STORED ARE THE SAME STRING, and it is the
       * one the product's bodies are made of: newlines are U+000A, settled at
       * the DTO for every writer, and a model's reply is a writer.
       *
       * A stored CR makes the lens's overlay lay down more characters than the
       * textarea holds, sliding every highlight after it off the words it
       * describes — `bodyText`'s own docstring has the mechanism. Accept
       * splices this exact string into the body and Task 6's `unit_delta`
       * counts the merge, so a CR here is a CR in the post.
       */
      it("stores the reply with the newlines the product uses, not the ones the model sent", async () => {
        const { agent, itemId } = await refinableDraft();
        refineOutcome = {
          ok: true,
          text: "Ouvert dès sept heures.\r\nEt le dimanche aussi.",
          reason: AI_REASON,
          usage: [refineUsage()] as RefineOutcome["usage"],
        };

        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);

        expect(staged.body.proposal).toBe("Ouvert dès sept heures.\nEt le dimanche aussi.");
        expect((await proposalRows(itemId))[0]?.proposal).toBe(
          "Ouvert dès sept heures.\nEt le dimanche aussi.",
        );
      });
    });

    /**
     * TWO TRANSACTIONS, ONE DRAFT.
     *
     * The staging transaction is short and opens only after the model has
     * answered, but it is not alone on these two rows. A brand delete's cascade
     * destroys `content_items` and then the item's `refine_proposals` child;
     * Task 6's Accept will lock the item `FOR UPDATE` and then read and delete
     * the same proposal row. Both of those take the item FIRST, so the staging
     * transaction has to as well — deleting the proposal row and reaching
     * `content_items` afterwards through the insert's foreign key is the
     * inverse order, and both pairs were reproduced as `40P01` against this
     * database before it took `content_items` up front.
     *
     * A deadlock here is not a wasted round trip: the money is already spent
     * and the ledger row already written by the time this transaction opens,
     * and `40P01` is not `23503`, so it reached the reader as a 500 with no
     * proposal.
     *
     * Each peer below is hand-written on a connection of its own, the way
     * brands.e2e.spec.ts hand-writes the publish worker's two statements: what
     * is under test is the order THIS repository takes its locks in, and the
     * peer only has to hold the other one.
     */
    describe("what a second transaction on the same draft does to it", () => {
      /** The brand a draft hangs off, for the cascade that destroys both. */
      async function brandOf(itemId: string): Promise<string> {
        const { createDb } = await import("@pubrick/db");
        const { db, pool } = createDb(url as string);
        const [row] = (
          await db.execute(`SELECT brand_id FROM content_items WHERE id = '${itemId}'`)
        ).rows as { brand_id: string }[];
        await pool.end();
        return row?.brand_id as string;
      }

      /**
       * Waits until THIS FILE'S app backend is parked on a row lock inside a
       * statement matching one of `patterns` — the interleaving as a fact
       * rather than a hope about promise scheduling.
       *
       * Two patterns, for the same reason brands.e2e.spec.ts passes two: with
       * the order kept the request parks on its locking read of the item, and
       * with it broken there is no such statement, so it gets as far as
       * `insert into "refine_proposals"` and parks there. Matching either is
       * what makes a broken order report the deadlock it causes rather than
       * this poll's own timeout.
       *
       * The first pattern deliberately does not name the lock MODE. What these
       * two cases are about is the ORDER; the mode is the overlapping-press
       * case's business, and a pattern that spelled it would make these two
       * fail for its reason instead of their own.
       *
       * Scoped by `application_name`, never by statement text alone: other e2e
       * files run against this same database and reach `pg_stat_activity` with
       * statements of their own.
       */
      async function waitForLockWaiter(
        patterns: string[],
        inFlight: Promise<unknown> | Promise<unknown>[],
        waiters = 1,
      ): Promise<void> {
        // The operations that are SUPPOSED to be doing the blocking. One that
        // finishes instead produces no waiter, ever, and without this the poll
        // spins until vitest kills the test with its own message.
        //
        // It RAISES rather than returning, and that is the difference between a
        // test and a decoration. Returning quietly hands the caller a green run
        // for an interleaving that never happened — the peer commits against
        // nothing, every assertion about the survivor holds trivially, and the
        // case reports a lock order it never exercised. Both sentences below
        // name which of the two it was.
        let settled = 0;
        const pending = [inFlight].flat();
        for (const operation of pending) {
          void operation.then(
            () => {
              settled++;
            },
            () => {
              settled++;
            },
          );
        }
        const { createDb } = await import("@pubrick/db");
        const { db, pool } = createDb(url as string);
        const matches = patterns.map((pattern) => `query ILIKE '${pattern}'`).join(" OR ");
        try {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const { rows } = await db.execute(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database()
                  AND application_name = '${APP_NAME}'
                  AND wait_event_type = 'Lock'
                  AND (${matches})`,
            );
            if ((rows[0] as { n: number }).n >= waiters) return;
            if (settled === pending.length) {
              throw new Error(
                `every operation that should have blocked on ${patterns.join(" / ")} ` +
                  `finished without blocking: the interleaving under test did not happen`,
              );
            }
            if (Date.now() > deadline) {
              throw new Error(
                `fewer than ${waiters} backend(s) blocked on ${patterns.join(" / ")}`,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        } finally {
          await pool.end();
        }
      }

      /** Where a staging refine can be parked: on the item, or on its own insert. */
      const STAGING_WAITS_ON = ["%content_items%for %", '%insert into "refine_proposals"%'];

      /**
       * ACCEPT'S OWN TWO STATEMENTS, HELD OPEN.
       *
       * `ContentRepository.acceptRefine` takes `content_items FOR UPDATE`
       * through `requireEditableItem` and then reads and deletes the proposal
       * row under it. That is the exact inverse of the order the staging
       * transaction used to take, and the pair deadlocks: whichever side loses,
       * a person loses either the refine they paid for or the Accept they
       * pressed.
       *
       * The peer is hand-written even though the route now exists, and the
       * reason is not the one N1 killed: what this case needs is a transaction
       * PAUSED between those two statements, and a real request cannot be
       * paused there. The peer's own lock mode is not what any assertion rests
       * on here — it only has to hold the item — which is precisely the
       * difference from the overlapping-press case below, where the mode WAS
       * the question and a hand-written peer answered it wrongly. The two real
       * requests meeting each other are the case after this one.
       */
      it("does not deadlock against an Accept holding the item and reaching for the proposal", async () => {
        const { agent, itemId } = await refinableDraft();
        // A committed proposal, so the supersede DELETE below has a row to lock
        // rather than a gap.
        await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);

        // THE LEDGER ROW IS NOT PART OF THIS INTERLEAVING, and leaving it in
        // would hide the one that is. `recordRefineUsage` writes it in a
        // transaction of its own, a moment earlier, and its foreign key takes
        // `content_items FOR KEY SHARE` too — so with a peer already holding
        // the item, the request parks THERE, on a transaction holding nothing,
        // and the peer is through before the staging transaction opens. The
        // deadlock lives in the window after that insert has committed: an
        // empty `usage` is how a test reaches it, and `recordRefineUsage`
        // returns on it without writing.
        refineOutcome = { ...refineOutcome, usage: [] as RefineOutcome["usage"] };

        const { createDb } = await import("@pubrick/db");
        const { pool } = createDb(url as string);
        const accept = await pool.connect();
        let acceptError: string | null = null;
        let status = 0;
        try {
          await accept.query("BEGIN");
          await accept.query("SELECT id FROM content_items WHERE id = $1 FOR UPDATE", [itemId]);

          const pressing = agent
            .post(`/api/content/${itemId}/refine`)
            .send({ verb: "punchier", ...SELECTION })
            .then((res) => res.status);
          await waitForLockWaiter(STAGING_WAITS_ON, pressing);

          acceptError = await accept
            // The route's own two statements on this row, in its order: read it
            // under the item lock, then consume it.
            .query("SELECT id FROM refine_proposals WHERE content_item_id = $1", [itemId])
            .then(() =>
              accept.query("DELETE FROM refine_proposals WHERE content_item_id = $1", [itemId]),
            )
            .then(
              () => null,
              (error: { code?: string }) => String(error.code),
            );
          await accept.query("COMMIT");
          status = await pressing;
        } finally {
          await accept.query("ROLLBACK").catch(() => {});
          accept.release();
          await pool.end();
        }

        expect(acceptError, "the Accept was the deadlock victim (40P01)").toBeNull();
        expect(status, "the staging refine was the deadlock victim (40P01 -> 500)").toBe(201);
        // ...and the press that waited still staged what it had paid for.
        expect(await proposalRows(itemId)).toHaveLength(1);
      }, 20_000);

      /**
       * THE BRAND DELETE'S CASCADE — the same order arriving from the other
       * end: `DELETE FROM brands` reaches `content_items` and, through
       * `refine_proposals.content_item_id`, the proposal row of every draft it
       * destroys.
       *
       * The item's own lock is taken as a separate statement first, so the
       * interleaving is a fact rather than a race inside one cascading
       * statement; it is the same lock the cascade's `DELETE FROM ONLY
       * content_items` takes on that row a moment later.
       *
       * What the request owes the reader once the draft really is gone is
       * unchanged, and asserted here rather than assumed: 404
       * `content_not_found`, with the spend still recorded against a null
       * `content_item_id`.
       */
      it("does not deadlock against a brand delete cascading into the same two rows", async () => {
        const { agent, itemId } = await refinableDraft();
        await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);
        const brandId = await brandOf(itemId);
        // THE LEDGER ROW IS NOT PART OF THIS INTERLEAVING, and leaving it in
        // would hide the one that is. `recordRefineUsage` writes it in a
        // transaction of its own, a moment earlier, and its foreign key takes
        // `content_items FOR KEY SHARE` too — so with a peer already holding
        // the item, the request parks THERE, on a transaction holding nothing,
        // and the peer is through before the staging transaction opens. The
        // deadlock lives in the window after that insert has committed: an
        // empty `usage` is how a test reaches it, and `recordRefineUsage`
        // returns on it without writing.
        refineOutcome = { ...refineOutcome, usage: [] as RefineOutcome["usage"] };

        const { createDb } = await import("@pubrick/db");
        const { pool } = createDb(url as string);
        const cascade = await pool.connect();
        let cascadeError: string | null = null;
        let refusal: { status: number; code?: string } = { status: 0 };
        try {
          await cascade.query("BEGIN");
          await cascade.query("SELECT id FROM content_items WHERE id = $1 FOR UPDATE", [itemId]);

          const pressing = agent
            .post(`/api/content/${itemId}/refine`)
            .send({ verb: "punchier", ...SELECTION })
            .then((res) => ({ status: res.status, code: res.body.code as string | undefined }));
          await waitForLockWaiter(STAGING_WAITS_ON, pressing);

          cascadeError = await cascade.query("DELETE FROM brands WHERE id = $1", [brandId]).then(
            () => null,
            (error: { code?: string }) => String(error.code),
          );
          await cascade.query("COMMIT");
          refusal = await pressing;
        } finally {
          await cascade.query("ROLLBACK").catch(() => {});
          cascade.release();
          await pool.end();
        }

        expect(cascadeError, "DELETE /api/brands/:id was the deadlock victim (40P01)").toBeNull();
        // Not a 500 about a foreign key, and not a 500 about a deadlock: the
        // draft this refine was about is gone, which is a sentence a reader can
        // act on.
        expect(refusal.status, "the staging refine was the deadlock victim (40P01 -> 500)").toBe(
          404,
        );
        expect(refusal.code).toBe("content_not_found");
      }, 20_000);

      /**
       * TWO PRESSES THAT GENUINELY OVERLAP — BOTH OF THEM REAL REQUESTS.
       *
       * The unique index makes two rows impossible; it does not make the second
       * transaction recover. Two presses that hold a lock the other can hold
       * too both delete nothing — neither can see the other's uncommitted row —
       * the second blocks on the index, and when the first commits it is
       * answered `23505`, which is not `23503`, so it reaches the reader as a
       * 500 for a call they had already paid for. `FOR NO KEY UPDATE` is the
       * weakest mode two holders cannot share, and that is the whole of what is
       * under test here.
       *
       * IT USED TO BE HALF A TEST, and the half it was missing is the half that
       * matters. The other press was hand-written on a connection of its own,
       * ending `FOR NO KEY UPDATE` — so the mode being asserted was the PEER's,
       * not the repository's. Weakening `insertProposal`'s own lock to
       * `for("share")` survived that shape three runs out of three: a share
       * lock still conflicts with the peer's `FOR NO KEY UPDATE`, so the press
       * still queued and still answered 201, while two real presses at
       * `FOR SHARE` would both have been granted at once and one of them lost
       * to `23505`. A test that pins the counterparty pins nothing.
       *
       * So both presses are `POST /api/content/:id/refine`, and the only
       * hand-written statement is a STARTING GATE: a third connection holds the
       * item `FOR UPDATE` (which conflicts with every mode either press could
       * take) until both are parked on it. Releasing it wakes them together —
       * Postgres grants the whole compatible head of the queue — so under a
       * shared mode the overlap is a fact rather than a scheduling hope, and
       * under the real one they serialise.
       */
      it("serialises two presses that overlap, rather than losing one to a duplicate key", async () => {
        const { agent, itemId } = await refinableDraft();
        // THE LEDGER ROW IS NOT PART OF THIS INTERLEAVING. Its insert takes
        // `content_items FOR KEY SHARE` through its foreign key, so with the
        // gate holding the item both presses would park THERE — on a statement
        // neither pattern names, in a transaction holding nothing — and never
        // reach the staging lock this case is about.
        refineOutcome = { ...refineOutcome, usage: [] as RefineOutcome["usage"] };

        const { createDb } = await import("@pubrick/db");
        const { pool } = createDb(url as string);
        const gate = await pool.connect();
        type Press = { status: number; id?: string; verb?: string };
        let presses: Press[] = [];
        try {
          await gate.query("BEGIN");
          await gate.query("SELECT id FROM content_items WHERE id = $1 FOR UPDATE", [itemId]);

          const press = (verb: string): Promise<Press> =>
            agent
              .post(`/api/content/${itemId}/refine`)
              .send({ verb, ...SELECTION })
              .then((res) => ({
                status: res.status,
                id: res.body.id as string | undefined,
                verb: res.body.verb as string | undefined,
              }));
          const pressing = [press("shorten"), press("punchier")];
          // BOTH of them, not either: one waiter would let the case run with
          // the second press still on its way to the lock, which is the shape
          // that cannot see a mode two holders can share.
          await waitForLockWaiter(STAGING_WAITS_ON, pressing, 2);
          await gate.query("COMMIT");
          presses = await Promise.all(pressing);
        } finally {
          await gate.query("ROLLBACK").catch(() => {});
          gate.release();
          await pool.end();
        }

        expect(
          presses.map((press) => press.status),
          "a press was answered a duplicate key as a 500",
        ).toEqual([201, 201]);
        const rows = await proposalRows(itemId);
        expect(rows).toHaveLength(1);
        // Which press won is the lock queue's business and is not asserted. What
        // is asserted is that the survivor is ONE WHOLE proposal — the id and
        // the verb of a single press's own 201 — rather than one press's row
        // wearing another's identity.
        const winner = presses.find((press) => press.id === rows[0]?.id);
        expect(winner, "the staged row belongs to neither press's response").toBeDefined();
        expect(rows[0]?.verb).toBe(winner?.verb);
        expect(rows[0]?.proposal).toBe(AI_REPLACEMENT);
      }, 20_000);

      /**
       * A REAL ACCEPT AND A REAL PRESS, RELEASED TOGETHER.
       *
       * The case above pauses a hand-written Accept where a request cannot be
       * paused; this one gives up that control to gain the thing it cannot
       * have — both sides running the shipped code, taking the locks the
       * repository really takes, in whichever order the queue grants them.
       * What it can still assert is the whole of what the lock order buys:
       * neither side is a `40P01` (which reaches a reader as a 500, having
       * already spent their money), and the two possible outcomes are the two
       * stories a person could be told, with no third.
       *
       * Either the Accept got the item first — it applied the suggestion it
       * named, and the press then staged a new one against the merged body — or
       * the press got there first, superseded the row, and the Accept could
       * only be a 404 for a suggestion that no longer exists. One proposal row
       * either way, because that is what the unique index and the supersede
       * mean.
       */
      it("serialises a real Accept against a real press, whichever wins", async () => {
        const { agent, itemId } = await refinableDraft();
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);
        // The ledger insert would park both requests on a statement neither
        // pattern names; see the cases above.
        refineOutcome = { ...refineOutcome, usage: [] as RefineOutcome["usage"] };

        const { createDb } = await import("@pubrick/db");
        const { pool } = createDb(url as string);
        const gate = await pool.connect();
        let press = 0;
        let accept: { status: number; code?: string } = { status: 0 };
        try {
          await gate.query("BEGIN");
          await gate.query("SELECT id FROM content_items WHERE id = $1 FOR UPDATE", [itemId]);

          const pressing = agent
            .post(`/api/content/${itemId}/refine`)
            .send({ verb: "punchier", ...SELECTION })
            .then((res) => res.status);
          const accepting = agent
            .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
            .then((res) => ({ status: res.status, code: res.body.code as string | undefined }));
          await waitForLockWaiter(STAGING_WAITS_ON, [pressing, accepting], 2);
          await gate.query("COMMIT");
          [press, accept] = await Promise.all([pressing, accepting]);
        } finally {
          await gate.query("ROLLBACK").catch(() => {});
          gate.release();
          await pool.end();
        }

        expect(press, "the press was the deadlock victim (40P01 -> 500)").toBe(201);
        expect([200, 404], "the Accept was the deadlock victim (40P01 -> 500)").toContain(
          accept.status,
        );
        if (accept.status === 404) expect(accept.code).toBe("refine_proposal_not_found");
        // The fragment row exists exactly when the Accept applied something.
        expect(await masterVersionRows(itemId)).toHaveLength(accept.status === 200 ? 2 : 1);
        // And the press's own proposal is staged either way.
        expect(await proposalRows(itemId)).toHaveLength(1);
      }, 20_000);

      /**
       * THE DELETE AND THE INSERT ARE ONE TRANSACTION, and this is the
       * assertion that can tell.
       *
       * The supersede destroys a proposal a person paid for and is looking at.
       * If the insert that replaces it fails, the delete has to go with it —
       * otherwise a request that stages nothing has still thrown away the card
       * on the screen, which is worse than the refusal it answers.
       *
       * The failure injected is a NUL byte in the model's `reason`: a character
       * a JSON string may carry and no `text` column can. In PRODUCTION it
       * never gets this far — `refineOutputSchema` refuses it, so the model
       * meets the repair retry and a second bad reply is `refine_failed` — and
       * that is why it can be injected here at all: this file replaces
       * `RefineCaller` whole, which is the seam BELOW the schema. Any failed
       * insert would prove the same thing; this one is simply the failure a
       * test can reach.
       */
      it("keeps the staged proposal when the row that would replace it cannot be written", async () => {
        const { agent, itemId } = await refinableDraft();
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);

        refineOutcome = {
          ok: true,
          text: "Encore ouvert.",
          reason: "Plus court.\u0000",
          usage: [refineUsage()] as RefineOutcome["usage"],
        };
        await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "punchier", ...SELECTION })
          .expect(500);

        const rows = await proposalRows(itemId);
        expect(rows, "the supersede deleted a paid-for proposal it could not replace").toHaveLength(
          1,
        );
        expect(rows[0]?.id).toBe(staged.body.id);
        expect(rows[0]?.proposal).toBe(AI_REPLACEMENT);
      });
    });

    /**
     * Rewrites the draft AND the `ai` `full` row that is the evidence for it,
     * together — a draft the model wrote with different words, rather than a
     * draft somebody edited.
     *
     * Both, never one: `setItemBody` alone leaves the body saying one thing and
     * the model's own version row another, which is a HUMAN EDIT as far as
     * every provenance read is concerned. A test that wanted "the model wrote
     * these three sentences" and moved only the body would be testing the
     * laundering refusal by accident.
     */
    async function setAiDraft(itemId: string, body: string): Promise<void> {
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db.update(schema.contentItems).set({ body }).where(eq(schema.contentItems.id, itemId));
      await db
        .update(schema.contentVersions)
        .set({ body })
        .where(
          and(
            eq(schema.contentVersions.contentItemId, itemId),
            isNull(schema.contentVersions.adaptationId),
            eq(schema.contentVersions.origin, "ai"),
            eq(schema.contentVersions.scope, "full"),
          ),
        );
      await pool.end();
    }

    /**
     * The version rows of the MASTER body — the level a refine acts on.
     *
     * `aiDraft` writes one `ai` row per channel too, and they are evidence
     * about the ADAPTATIONS' text: counting them here would let a fragment
     * filed against the wrong level pass for the right one.
     */
    async function masterVersionRows(itemId: string) {
      return (await versionRows(itemId)).filter((row) => row.adaptationId === null);
    }

    /**
     * A proposal row carrying a STRANGER's `org_id` while pointing at this
     * draft. Returns its id.
     *
     * Written straight to the table: no endpoint will produce one, and it is
     * the only shape the `org_id` predicate on Accept and Discard can be seen
     * to refuse.
     */
    async function otherOrgProposalRow(itemId: string): Promise<string> {
      const { orgId } = await strangerOrg();
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const rows = await db
        .insert(schema.refineProposals)
        .values({
          orgId,
          contentItemId: itemId,
          verb: "shorten",
          selectedText: SELECTED_TEXT,
          startOffset: SELECTION.start,
          endOffset: SELECTION.end,
          proposal: AI_REPLACEMENT,
          reason: AI_REASON,
        })
        .returning({ id: schema.refineProposals.id });
      await pool.end();
      return rows[0]?.id as string;
    }

    /** A refinable draft with one proposal staged against `range`. */
    async function withProposal(range: { start: number; end: number } = SELECTION) {
      const draft = await refinableDraft();
      const staged = await draft.agent
        .post(`/api/content/${draft.itemId}/refine`)
        .send({ verb: "shorten", ...range })
        .expect(201);
      return { ...draft, proposalId: staged.body.id as string, staged: staged.body };
    }

    describe("accepting what was proposed", () => {
      /**
       * THE WHOLE INCREMENT IN ONE CASE, now through the real routes.
       *
       * Two of the model's sentences come back as one — the ordinary outcome of
       * pressing Shorten once. Counted against the model's original draft alone
       * that is a body a sentence shorter than the model wrote, which reads as a
       * human deletion: the badge captions the model's own words "Human-edited"
       * and the publish gate opens on a draft nobody has read. The `unit_delta`
       * this Accept writes is what makes the count come out right, and it is
       * written HERE, once, rather than re-derived from the fragment's text on
       * every read.
       */
      it("records a shortened draft as still the model's, and the gate still holds", async () => {
        const { agent, itemId } = await refinableDraft();
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", start: 0, end: AI_BODY.length })
          .expect(201);

        const accepted = await agent
          .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
          .expect(200);

        expect(accepted.body.body).toBe(AI_REPLACEMENT);
        // The badge. Whole-body equality could never say this: a fragment never
        // EQUALS a body, so an accepted proposal used to read "Human-edited".
        expect(accepted.body.bodyIsAiVerbatim).toBe(true);
        // Consumed: the card the person accepted is gone from the response that
        // replaced it, so a screen redrawing from this cannot offer it twice.
        expect(accepted.body.refineProposal).toBeNull();

        const rows = await masterVersionRows(itemId);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toEqual({
          adaptationId: null,
          // The MERGED body's own units, not the model's reply as it arrived:
          // an unterminated proposal fuses with its neighbour, and a row holding
          // the reply would leave the fused unit attributable to nobody.
          body: AI_REPLACEMENT,
          title: null,
          origin: "ai",
          scope: "fragment",
          unitDelta: -1,
          // The MODEL wrote this text. The person who asked for it is recorded
          // on the proposal row, which is where a request belongs.
          createdBy: null,
        });
        expect(await proposalRows(itemId)).toEqual([]);

        // ...and the promise the whole increment is built around still holds:
        // nobody has read this draft, so it cannot be published.
        const refused = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
        expect(refused.body.code).toBe("unread_ai_draft");
      });

      /**
       * THE OTHER DIRECTION OF DISHONESTY, refused. `Note: ` is the author's
       * own; the merged sentence would swallow it, and the fragment row would
       * then say a model wrote it — the lens stops dimming it, the badge reads
       * "AI-drafted" over a person's words.
       *
       * The proposal SURVIVES the refusal. They paid for it, and re-selecting
       * the whole sentence is one act away.
       */
      it("refuses to file a person's own words as the model's, and keeps the proposal", async () => {
        const { agent, itemId } = await refinableDraft();
        const body = "Café ouvert. Note: passez demain.";
        await setItemBody(itemId, body);
        const start = body.indexOf("passez demain.");
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "warmer", start, end: body.length })
          .expect(201);

        const refused = await agent
          .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
          .expect(409);

        expect(refused.body.code).toBe("refine_would_launder");
        const item = await agent.get(`/api/content/${itemId}`).expect(200);
        expect(item.body.body).toBe(body);
        // Not "no fragment row": no row at all, and no half-applied body. One
        // transaction, and a refusal rolls the whole of it back.
        expect(await masterVersionRows(itemId)).toHaveLength(1);
        expect(await proposalRows(itemId)).toHaveLength(1);
        expect(item.body.refineProposal.id).toBe(staged.body.id);
      });

      /**
       * THE SAME REFUSAL, WITH THE PERSON'S SENTENCE SAVED THE WAY A PERSON
       * SAVES ONE — through `PATCH`, which files an `origin = 'human'` version
       * row of the whole body.
       *
       * The case above plants the text with a raw `UPDATE`, so the level holds
       * no row at all besides the model's own. That is the shape in which every
       * wrong choice coincides with the right one: drop `origin = 'ai'` from the
       * evidence read and nothing changes, because there is nothing else to
       * read. Here there is — the author's own save — and reading it as evidence
       * would file `Note: ` as the model's, justified by the row in which the
       * PERSON wrote it. Measured: without that predicate this Accept answers
       * 200 and stores a fragment holding the author's own prefix.
       */
      it("refuses to launder a sentence the author saved through the API", async () => {
        const { agent, itemId } = await refinableDraft();
        const body = "Café ouvert. Note: passez demain.";
        await agent.patch(`/api/content/${itemId}`).send({ body }).expect(200);
        const start = body.indexOf("passez demain.");
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "warmer", start, end: body.length })
          .expect(201);

        const refused = await agent
          .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
          .expect(409);

        expect(refused.body.code).toBe("refine_would_launder");
        const item = await agent.get(`/api/content/${itemId}`).expect(200);
        expect(item.body.body).toBe(body);
        // The model's draft and the person's save, and nothing else: no
        // fragment row, so nothing claims a model wrote a word of that line.
        const rows = await masterVersionRows(itemId);
        expect(rows.map((row) => row.origin)).toEqual(["ai", "human"]);
        expect(await proposalRows(itemId)).toHaveLength(1);
      });

      /**
       * ...AND AN `ai` ROW AT THE ADAPTATION LEVEL IS EVIDENCE ABOUT THE
       * CHANNEL'S OWN TEXT, never about the master body being spliced here.
       *
       * A per-channel adaptation is a rewrite of this draft, so the model's
       * adapted text ordinarily repeats the master body's sentences — including
       * the one the PERSON wrote. Read at this level it would vouch for a line
       * no model wrote into the body being edited. Measured: without
       * `adaptation_id IS NULL` this Accept answers 200 and files the author's
       * words as the model's, justified by evidence about an override.
       */
      it("refuses to launder a sentence only an adaptation's ai row vouches for", async () => {
        const { agent, itemId, adaptationIds } = await refinableDraft();
        const body = "Café ouvert. Note: passez demain.";
        await setItemBody(itemId, body);
        await addAdaptationVersion(itemId, adaptationIds[0] as string, body);
        const start = body.indexOf("passez demain.");
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "warmer", start, end: body.length })
          .expect(201);

        const refused = await agent
          .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
          .expect(409);

        expect(refused.body.code).toBe("refine_would_launder");
        const item = await agent.get(`/api/content/${itemId}`).expect(200);
        expect(item.body.body).toBe(body);
        expect(await masterVersionRows(itemId)).toHaveLength(1);
        expect(await proposalRows(itemId)).toHaveLength(1);
      });

      /**
       * A BODY THE DTO NEVER NORMALISED — the model's own, carrying CRLF —
       * SELECTED THE WAY THE SHIPPED EDITOR SELECTS IT.
       *
       * The worker's terminal write stores the model's reply, so a stored body
       * whose newlines are not U+000A is a real row rather than a hypothesis
       * (the output schemas normalise it at the source now; this is the row
       * that arrived by another road). The offsets are the ONLY ones a browser
       * can produce: `DimmedTextarea` renders `normalizeNewlines(value)` and a
       * `<textarea>` strips CR from its value regardless, so the client counts
       * characters in the CANONICAL string — `crBody.indexOf(selected)` is a
       * server coordinate no client has ever sent, which is exactly why the
       * first version of this test could not see the defect it was written for.
       *
       * Two things are asserted because two things break. The proposal echoes
       * back the text the reader actually highlighted — sliced raw, it comes
       * back as `"\r\nOn vous attend dès sept heure"`, a selection nobody made,
       * paid for at the provider. And Accept, which normalises before it
       * re-locates the anchor, then cannot find that string at all: `409
       * refine_anchor_lost` on a call the org has already been billed for.
       */
      it("slices the selection the client measured, so a CR draft refines the chosen words", async () => {
        const { agent, itemId } = await refinableDraft();
        const crBody = "Café ouvert.\r\nPassez nous voir.\r\nOn vous attend dès sept heures.";
        await setAiDraft(itemId, crBody);
        const selected = "On vous attend dès sept heures.";
        // The client's coordinates: measured over the body as the field holds it.
        const rendered = crBody.replaceAll("\r\n", "\n");
        const start = rendered.indexOf(selected);
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", start, end: start + selected.length })
          .expect(201);

        expect(staged.body.selectedText).toBe(selected);
        expect(refineCalls.at(-1)?.input).toEqual({
          selection: selected,
          before: "Café ouvert.\nPassez nous voir.\n",
          after: "",
        });

        const accepted = await agent
          .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
          .expect(200);

        expect(accepted.body.body).toBe(`Café ouvert.\nPassez nous voir.\n${AI_REPLACEMENT}`);
        const rows = await masterVersionRows(itemId);
        expect(rows).toHaveLength(2);
        expect(rows[1]?.body).toBe(AI_REPLACEMENT);
        expect(rows[1]?.unitDelta).toBe(0);
      });

      /**
       * THE LENGTH BOUND, RE-CHECKED AT ACCEPT — the one arm of the plan's
       * refusals that propose time cannot cover.
       *
       * Propose refuses a reply that would overflow the body it measured. The
       * body then grows underneath the staged card, which is the ordinary thing
       * to happen while somebody reads a suggestion, and the same merge no
       * longer fits. The refusal is a 409 the person can act on — shorten the
       * post — and it keeps the proposal, because the call was paid for and
       * accepting it is one edit away.
       */
      it("refuses at accept when the body grew past the limit under the staged card", async () => {
        const { agent, itemId, proposalId } = await withProposal();
        const padding = "y".repeat(MAX_BODY_LENGTH - AI_BODY.length - 6);
        const grown = `${AI_BODY}\n${padding}.`;
        await agent.patch(`/api/content/${itemId}`).send({ body: grown }).expect(200);

        const refused = await agent
          .post(`/api/content/${itemId}/refine/${proposalId}/accept`)
          .expect(409);

        expect(refused.body.code).toBe("refine_too_long");
        const item = await agent.get(`/api/content/${itemId}`).expect(200);
        expect(item.body.body).toBe(grown);
        // The model's own row and the save that grew the body — no fragment.
        expect(await masterVersionRows(itemId)).toHaveLength(2);
        expect(await proposalRows(itemId)).toHaveLength(1);
      });

      /**
       * A PINNED POST ANSWERS THE PINNED 409 EVEN WHEN THE PROPOSAL IS GONE,
       * and that is a decision about what a person is told rather than a
       * consequence of the lock order — `lockedProposal` takes no lock, so the
       * two statements could be swapped without moving anything the database
       * cares about.
       *
       * The pinned sentence is the one that governs everything they can do with
       * this post and names the act that changes it, and it is the SAME
       * sentence they get when the card is still staged. A 404 here would tell
       * two different stories about one pinned post depending on which of two
       * requests won.
       */
      it("answers a pinned post's refusal, not the missing proposal's, when both are true", async () => {
        const { agent, itemId, proposalId } = await withProposal();
        await agent.delete(`/api/content/${itemId}/refine/${proposalId}`).expect(204);
        await agent.post(`/api/content/${itemId}/opened`).expect(204);
        await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

        const refused = await agent
          .post(`/api/content/${itemId}/refine/${proposalId}/accept`)
          .expect(409);

        expect(refused.body.code).toBe("content_pinned_approved");
        expect(await masterVersionRows(itemId)).toHaveLength(1);
      });

      /**
       * TWO COPIES, EQUALLY FAR FROM WHERE THE SELECTION SAT — and the earlier
       * one wins. Nothing about the draft can break the tie, so the rule is a
       * total order chosen once rather than one that depends on which way the
       * scan happened to run: the same body must give the same splice on every
       * machine and after every refactor of the loop.
       */
      it("splices the earlier copy when two are equally far from the stored offset", async () => {
        const { agent, itemId } = await refinableDraft();
        const selected = "Passez nous voir.";
        const stored = AI_BODY.indexOf(selected);
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", start: stored, end: stored + selected.length })
          .expect(201);
        // Rewritten so the two copies sit ten characters either side of the
        // offset the proposal stored, model-written like the rest so nothing
        // here turns on attribution.
        const tied = `Un ${selected} - ${selected}`;
        expect(tied.indexOf(selected) + tied.lastIndexOf(selected)).toBe(stored * 2);
        await setAiDraft(itemId, tied);

        const accepted = await agent
          .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
          .expect(200);

        expect(accepted.body.body).toBe(`Un ${AI_REPLACEMENT} - ${selected}`);
      });

      /**
       * THE GATE SCENARIO A WHOLE-BRANCH REVIEW DROVE THROUGH THESE ROUTES: a
       * person deletes one of the model's sentences, and a later refine hands
       * it back.
       *
       * The merged body is BYTE-IDENTICAL to the draft the model wrote. The
       * running expectation cannot see that on its own — a human deletion is
       * permanent in the sum of the deltas, so the restoring fragment's `+1`
       * pushes the count owed up rather than back — and the count alone would
       * caption three sentences the model wrote "Human-edited" and let the post
       * be approved without anybody reading it. `allSentencesAi` answers on the
       * anchor's own text first, and this is that clause through the real
       * routes: the badge tells the truth and the gate holds.
       */
      it("reads a draft a refine restored to the model's own words as the model's", async () => {
        const { agent, itemId } = await refinableDraft();
        await setAiDraft(itemId, AI_LONG_BODY);
        const deleted = "Café ouvert. On vous attend dès sept heures.";
        await agent.patch(`/api/content/${itemId}`).send({ body: deleted }).expect(200);
        // A human really did delete a sentence, and the badge says so — this is
        // the state the restore has to move, and asserting it is what stops the
        // case below from passing for the wrong reason.
        const edited = await agent.get(`/api/content/${itemId}`).expect(200);
        expect(edited.body.bodyIsAiVerbatim).toBe(false);

        const selected = "On vous attend dès sept heures.";
        const start = deleted.indexOf(selected);
        refineOutcome = {
          ok: true,
          text: `Passez nous voir. ${selected}`,
          reason: AI_REASON,
          usage: [refineUsage()] as RefineOutcome["usage"],
        };
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "warmer", start, end: start + selected.length })
          .expect(201);

        const accepted = await agent
          .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
          .expect(200);

        expect(accepted.body.body).toBe(AI_LONG_BODY);
        expect(accepted.body.bodyIsAiVerbatim).toBe(true);
        // ...and the publish promise with it: this text is the model's, so it
        // takes a person opening the draft, not a count that happens to differ.
        const refused = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
        expect(refused.body.code).toBe("unread_ai_draft");
      });

      /**
       * A *shorten* on short copy routinely hands back the selection unchanged.
       * There is no new version of anything, so nothing is written —
       * `humanVersionBody`'s own rule for a save that changed no text, one
       * origin over.
       */
      it("writes nothing for a proposal that reproduces the selection", async () => {
        const { agent, itemId } = await refinableDraft();
        refineOutcome = {
          ok: true,
          text: SELECTED_TEXT,
          reason: AI_REASON,
          usage: [refineUsage()] as RefineOutcome["usage"],
        };
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);

        const accepted = await agent
          .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
          .expect(200);

        expect(accepted.body.body).toBe(AI_BODY);
        expect(await masterVersionRows(itemId)).toHaveLength(1);
        // Consumed all the same: the person accepted it, and a card that stayed
        // on the screen would invite them to accept it again.
        expect(await proposalRows(itemId)).toEqual([]);
      });

      /**
       * THE ANCHOR IS RE-LOCATED, NOT TRUSTED — and it is the occurrence
       * NEAREST the offset the proposal stored, not the first one in the body.
       * A repeated hook line is ordinary social copy; splicing into the first
       * copy would rewrite a sentence the person never selected, three
       * paragraphs from the one they did.
       */
      it("re-locates the selection nearest where it was, not at the first copy of it", async () => {
        const { agent, itemId } = await refinableDraft();
        const body = `${AI_BODY} ${SELECTED_TEXT}`;
        await setAiDraft(itemId, body);
        const start = body.lastIndexOf(SELECTED_TEXT);
        const staged = await agent
          .post(`/api/content/${itemId}/refine`)
          .send({ verb: "shorten", start, end: start + SELECTED_TEXT.length })
          .expect(201);

        const accepted = await agent
          .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
          .expect(200);

        expect(accepted.body.body).toBe(`${AI_BODY} ${AI_REPLACEMENT}`);
      });

      /**
       * THE STORED OFFSETS ARE NOT WHERE THE TEXT IS. They record where the
       * selection SAT when the model was asked, and a person adding a line
       * above it while they read the proposal — the commonest interaction
       * there is — moves every offset after it. Splicing at the stored one
       * would replace whatever now happens to occupy those characters, which
       * here is the middle of the sentence they just typed.
       *
       * The offsets are still stored, and still used: they are what "nearest"
       * is measured from.
       */
      it("splices where the selection is now, not where it was when the model was asked", async () => {
        const { agent, itemId, proposalId } = await withProposal();
        // The same draft with a line added in front of it, model-written like
        // the rest so nothing here turns on attribution.
        const moved = `Bonjour à tous. ${AI_BODY}`;
        await setAiDraft(itemId, moved);

        const accepted = await agent
          .post(`/api/content/${itemId}/refine/${proposalId}/accept`)
          .expect(200);

        expect(accepted.body.body).toBe(
          `Bonjour à tous. ${AI_REPLACEMENT} ${AI_BODY.slice(SELECTION.end + 1)}`,
        );
      });

      /**
       * ...and refused only when there is NO occurrence left. Not a hash of the
       * whole body: an edit three paragraphs away leaves the selection exactly
       * where it was, and refusing there throws away a call somebody paid for.
       */
      it("refuses when the text the suggestion was written for is gone", async () => {
        const { agent, itemId, proposalId } = await withProposal();
        const moved = "Nous sommes fermés aujourd'hui.";
        await setItemBody(itemId, moved);

        const refused = await agent
          .post(`/api/content/${itemId}/refine/${proposalId}/accept`)
          .expect(409);

        expect(refused.body.code).toBe("refine_anchor_lost");
        const item = await agent.get(`/api/content/${itemId}`).expect(200);
        expect(item.body.body).toBe(moved);
        expect(await masterVersionRows(itemId)).toHaveLength(1);
        // Kept: rejecting an edit and accepting the proposal loses nothing.
        expect(await proposalRows(itemId)).toHaveLength(1);
      });

      /**
       * A CONSUMED PROPOSAL IS GONE, which is what makes Accept idempotent in
       * the only sense that matters: the second press cannot apply the same
       * suggestion twice.
       */
      it("answers the second accept 404, having consumed the row", async () => {
        const { agent, itemId, proposalId } = await withProposal();
        await agent.post(`/api/content/${itemId}/refine/${proposalId}/accept`).expect(200);

        const refused = await agent
          .post(`/api/content/${itemId}/refine/${proposalId}/accept`)
          .expect(404);

        expect(refused.body.code).toBe("refine_proposal_not_found");
        expect(await masterVersionRows(itemId)).toHaveLength(2);
      });

      /**
       * 404, NOT 403 — the tenancy convention of this whole suite: a stranger
       * learns nothing about what exists.
       */
      it("refuses another org's proposal id", async () => {
        const mine = await withProposal();
        const theirs = await withProposal();

        const refused = await mine.agent
          .post(`/api/content/${mine.itemId}/refine/${theirs.proposalId}/accept`)
          .expect(404);

        expect(refused.body.code).toBe("refine_proposal_not_found");
        expect(await proposalRows(theirs.itemId)).toHaveLength(1);
      });

      /**
       * AND A PROPOSAL OF THIS ORG'S OTHER DRAFT, which is the dangerous half
       * of the same predicate. Its offsets and its anchor were measured against
       * a DIFFERENT body: applied here they would splice the model's words into
       * a post nobody asked it about, and file a version row saying so.
       */
      it("refuses a proposal staged against another draft of the same org", async () => {
        const { agent, itemId } = await refinableDraft();
        const { brandId, channelId } = await brandWithChannel(agent);
        const other = await aiDraft(agent, brandId, [channelId]);
        const staged = await agent
          .post(`/api/content/${other.itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);

        const refused = await agent
          .post(`/api/content/${itemId}/refine/${staged.body.id}/accept`)
          .expect(404);

        expect(refused.body.code).toBe("refine_proposal_not_found");
        expect(await masterVersionRows(itemId)).toHaveLength(1);
        expect(await proposalRows(other.itemId)).toHaveLength(1);
      });

      /**
       * A ROW CARRYING ANOTHER ORG'S `org_id` WHILE POINTING AT THIS DRAFT —
       * the shape a writer that passed the wrong orgId leaves behind, and the
       * only thing the `org_id` predicate on these two routes actually defends
       * against.
       *
       * A stranger's 404 cannot pin it: an item belongs to one org, so
       * `content_item_id` alone already refuses every proposal a stranger could
       * name. This row is the case that predicate cannot see, and it has to be
       * planted from underneath the API because no endpoint will write it —
       * `otherOrgVersionRow` exists one table over for exactly this reason.
       */
      it("refuses a proposal row written with another org's id", async () => {
        const { agent, itemId } = await refinableDraft();
        const planted = await otherOrgProposalRow(itemId);

        const refusedAccept = await agent
          .post(`/api/content/${itemId}/refine/${planted}/accept`)
          .expect(404);
        const refusedDiscard = await agent
          .delete(`/api/content/${itemId}/refine/${planted}`)
          .expect(404);

        expect(refusedAccept.body.code).toBe("refine_proposal_not_found");
        expect(refusedDiscard.body.code).toBe("refine_proposal_not_found");
        expect(await masterVersionRows(itemId)).toHaveLength(1);
        expect(await proposalRows(itemId)).toHaveLength(1);
        // ...and it is not drawn on the screen either. A row written with the
        // wrong `org_id` must not be served as this org's own suggestion — the
        // same defence `aiVersionRows` carries one table over.
        const item = await agent.get(`/api/content/${itemId}`).expect(200);
        expect(item.body.refineProposal).toBeNull();
      });

      /**
       * The editability read at propose time is deliberately unlocked, so an
       * approval can land under a proposal. Accept re-checks under the lock —
       * and the proposal survives, because rejecting the post and accepting the
       * suggestion they already paid for must lose nothing.
       */
      it("refuses an accept on a post approval has pinned, and keeps the proposal", async () => {
        const { agent, itemId, proposalId } = await withProposal();
        await agent.post(`/api/content/${itemId}/opened`).expect(204);
        await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

        const refused = await agent
          .post(`/api/content/${itemId}/refine/${proposalId}/accept`)
          .expect(409);

        expect(refused.body.code).toBe("content_pinned_approved");
        expect(await masterVersionRows(itemId)).toHaveLength(1);
        expect(await proposalRows(itemId)).toHaveLength(1);
      });
    });

    describe("discarding what was proposed", () => {
      it("removes the row, and says nothing back", async () => {
        const { agent, itemId, proposalId } = await withProposal();

        await agent.delete(`/api/content/${itemId}/refine/${proposalId}`).expect(204);

        expect(await proposalRows(itemId)).toEqual([]);
        const item = await agent.get(`/api/content/${itemId}`).expect(200);
        expect(item.body.refineProposal).toBeNull();
        // A discard is not an edit: no version row, and the body is untouched.
        expect(item.body.body).toBe(AI_BODY);
        expect(await masterVersionRows(itemId)).toHaveLength(1);
      });

      it("answers a second discard 404", async () => {
        const { agent, itemId, proposalId } = await withProposal();
        await agent.delete(`/api/content/${itemId}/refine/${proposalId}`).expect(204);

        const refused = await agent
          .delete(`/api/content/${itemId}/refine/${proposalId}`)
          .expect(404);

        expect(refused.body.code).toBe("refine_proposal_not_found");
      });

      /**
       * NO EDITABILITY CHECK, and that is the decision rather than an
       * oversight. Discarding a suggestion changes no text: refusing it on an
       * approved post would leave a card on the screen that its own Accept
       * refuses and nothing can clear.
       */
      it("is allowed on a post approval has pinned", async () => {
        const { agent, itemId, proposalId } = await withProposal();
        await agent.post(`/api/content/${itemId}/opened`).expect(204);
        await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

        await agent.delete(`/api/content/${itemId}/refine/${proposalId}`).expect(204);

        expect(await proposalRows(itemId)).toEqual([]);
      });

      /**
       * The proposal is addressed on ONE draft, and the URL says which. A
       * suggestion staged against another post of the same org is not this
       * screen's to throw away: a card the person is reading elsewhere would
       * disappear while they read it.
       */
      it("refuses a proposal staged against another draft of the same org", async () => {
        const { agent, itemId } = await refinableDraft();
        const { brandId, channelId } = await brandWithChannel(agent);
        const other = await aiDraft(agent, brandId, [channelId]);
        const staged = await agent
          .post(`/api/content/${other.itemId}/refine`)
          .send({ verb: "shorten", ...SELECTION })
          .expect(201);

        const refused = await agent
          .delete(`/api/content/${itemId}/refine/${staged.body.id}`)
          .expect(404);

        expect(refused.body.code).toBe("refine_proposal_not_found");
        expect(await proposalRows(other.itemId)).toHaveLength(1);
      });

      it("refuses another org's proposal id, and leaves it staged", async () => {
        const mine = await withProposal();
        const theirs = await withProposal();

        const refused = await mine.agent
          .delete(`/api/content/${mine.itemId}/refine/${theirs.proposalId}`)
          .expect(404);

        expect(refused.body.code).toBe("refine_proposal_not_found");
        expect(await proposalRows(theirs.itemId)).toHaveLength(1);
      });
    });

    /**
     * THE PROPOSAL A RELOAD CAN FIND.
     *
     * A refine is paid for the moment it is staged, and until this field
     * existed the only copy of it a person ever saw was the 201 in a browser
     * tab: a reload, a crash or a second device stranded a row nothing could
     * reach, on a screen showing a draft it was written against.
     *
     * On the ITEM's own response rather than behind a `GET …/refine`, for
     * `runId`'s reason one field up: the item screen already reads and polls
     * this endpoint, so a property costs no round trip, while a second endpoint
     * would be either polled alongside it or left to go stale against the very
     * body the proposal is measured against. One request, one answer, and the
     * card and the draft cannot disagree.
     */
    describe("the proposal a reload can find", () => {
      it("carries the staged proposal on the item, exactly as propose answered it", async () => {
        const { agent, itemId, staged } = await withProposal();

        const item = await agent.get(`/api/content/${itemId}`).expect(200);

        expect(item.body.refineProposal).toEqual(staged);
      });

      it("is null on a draft with nothing staged", async () => {
        const { agent, itemId } = await refinableDraft();

        const item = await agent.get(`/api/content/${itemId}`).expect(200);

        expect(item.body.refineProposal).toBeNull();
      });

      /**
       * ...and NOT on the list rows. A queue card has no use for a proposal's
       * text, and a list that carried one would ship every staged suggestion in
       * the org to draw cards that never mention them — the same argument that
       * keeps the version bodies off the list.
       */
      it("stays off the list, which draws no proposal", async () => {
        const { agent, itemId } = await withProposal();

        const list = await agent.get("/api/content").expect(200);

        const row = (list.body as { id: string }[]).find((item) => item.id === itemId);
        expect(row).toBeDefined();
        expect(row).not.toHaveProperty("refineProposal");
      });
    });
  });

  /**
   * WHERE THE DRAFT CAME FROM.
   *
   * The item's own response carries the run's `input`, not just its id, so the
   * draft screen can say "drafted from pasted text" without a second request
   * against a run it would then have to keep in step with the item it polls.
   * The `org_id` predicate on that read is the whole of its blast radius: the
   * foreign key does not require a run and its item to share an org.
   */
  describe("the source a draft was drafted from", () => {
    const SOURCE_INPUT = {
      kind: "source" as const,
      text: "Keep it to two paragraphs.",
      sourceUrl: "https://www.example.com/news/story",
      material: "The council voted on Tuesday to fund the new library wing.",
      channelIds: [randomUUID()],
    };
    const BRIEF_INPUT = {
      kind: "brief" as const,
      text: "Write about the vote.",
      channelIds: [randomUUID()],
    };

    /**
     * A run row pointing at an item, written from underneath the API: the only
     * other way to make one is to spend money on a real generation, and the
     * cross-org case below cannot be made through the API at all.
     */
    async function seedRun(
      orgId: string,
      brandId: string,
      contentItemId: string,
      input: typeof SOURCE_INPUT | typeof BRIEF_INPUT,
      createdAt?: Date,
    ): Promise<string> {
      const { createDb, schema } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const inserted = await db
        .insert(schema.pipelineRuns)
        .values({
          orgId,
          brandId,
          contentItemId,
          input,
          status: "succeeded",
          ...(createdAt ? { createdAt } : {}),
        })
        .returning({ id: schema.pipelineRuns.id });
      await pool.end();
      return inserted[0]?.id as string;
    }

    /** An item, its brand and its org — everything a seeded run needs to name. */
    async function draftWithBrand() {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const { itemId } = await aiDraft(agent, brandId, [channelId]);
      return { agent, brandId, itemId, orgId: await orgOf(itemId) };
    }

    it("carries the pasted material and its URL, exactly as the run stored them", async () => {
      const { agent, brandId, itemId, orgId } = await draftWithBrand();
      const runId = await seedRun(orgId, brandId, itemId, SOURCE_INPUT);

      const item = await agent.get(`/api/content/${itemId}`).expect(200);

      expect(item.body.runId).toBe(runId);
      expect(item.body.runInput).toEqual(SOURCE_INPUT);
    });

    it("carries the brief arm for a run started from a brief", async () => {
      const { agent, brandId, itemId, orgId } = await draftWithBrand();
      await seedRun(orgId, brandId, itemId, BRIEF_INPUT);

      const item = await agent.get(`/api/content/${itemId}`).expect(200);

      expect(item.body.runInput).toEqual(BRIEF_INPUT);
    });

    it("is null on a hand-written draft, which no run made", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: HUMAN_BODY, channelIds: [channelId] })
        .expect(201);

      const item = await agent.get(`/api/content/${created.body.id as string}`).expect(200);

      expect(item.body.runId).toBeNull();
      expect(item.body.runInput).toBeNull();
    });

    /**
     * THE MUTATION MOST WORTH KILLING. Drop `org_id` from the join and this
     * item names a stranger's run — and hands back the text that stranger
     * pasted, on a screen that presents it as this draft's own provenance.
     */
    it("never reads a run that belongs to another org", async () => {
      const { agent, itemId } = await draftWithBrand();
      const stranger = await orgAgent();
      const strangerBrand = await brandWithChannel(stranger);
      const strangerItem = await stranger
        .post("/api/content")
        .send({
          brandId: strangerBrand.brandId,
          body: "Their own draft",
          channelIds: [strangerBrand.channelId],
        })
        .expect(201);
      const strangerOrgId = await orgOf(strangerItem.body.id as string);
      // The run points at THIS org's item from THAT org's row — the shape the
      // foreign key permits and the predicate refuses.
      await seedRun(strangerOrgId, strangerBrand.brandId, itemId, SOURCE_INPUT);

      const item = await agent.get(`/api/content/${itemId}`).expect(200);

      expect(item.body.runId).toBeNull();
      expect(item.body.runInput).toBeNull();
    });

    /**
     * THE SECOND RUN, which the column permits and the writer does not make.
     *
     * `content_item_id` carries no unique constraint, so "at most one" is a
     * fact about the writer rather than one the database enforces. Unordered,
     * this read hands back whichever row the planner reaches first — and now
     * that it returns the run's INPUT, that is not merely a link that changes
     * on refresh but a different article named as this draft's source. The
     * rows are written newest-first so that heap order and `created_at` order
     * disagree: an unordered read answers with the later one.
     */
    it("names the FIRST run of an item, not whichever row the planner reaches", async () => {
      const { agent, brandId, itemId, orgId } = await draftWithBrand();
      const later = { ...SOURCE_INPUT, material: "A later paste, from a re-run." };
      await seedRun(orgId, brandId, itemId, later, new Date("2026-08-02T00:00:00.000Z"));
      const firstRunId = await seedRun(
        orgId,
        brandId,
        itemId,
        SOURCE_INPUT,
        new Date("2026-08-01T00:00:00.000Z"),
      );

      const item = await agent.get(`/api/content/${itemId}`).expect(200);

      expect(item.body.runId).toBe(firstRunId);
      expect(item.body.runInput).toEqual(SOURCE_INPUT);
    });

    /**
     * ...and NOT on the list rows. A queue card says nothing about a source,
     * and a list that carried one would ship every open item's pasted article
     * — up to 8000 characters each — to draw cards that never mention them.
     */
    it("stays off the list, which draws no source", async () => {
      const { agent, brandId, itemId, orgId } = await draftWithBrand();
      await seedRun(orgId, brandId, itemId, SOURCE_INPUT);

      const list = await agent.get("/api/content").expect(200);

      const row = (list.body as { id: string }[]).find((item) => item.id === itemId);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("runInput");
    });
  });

  describe("coded refusals", () => {
    /** A post whose text is pinned, plus the ids to aim at it. */
    async function approvedPost(agent: request.Agent) {
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Reviewed", channelIds: [channelId] })
        .expect(201);
      await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
      return {
        brandId,
        channelId,
        itemId: created.body.id as string,
        adaptationId: created.body.adaptations[0].id as string,
      };
    }

    async function execute(statement: string) {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db.execute(statement);
      await pool.end();
    }

    it("names the pinned STATUS in the code, so no argument has to travel", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId } = await approvedPost(agent);

      const approved = await agent.patch(`/api/content/${itemId}`).send({ body: "no" }).expect(409);
      expect(approved.body.code).toBe("content_pinned_approved");
      expect(approved.body.message).toBe("Approved content cannot be edited; reject it first");

      await execute(`UPDATE adaptations SET status = 'published' WHERE id = '${adaptationId}'`);
      await execute(`UPDATE content_items SET status = 'published' WHERE id = '${itemId}'`);

      // The same request, one status later, is a DIFFERENT code — which is the
      // whole reason the status is in the code rather than in an argument: one
      // sentence cannot be true of both, in any language.
      const published = await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "no" })
        .expect(409);
      expect(published.body.code).toBe("content_pinned_published");
      expect(published.body.message).toBe(
        "This content has already been published and can no longer be edited",
      );

      const decided = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(decided.body.code).toBe("content_already_published");
    });

    it("codes a pinned channel override by its OWN status, not the item's", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId } = await approvedPost(agent);
      // Rejecting hands the item back (editable) and returns its outstanding
      // adaptations to `pending` — the partial-fan-out shape, where the item's
      // status and the row's disagree. That disagreement is the whole point of
      // the second record: `content_pinned_*` cannot answer for this row.
      await agent.post(`/api/content/${itemId}/reject`).expect(200);

      for (const [status, code] of [
        ["scheduled", "adaptation_pinned_scheduled"],
        ["queued", "adaptation_pinned_queued"],
        ["publishing", "adaptation_pinned_publishing"],
        ["published", "adaptation_pinned_published"],
      ] as const) {
        await execute(`UPDATE adaptations SET status = '${status}' WHERE id = '${adaptationId}'`);
        const refused = await agent
          .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
          .send({ body: "no" })
          .expect(409);
        expect(refused.body.code, status).toBe(code);
      }

      // The sentence is still the api's own, unchanged, beside the last code.
      const published = await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "no" })
        .expect(409);
      expect(published.body.message).toBe(
        "This channel's post has already been published and can no longer be edited",
      );
    });

    it("codes the two publish-gate refusals apart", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);

      // A body with a complete `ai` version behind it: an edit WOULD clear this.
      const editable = await aiDraft(agent, brandId, [channelId]);
      const canEdit = await agent
        .post(`/api/content/${editable.itemId}/approve`)
        .send({})
        .expect(409);
      expect(canEdit.body.code).toBe("unread_ai_draft");

      // A hand-typed body carrying AI-written channel text: there is no complete
      // `ai` version of the BODY to judge an edit against, so telling the reader
      // to edit it would be telling them to do something that cannot work.
      const deadEnd = await handTypedWithAiAdaptation(agent, brandId, [channelId]);
      const openOnly = await agent
        .post(`/api/content/${deadEnd.itemId}/approve`)
        .send({})
        .expect(409);
      expect(openOnly.body.code).toBe("unread_ai_draft_open_only");
    });

    it("codes a post whose every channel has been deleted", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({
          brandId,
          body: "Written for a channel that is about to go",
          channelIds: [channelId],
        })
        .expect(201);
      await agent.delete(`/api/channels/${channelId}`).expect(200);

      const refused = await agent
        .post(`/api/content/${created.body.id}/approve`)
        .send({})
        .expect(409);
      expect(refused.body.code).toBe("content_no_channels_left");
    });

    it("codes the rows that are simply gone", async () => {
      const agent = await orgAgent();
      const { itemId } = await approvedPost(agent);

      const missingItem = await agent.get(`/api/content/${randomUUID()}`).expect(404);
      expect(missingItem.body.code).toBe("content_not_found");

      const missingAdaptation = await agent
        .patch(`/api/content/${itemId}/adaptations/${randomUUID()}`)
        .send({ body: "no" })
        .expect(404);
      expect(missingAdaptation.body.code).toBe("adaptation_not_found");
    });

    it("codes a channel that is not this brand's", async () => {
      const agent = await orgAgent();
      const { brandId } = await brandWithChannel(agent);
      const other = await agent.post("/api/brands").send({ name: "Other" }).expect(201);
      const stranger = await agent
        .post("/api/channels")
        .send({
          brandId: other.body.id,
          platform: "telegram",
          name: "Theirs",
          credentials: { botToken: "789:ghi", chatId: "-1005555555555" },
        })
        .expect(201);

      const refused = await agent
        .post("/api/content")
        .send({ brandId, body: "Wrong brand's channel", channelIds: [stranger.body.id] })
        .expect(404);
      expect(refused.body.code).toBe("channels_not_in_brand");
    });

    /**
     * THE WIRE FIELD NAME, which is the other half of this change.
     *
     * A schedule in the past was `contentApproveSchema`'s zod refine, so the
     * reader was told "scheduledAt: scheduledAt must be in the future" — the
     * pipe's `path: message` join, wrapped around a message that names the field
     * again. It is now a domain refusal with a code, because it is a CLOCK-
     * dependent predicate rather than a shape one: a schema that passes at parse
     * time and is false a moment later at use time was never validation.
     *
     * The developer's sentence is unchanged and unprefixed; the reader gets
     * `schedule_in_past`, which says "pick a time in the future" in four
     * languages and names no field at all.
     */
    it("codes a past schedule instead of leaking the field name zod knows it by", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Scheduled for yesterday", channelIds: [channelId] })
        .expect(201);

      const refused = await agent
        .post(`/api/content/${created.body.id}/approve`)
        .send({ scheduledAt: new Date(Date.now() - 60_000).toISOString() })
        .expect(400);

      expect(refused.body.code).toBe("schedule_in_past");
      expect(refused.body.message).toBe("scheduledAt must be in the future");
      // The pipe's `field: ` prefix is gone from this path entirely — it is the
      // part a reader could never make sense of.
      expect(refused.body.message).not.toMatch(/^scheduledAt: /);

      // ...and the rule still holds: nothing was approved.
      const untouched = await agent.get(`/api/content/${created.body.id}`).expect(200);
      expect(untouched.body.status).toBe("draft");
    });

    it("codes what is left at the validation boundary, keeping the field-qualified detail for developers", async () => {
      const agent = await orgAgent();
      const { brandId } = await brandWithChannel(agent);

      const refused = await agent
        .post("/api/content")
        .send({ brandId, body: "", channelIds: [] })
        .expect(400);

      expect(refused.body.code).toBe("invalid_request");
      // Unchanged: the array, each entry still qualified by the path zod knows.
      // The reader never sees it — `Errors.invalid_request` is what renders —
      // but the network tab and the API consumer do.
      expect(Array.isArray(refused.body.message)).toBe(true);
      expect((refused.body.message as string[]).join(" ")).toMatch(/body/);
    });

    it("keeps a scheduled approval working, so the refusal is about the time and not about scheduling", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Scheduled for later", channelIds: [channelId] })
        .expect(201);

      const approved = await agent
        .post(`/api/content/${created.body.id}/approve`)
        .send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
        .expect(200);
      expect(approved.body.adaptations[0].status).toBe("scheduled");
    });
  });

  /**
   * A DELIVERY NOBODY CAN SPEAK FOR, AND THE PERSON WHO SETTLES IT.
   *
   * `deliveryOutcome` made an unknown ending VISIBLE — two sentences on two
   * screens telling a reader to open the channel before approving again. This
   * block is about the half that was still missing: advice is not a control.
   * The adaptation column has no `unknown`, so such a row read `failed` and
   * `approve` re-sent it like any other, putting a second copy of one post in
   * somebody's channel from a single press.
   *
   * The refusal and its resolver are tested together because they only make
   * sense together. Refusing alone would leave the post finishable only by
   * deleting the channel: nothing else in the product moves a row off
   * `failed`+unknown.
   */
  describe("settling a delivery nobody can speak for", () => {
    /**
     * A second channel on the same brand, so a fan-out can have one half in
     * doubt and one half provably undelivered — the shape the whole per-row
     * argument rests on.
     */
    async function secondChannel(agent: request.Agent, brandId: string): Promise<string> {
      const channel = await agent
        .post("/api/channels")
        .send({
          brandId,
          platform: "telegram",
          name: "Second",
          credentials: { botToken: "456:def", chatId: "-1009876543210" },
        })
        .expect(201);
      return channel.body.id as string;
    }

    /**
     * What `PublishService.recordUnknownOutcome` leaves behind: the adaptation
     * `failed` with the operator's sentence, and the attempt's receipt resolved
     * to `unknown` with no link. Seeded directly, as every worker-shaped
     * fixture in this file is.
     */
    async function seedDelivery(adaptationId: string, status: "unknown" | "failed" | "published") {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id, channel_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string; channel_id: string }[];
      await db.execute(
        `UPDATE adaptations SET status = '${status === "published" ? "published" : "failed"}',
           last_error = ${status === "published" ? "NULL" : "'the worker wrote a sentence here'"}
         WHERE id = '${adaptationId}'`,
      );
      await db.execute(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
         VALUES ('${row?.org_id}', '${adaptationId}', '${row?.channel_id}', '${status}', NULL, NULL, 1)`,
      );
      await pool.end();
    }

    async function seedPartialTelegram(adaptationId: string) {
      await seedDelivery(adaptationId, "unknown");
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE publications SET partial_photo_id = '4711',
           partial_photo_url = 'https://t.me/mychannel/4711',
           partial_followup_text = 'Frozen missing reply',
           partial_followup_outcome = 'rejected'
         WHERE adaptation_id = '${adaptationId}' AND status = 'unknown'`,
      );
      await pool.end();
    }

    /** The receipts of one adaptation, oldest first — what was actually filed. */
    async function receipts(adaptationId: string) {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const { rows } = await db.execute(
        `SELECT status, external_url, asserted_by FROM publications
          WHERE adaptation_id = '${adaptationId}' ORDER BY created_at, id`,
      );
      await pool.end();
      return rows as { status: string; external_url: string | null; asserted_by: string | null }[];
    }

    /** The organisation a post belongs to, for a read that has no session. */
    async function orgOf(itemId: string): Promise<string> {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const { rows } = await db.execute(`SELECT org_id FROM content_items WHERE id = '${itemId}'`);
      await pool.end();
      return (rows[0] as { org_id: string }).org_id;
    }

    /**
     * The person who settled this delivery, deleted — through the foreign keys
     * rather than around them, which is the whole point: `ON DELETE SET NULL`
     * is what the receipt is then left holding.
     */
    async function deleteAsserter(adaptationId: string): Promise<void> {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const { rowCount } = await db.execute(
        `DELETE FROM "user" WHERE id IN (
           SELECT asserted_by FROM publications
            WHERE adaptation_id = '${adaptationId}' AND asserted_by IS NOT NULL)`,
      );
      await pool.end();
      if (rowCount !== 1) throw new Error(`expected one asserter to delete, deleted ${rowCount}`);
    }

    async function itemStatus(itemId: string): Promise<string> {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const { rows } = await db.execute(`SELECT status FROM content_items WHERE id = '${itemId}'`);
      await pool.end();
      return (rows[0] as { status: string }).status;
    }

    /** A two-channel post, approved and then landed however the caller says. */
    async function fanOut(agent: request.Agent) {
      const { brandId, channelId } = await brandWithChannel(agent);
      const other = await secondChannel(agent, brandId);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Two channels, one answer missing", channelIds: [channelId, other] })
        .expect(201);
      const adaptations = created.body.adaptations as { id: string; channelId: string }[];
      return {
        itemId: created.body.id as string,
        inDoubt: adaptations.find((a) => a.channelId === channelId)?.id as string,
        refused: adaptations.find((a) => a.channelId === other)?.id as string,
      };
    }

    /** One channel, one delivery, whatever ending the caller seeds onto it. */
    async function oneChannel(agent: request.Agent) {
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Maybe out there", channelIds: [channelId] })
        .expect(201);
      return {
        itemId: created.body.id as string,
        adaptationId: created.body.adaptations[0].id as string,
        channelId,
      };
    }

    it.each([
      [true, "completed", "published"],
      [false, "removed", "failed"],
    ] as const)(
      "requires explicit %s recovery for a Telegram partial delivery",
      async (delivered, partialResolution, expectedStatus) => {
        const agent = await orgAgent();
        const { itemId, adaptationId } = await oneChannel(agent);
        await seedPartialTelegram(adaptationId);

        const detail = await agent.get(`/api/content/${itemId}`).expect(200);
        expect(detail.body.adaptations[0].partialTelegram).toEqual({
          photoId: "4711",
          photoUrl: "https://t.me/mychannel/4711",
          followupText: "Frozen missing reply",
          followupOutcome: "rejected",
        });
        expect(detail.body.adaptations[0].deliveryOutcome).toBe("partial");
        const frozenItem = await agent
          .patch(`/api/content/${itemId}`)
          .send({ body: "Changed after the photo went live" })
          .expect(409);
        expect(frozenItem.body.code).toBe("partial_telegram_unresolved");
        const frozenChannel = await agent
          .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
          .send({ body: "Changed after the photo went live" })
          .expect(409);
        expect(frozenChannel.body.code).toBe("partial_telegram_unresolved");
        for (const kind of ["cover", "video"] as const) {
          const frozenMedia = await agent
            .patch(`/api/media/posts/${itemId}/${kind}`)
            .send({ mediaId: null })
            .expect(409);
          expect(frozenMedia.body.code).toBe("partial_telegram_unresolved");
        }
        const premature = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
        expect(premature.body.code).toBe("delivery_outcome_unknown");
        expect(await publishJobCount(adaptationId)).toBe(0);

        await agent
          .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
          .send({ delivered })
          .expect(409);
        await agent
          .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
          .send({ delivered, partialResolution: delivered ? "removed" : "completed" })
          .expect(409);

        const settled = await agent
          .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
          .send({ delivered, partialResolution })
          .expect(200);
        expect(settled.body.adaptations[0].status).toBe(expectedStatus);
        expect(settled.body.adaptations[0].partialTelegram).toBeNull();
        expect(settled.body.adaptations[0].externalUrl).toBe(
          delivered ? "https://t.me/mychannel/4711" : null,
        );
        expect((await receipts(adaptationId)).map((receipt) => receipt.status)).toEqual([
          "unknown",
          expectedStatus,
        ]);
        if (delivered) {
          await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
          expect(await publishJobCount(adaptationId)).toBe(0);
        } else {
          await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
          expect(await publishJobCount(adaptationId)).toBe(1);
        }
      },
    );

    /**
     * THE SKIP IS PER ROW, and this is the test that says so.
     *
     * A four-channel post with one unknown half still has halves that provably
     * failed, and refusing the whole request would leave the reader no way to
     * send them. Mutating the skip to the ITEM — refuse if ANY row is unknown —
     * makes the second channel unsendable; mutating it away entirely re-sends
     * the first and posts the second copy this whole design exists to stop.
     * Both are caught here, by the two job counts together.
     */
    it("re-sends the halves that failed and leaves the half in doubt alone", async () => {
      const agent = await orgAgent();
      const { itemId, inDoubt, refused } = await fanOut(agent);
      await seedDelivery(inDoubt, "unknown");
      await seedDelivery(refused, "failed");

      const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      const byId = Object.fromEntries(
        (approved.body.adaptations as { id: string; status: string }[]).map((a) => [
          a.id,
          a.status,
        ]),
      );
      expect(byId[refused]).toBe("queued");
      // Untouched: still the row nobody can speak for, still reported as such.
      expect(byId[inDoubt]).toBe("failed");

      expect(await publishJobCount(refused)).toBe(1);
      expect(await publishJobCount(inDoubt)).toBe(0);
    });

    /**
     * A TIMED APPROVE IS NOT ALLOWED TO SKIP A CHANNEL AT ALL.
     *
     * "Publish now" skipping one row is honest: the other rows go now, the
     * skipped one is reported as it was, and nothing was promised about it. A
     * request that names a TIME is a different promise — it is the one
     * `requireScheduleReachesEveryChannel` exists to keep, and the reader is
     * told the post goes out, whole, at that moment. Skipping a row behind a
     * 200 there says the schedule reaches every channel when it does not, which
     * is the standard that guard sets (and the standard `requireAdaptations`
     * and the refusal below set): no success for work that was not done.
     *
     * Refused rather than half-scheduled, and asserted through the queue: a
     * mutation that answers 200 leaves the unknown row unqueued either way, so
     * only the OTHER channel's job count tells the two apart.
     */
    it("refuses to schedule a post one of whose channels it would skip", async () => {
      const agent = await orgAgent();
      const { itemId, inDoubt, refused } = await fanOut(agent);
      await seedDelivery(inDoubt, "unknown");
      await seedDelivery(refused, "failed");

      const refusal = await agent
        .post(`/api/content/${itemId}/approve`)
        .send({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })
        .expect(409);
      expect(refusal.body.code).toBe("delivery_outcome_unknown");
      expect(await publishJobCount(refused)).toBe(0);
      expect(await publishJobCount(inDoubt)).toBe(0);
      expect(await itemStatus(itemId)).toBe("draft");
    });

    /**
     * AND WHEN THE SKIP LEAVES NOTHING, IT REFUSES rather than answering 200.
     *
     * This project's own named defect class — an early exit reporting the same
     * success as real work — and the expensive half of it here: the reader
     * presses "Publish now", is told the post is on its way, and nothing was
     * sent. Both halves are asserted, because a mutation that turns the refusal
     * into a 200 leaves the queue exactly as empty as a correct refusal does.
     */
    it("refuses when the only delivery left is one nobody can speak for, and enqueues nothing", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId } = await oneChannel(agent);
      await seedDelivery(adaptationId, "unknown");

      const refusal = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(refusal.body.code).toBe("delivery_outcome_unknown");
      expect(await publishJobCount(adaptationId)).toBe(0);
      expect(await itemStatus(itemId)).toBe("draft");
    });

    /**
     * "MARK AS DELIVERED" — a receipt in the ordinary shape, with one extra
     * column.
     *
     * The receipt is what every downstream reader already understands: the
     * worker's duplicate guard refuses to send where a `published` receipt
     * exists, and `deliveryOutcome` stops saying `unknown` because the last
     * FINISHED receipt now says `published`. `asserted_by` is the only thing
     * that distinguishes it from a platform's own answer, and the DTO field
     * below is what makes dropping it visible: without the column the screen
     * renders a person's word as "published — link unavailable", claiming a
     * confirmation nobody ever got.
     */
    it("records a human's word as a published receipt that names them", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId } = await oneChannel(agent);
      await seedDelivery(adaptationId, "unknown");

      const settled = await agent
        .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
        .send({ delivered: true })
        .expect(200);

      const adaptation = settled.body.adaptations[0];
      expect(adaptation.status).toBe("published");
      expect(adaptation.deliveryOutcome).toBe("published");
      // No link, and none invented: nobody ever had one.
      expect(adaptation.externalUrl).toBeNull();
      expect(adaptation.assertedByName).toBe("U");
      expect(typeof adaptation.assertedAt).toBe("string");
      // The operator's "outcome could not be confirmed" sentence is gone: after
      // this call it can be, and printing it under the answer would contradict it.
      expect(adaptation.lastError).toBeNull();

      const filed = await receipts(adaptationId);
      expect(filed.map((r) => r.status)).toEqual(["unknown", "published"]);
      expect(filed[1]?.asserted_by).not.toBeNull();
      expect(filed[1]?.external_url).toBeNull();

      // The item follows the fold, exactly as a landing delivery would.
      expect(await itemStatus(itemId)).toBe("published");
    });

    /**
     * AND THE FACT OUTLIVES THE ACCOUNT THAT VOUCHED FOR IT.
     *
     * `asserted_by` is `ON DELETE SET NULL` on purpose — the receipt outlives
     * what it points at — and the migration's own argument is that what a
     * departure costs is the NAME, not the fact. That argument is only true if
     * the fact is recorded somewhere the delete cannot reach, which is why
     * `asserted_at` is its own column rather than `created_at` read through the
     * pointer: gated on `asserted_by`, the timestamp dies with the account and
     * the screen falls back to "published — link unavailable" — the
     * platform-confirmed delivery this whole column exists to stop the product
     * claiming.
     *
     * Read through the repository rather than over HTTP for a reason that is
     * the test's own subject: deleting the person cascades their session away,
     * so there is no cookie left to read with. It is the same method the
     * controller calls.
     */
    it("still says a person settled the delivery once their account is deleted", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId } = await oneChannel(agent);
      await seedDelivery(adaptationId, "unknown");
      await agent
        .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
        .send({ delivered: true })
        .expect(200);

      const orgId = await orgOf(itemId);
      await deleteAsserter(adaptationId);
      expect((await receipts(adaptationId))[1]?.asserted_by).toBeNull();

      const { ContentRepository } = await import("./content.repository");
      const item = await app.get(ContentRepository).get(orgId, itemId);
      const adaptation = item.adaptations[0];

      // The name is gone, as `SET NULL` says it should be.
      expect(adaptation?.assertedByName).toBeNull();
      // The fact is not: a person said this post is live, on this date, and the
      // screen says so instead of claiming a platform confirmed it.
      expect(adaptation?.assertedAt).not.toBeNull();
      expect(adaptation?.externalUrl).toBeNull();
      expect(adaptation?.deliveryOutcome).toBe("published");
    });

    /**
     * AND THE POST CANNOT THEN BE SENT AGAIN. The adaptation is `published`,
     * which is history — `approve` does not target it, and an item every one of
     * whose channels is published is refused outright.
     *
     * The worker's own half of this guard (`hasPublished`, which reads the
     * receipt rather than the column) is pinned in the worker's spec, where the
     * code is.
     */
    it("closes the post to further sending once a person has said it is live", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId } = await oneChannel(agent);
      await seedDelivery(adaptationId, "unknown");
      await agent
        .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
        .send({ delivered: true })
        .expect(200);

      const refusal = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(409);
      expect(refusal.body.code).toBe("content_already_published");
      expect(await publishJobCount(adaptationId)).toBe(0);
    });

    /**
     * "MARK AS NOT DELIVERED" — the other verdict, and the one that gives the
     * post back.
     *
     * The adaptation stays `failed`, so nothing about it is claimed; what
     * changes is that its last FINISHED receipt no longer says `unknown`, which
     * is the exact expression `approve`'s skip consults. The second press then
     * sends the post for the first time.
     */
    it("puts a delivery nothing reached back within reach of Publish now", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId } = await oneChannel(agent);
      await seedDelivery(adaptationId, "unknown");

      const settled = await agent
        .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
        .send({ delivered: false })
        .expect(200);
      expect(settled.body.adaptations[0].status).toBe("failed");
      expect(settled.body.adaptations[0].deliveryOutcome).toBe("failed");
      expect(settled.body.adaptations[0].assertedByName).toBe("U");
      // Every delivery of this item has now failed for good, so the fold fails
      // the item — the second of today's two verdicts, reached from the api.
      expect(await itemStatus(itemId)).toBe("failed");

      const filed = await receipts(adaptationId);
      expect(filed.map((r) => r.status)).toEqual(["unknown", "failed"]);
      expect(filed[1]?.asserted_by).not.toBeNull();

      const approved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      expect(approved.body.adaptations[0].status).toBe("queued");
      // And the delivery in flight is described by ITSELF, not by the attempt
      // whose answer never came: the human's `failed` receipt is now the last
      // finished one, so nothing is left saying `unknown` about this send.
      expect(approved.body.adaptations[0].deliveryOutcome).toBe("queued");
      expect(await publishJobCount(adaptationId)).toBe(1);
    });

    /**
     * A DELIVERY WHOSE OUTCOME IS NOT IN DOUBT HAS NOTHING FOR A PERSON TO SAY.
     *
     * Two codes rather than one with an argument: the codes here are nullary
     * and named by state, so one cannot mean both "in doubt" and "not in
     * doubt". This is also the refusal the loser of two simultaneous presses
     * gets — see the race below.
     */
    it("refuses a verdict about a delivery the record already answers for", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId } = await oneChannel(agent);
      await seedDelivery(adaptationId, "failed");

      const refusal = await agent
        .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
        .send({ delivered: true })
        .expect(409);
      expect(refusal.body.code).toBe("delivery_outcome_already_known");
      expect(await receipts(adaptationId)).toHaveLength(1);
    });

    /**
     * AND A DELIVERY THAT HAS NOT ENDED YET is refused with the code for the
     * status it is actually in — the same records `PATCH`'s override refusal
     * reads, so the two routes cannot answer differently about one row.
     * Asserting an outcome for an attempt still in flight is asserting about
     * the wrong attempt.
     */
    it("refuses a verdict about a delivery that is still on its way", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId } = await oneChannel(agent);
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);

      const refusal = await agent
        .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
        .send({ delivered: true })
        .expect(409);
      expect(refusal.body.code).toBe("adaptation_pinned_queued");
      expect(await receipts(adaptationId)).toHaveLength(0);
    });

    /** Tenancy, on the route that files evidence — a stranger's row is not there. */
    it("does not exist for another organization", async () => {
      const owner = await orgAgent();
      const { itemId, adaptationId } = await oneChannel(owner);
      await seedDelivery(adaptationId, "unknown");

      const stranger = await orgAgent();
      const refusal = await stranger
        .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
        .send({ delivered: true })
        .expect(404);
      expect(refusal.body.code).toBe("adaptation_not_found");
      expect(await receipts(adaptationId)).toHaveLength(1);
    });

    /**
     * TWO PRESSES ON ONE ROW, AND THE LOSER GETS A SENTENCE RATHER THAN A 500.
     *
     * Both requests read an outcome of `unknown` if nothing serialises them,
     * both write a `published` receipt, and the second meets
     * `publications_one_published_per_adaptation` as a raw `23505` — a 500 for
     * a request whose only fault is being second. The row lock is what makes
     * the loser wait; re-reading the outcome in its OWN statement afterwards is
     * what makes it see the winner's commit, because under READ COMMITTED a
     * statement's snapshot is taken when the statement starts and a read fused
     * into the locking SELECT would answer from before the wait.
     *
     * The interleaving is pinned rather than hoped for: a third connection
     * holds the adaptation row, so both requests are parked on it before either
     * can read anything.
     */
    it("serialises two simultaneous verdicts on one delivery", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId } = await oneChannel(agent);
      await seedDelivery(adaptationId, "unknown");

      const { createDb } = await import("@pubrick/db");
      const { pool } = createDb(url as string);
      const holder = await pool.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM adaptations WHERE id = $1 FOR UPDATE", [adaptationId]);

      const press = () =>
        agent
          .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
          .send({ delivered: false });
      const both = Promise.all([press(), press()]);
      try {
        await waitForAdaptationRowWaiters(2, both);
      } finally {
        await holder.query("COMMIT");
        holder.release();
        await pool.end();
      }

      const [first, second] = await both;
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = first.status === 409 ? first : second;
      expect(loser.body.code).toBe("delivery_outcome_already_known");
      // ONE verdict was filed, not two. Without the lock both presses read
      // `unknown`, both file a receipt, and the count is three.
      expect((await receipts(adaptationId)).map((r) => r.status)).toEqual(["unknown", "failed"]);
    });

    /**
     * THE RESOLVER AGAINST A LANDING WORKER, on the same adaptation.
     *
     * The two take the same locks in the same order —
     * `adaptations` → the `publications` insert's `FOR KEY SHARE` on
     * `channels` → `content_items` — which is the whole reason the resolver
     * needed no new lock and no new edge in `docs/lock-order.md`. Taken the
     * other way round they are a cycle, and a cycle here is a `40P01` on a
     * request that is merely simultaneous.
     *
     * The worker's half is written out as its own transaction rather than
     * driven through the worker package, because what is under test is the
     * ORDER of the statements, and a paused transaction between two of them is
     * something no real handler can be asked for.
     */
    it("does not deadlock against a delivery landing at the same moment", async () => {
      const agent = await orgAgent();
      const { itemId, adaptationId, channelId } = await oneChannel(agent);
      await seedDelivery(adaptationId, "unknown");

      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string }[];

      const worker = await pool.connect();
      await worker.query("BEGIN");
      // `markPublished`'s first statement, and its row lock.
      await worker.query("UPDATE adaptations SET status = 'published' WHERE id = $1", [
        adaptationId,
      ]);

      const settling = agent
        .post(`/api/content/${itemId}/adaptations/${adaptationId}/delivery`)
        .send({ delivered: false });
      try {
        await waitForAdaptationRowWaiters(1, settling);
        // The rest of the worker's transaction, in its documented order:
        // the receipt (which locks the channel through its foreign key), then
        // the parent item.
        await worker.query(
          `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_url, attempt)
             VALUES ($1, $2, $3, 'published', 'https://t.me/c/9', 2)`,
          [row?.org_id, adaptationId, channelId],
        );
        await worker.query("SELECT id FROM content_items WHERE id = $1 FOR UPDATE", [itemId]);
      } finally {
        await worker.query("COMMIT");
        worker.release();
        await pool.end();
      }

      // No 40P01 on either side. The resolver was parked before the worker's
      // second statement, so it loses and is told what the delivery turned out
      // to be — a coded refusal, never a deadlock and never a 500.
      const answered = await settling;
      expect(answered.status).toBe(409);
      expect(answered.body.code).toBe("adaptation_pinned_published");
    });
  });
  /**
   * A POST WHOSE CHANNELS DISAGREED — the status, and the two doors it changes.
   *
   * Two channels approved together, one live and one permanently refused, used
   * to leave `content_items.status` at `approved` for ever: neither `every` in
   * the recompute was satisfied, so nothing was written, and nothing else in
   * the product recomputes an item. The reader saw the blue of work in flight
   * under the queue's "Approved" heading, for a post that was as finished as it
   * was ever going to get on its own.
   *
   * What changes on this tier is TWO things, and they pull in opposite
   * directions on purpose: the text becomes editable WITHOUT a reject, and
   * reject stops being able to call the live post off. Both are here because
   * either one alone is a corner — an editable post nobody can correct the
   * channel of, or a refusal with no way out.
   *
   * Reject splits rather than simply refusing, which the first version of this
   * gate did not: with a send still outstanding it cancels that send (the only
   * such control the product has) and the item lands `partially_published`;
   * with nothing outstanding there is nothing to cancel and it is a 409.
   */
  describe("a post whose channels disagreed", () => {
    /** A second channel on the same brand: a fan-out needs two halves. */
    async function secondChannel(agent: request.Agent, brandId: string): Promise<string> {
      const channel = await agent
        .post("/api/channels")
        .send({
          brandId,
          platform: "telegram",
          name: "Second",
          credentials: { botToken: "456:def", chatId: "-1009876543210" },
        })
        .expect(201);
      return channel.body.id as string;
    }

    /** A two-channel post, approved — the shape the worker then lands on. */
    async function fanOut(agent: request.Agent) {
      const { brandId, channelId } = await brandWithChannel(agent);
      const other = await secondChannel(agent, brandId);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Two channels, one answer", channelIds: [channelId, other] })
        .expect(201);
      const adaptations = created.body.adaptations as { id: string; channelId: string }[];
      await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
      return {
        itemId: created.body.id as string,
        live: adaptations.find((a) => a.channelId === channelId)?.id as string,
        other: adaptations.find((a) => a.channelId === other)?.id as string,
      };
    }

    /**
     * What the worker leaves behind for one delivery: the adaptation's own
     * status and the attempt's receipt. Seeded directly, as every worker-shaped
     * fixture in this file is — there is no worker in an api e2e, and the
     * worker's own half of this rule (a landing delivery reaching the same
     * verdict, and the retry that promotes the item to `published`) is pinned
     * in `publish.repository.spec.ts`.
     */
    async function seedDelivery(
      adaptationId: string,
      status: "published" | "failed" | "unknown",
    ): Promise<void> {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const [row] = (
        await db.execute(`SELECT org_id, channel_id FROM adaptations WHERE id = '${adaptationId}'`)
      ).rows as { org_id: string; channel_id: string }[];
      await db.execute(
        `UPDATE adaptations SET status = '${status === "published" ? "published" : "failed"}'
          WHERE id = '${adaptationId}'`,
      );
      await db.execute(
        `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
         VALUES ('${row?.org_id}', '${adaptationId}', '${row?.channel_id}', '${status}',
                 ${status === "published" ? "'99', 'https://t.me/x/99'" : "NULL, NULL"}, 1)`,
      );
      // AND THE JOB IS GONE, because the worker consumed it. Without this the
      // fixture is a shape the product never produces — a finished delivery
      // whose publish job is still queued — and a later approve meets
      // `publishJobId`'s duplicate refusal instead of re-sending.
      await db.execute(
        `DELETE FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
      );
      await pool.end();
    }

    /**
     * The pg-boss states of one adaptation's publish jobs.
     *
     * NOT `publishJobCount`: `cancel` does not delete the row, it moves the
     * state out of the fetchable set and leaves the id behind (which is the
     * whole reason `reject` bumps `attempt_count`). Counting rows therefore
     * cannot tell a cancelled job from a live one — it answers 1 either way —
     * so a cancel that never ran would pass unnoticed. The state is the fact.
     */
    async function publishJobStates(adaptationId: string): Promise<string[]> {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const jobs = await db.execute(
        `SELECT state FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
      );
      await pool.end();
      return (jobs.rows as { state: string }[]).map((row) => row.state);
    }

    async function itemStatus(itemId: string): Promise<string> {
      const { createDb } = await import("@pubrick/db");
      const { db, pool } = createDb(url as string);
      const { rows } = await db.execute(`SELECT status FROM content_items WHERE id = '${itemId}'`);
      await pool.end();
      return (rows[0] as { status: string }).status;
    }

    /**
     * THE WHOLE ROUTE, from a fan-out that disagreed to the retry that fixes
     * it, through the doors a person actually has.
     *
     * The promotion here is the API'S OWN — the resolver settling the delivery
     * nobody could speak for, then asking `nextItemStatus` under the parent
     * lock exactly as a landing delivery does. That is what makes this an
     * end-to-end rather than a fixture: no SQL writes `partially_published`
     * anywhere in this test.
     *
     * And every consequence is asserted in the same place, because each one
     * alone can be satisfied by a different mistake: the item READS
     * `partially_published` and is LISTED under it, the text is editable with
     * no reject, reject refuses, and the approve that follows re-sends the
     * refused channel ONLY — the live one is not in `approve`'s target set and
     * cannot be sent twice.
     */
    it("reads partly published, stays editable, refuses reject, and re-sends only the channel that failed", async () => {
      const agent = await orgAgent();
      const { itemId, live, other } = await fanOut(agent);
      await seedDelivery(live, "published");
      // The second attempt never came back, so only a person can say what
      // happened — and they say it did not arrive.
      await seedDelivery(other, "unknown");

      const settled = await agent
        .post(`/api/content/${itemId}/adaptations/${other}/delivery`)
        .send({ delivered: false })
        .expect(200);
      expect(settled.body.status).toBe("partially_published");
      expect(await itemStatus(itemId)).toBe("partially_published");

      const listed = await agent.get("/api/content?status=partially_published").expect(200);
      expect((listed.body as { id: string }[]).map((row) => row.id)).toContain(itemId);

      // Editable with no reject — which is the only way left to correct the
      // text, now that reject is closed on a post with a live channel.
      const patched = await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "Short enough now" })
        .expect(200);
      expect(patched.body.body).toBe("Short enough now");
      expect(patched.body.status).toBe("partially_published");

      // REFINE FOLLOWS EDITING through the same predicate
      // (`pinnedItemRefusal`, shared by `update` and `refinableItem`), so the
      // status gate must ADMIT this item. It is refused for an unrelated
      // reason — no model wrote anything here — and that refusal is the proof
      // the status gate passed: a pinned item answers `content_pinned_*`
      // before the AI-draft check is ever reached.
      const refineRefusal = await agent
        .post(`/api/content/${itemId}/refine`)
        .send({ verb: "shorten", start: 0, end: 5 })
        .expect(409);
      expect(refineRefusal.body.code).toBe("refine_needs_ai_draft");

      const refusal = await agent.post(`/api/content/${itemId}/reject`).send({}).expect(409);
      // Its own code: this item is `partially_published`, not `published`, and
      // the approve below is the action the reader is being pointed at.
      expect(refusal.body.code).toBe("content_partially_published");
      expect(await itemStatus(itemId)).toBe("partially_published");

      const reApproved = await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      const byId = Object.fromEntries(
        (reApproved.body.adaptations as { id: string; status: string }[]).map((a) => [
          a.id,
          a.status,
        ]),
      );
      expect(byId[other]).toBe("queued");
      expect(byId[live]).toBe("published");
      expect(await publishJobCount(other)).toBe(1);
      expect(await publishJobCount(live)).toBe(0);
      // Back to work in flight while that retry is out, and the worker promotes
      // it to `published` when it lands (`publish.repository.spec.ts`).
      expect(await itemStatus(itemId)).toBe("approved");
    });

    /**
     * THE REACH OF THE REJECT GATE IS THE ADAPTATION, AND WHAT IT DOES THERE
     * SPLITS ON WHETHER ANYTHING IS STILL GOING OUT.
     *
     * This item's own status is `approved`: only one of its two channels has
     * published, so nothing has promoted it and nothing will until the second
     * delivery ends. A gate that reads `content_items.status` sees `approved`,
     * passes, and writes `rejected` over a post that is live in someone's
     * channel, with the only writer that could undo it (a delivery) already
     * spent on the half that succeeded. That is why the gate asks about the
     * adaptations.
     *
     * But the first version of that gate REFUSED this state, and this is the
     * state where refusing costs the most: the second channel has a live
     * pg-boss job, and `reject`'s cancel loop is the only control in this
     * product that can stop it — while the refusal's own sentence told the
     * reader that nothing would re-send it and they need do nothing. So the
     * reject is accepted here and does exactly what it has always done to an
     * outstanding delivery, and only the ITEM's new status is new.
     */
    it("cancels the channel still on its way out, keeps the live one, and says partly published", async () => {
      const agent = await orgAgent();
      const { itemId, live, other } = await fanOut(agent);
      await seedDelivery(live, "published");

      const rejected = await agent.post(`/api/content/${itemId}/reject`).send({}).expect(200);
      expect(rejected.body.status).toBe("partially_published");
      expect(await itemStatus(itemId)).toBe("partially_published");

      // The job can no longer be fetched by a worker — the whole point of
      // accepting — and the row is back to "waiting for a person", which is
      // what `pending` means.
      expect(await publishJobStates(other)).toEqual(["cancelled"]);
      const byId = Object.fromEntries(
        (rejected.body.adaptations as { id: string; status: string }[]).map((a) => [
          a.id,
          a.status,
        ]),
      );
      expect(byId[other]).toBe("pending");
      // NOT touched: rejecting cannot un-send a post that is in someone's
      // channel, and this row is the reason the item is not `rejected`.
      expect(byId[live]).toBe("published");
    });

    /**
     * A DELAYED SEND IS A SEND. `scheduled` is in
     * `OUTSTANDING_ADAPTATION_STATUSES` for the same reason `queued` is — a
     * pg-boss job exists — and it is the shape where "leaving it as it is
     * stops it" would be most obviously false: the job is sitting on a
     * `startAfter` days away with nobody watching.
     */
    it("cancels a scheduled channel too, while another is already live", async () => {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const other = await secondChannel(agent, brandId);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "Two channels, one answer", channelIds: [channelId, other] })
        .expect(201);
      const adaptations = created.body.adaptations as { id: string; channelId: string }[];
      const liveId = adaptations.find((a) => a.channelId === channelId)?.id as string;
      const otherId = adaptations.find((a) => a.channelId === other)?.id as string;
      await agent
        .post(`/api/content/${created.body.id}/approve`)
        .send({ scheduledAt: new Date(Date.now() + 86_400_000).toISOString() })
        .expect(200);
      await seedDelivery(liveId, "published");

      const rejected = await agent
        .post(`/api/content/${created.body.id}/reject`)
        .send({})
        .expect(200);
      expect(rejected.body.status).toBe("partially_published");
      expect(await publishJobStates(otherId)).toEqual(["cancelled"]);
      const byId = Object.fromEntries(
        (rejected.body.adaptations as { id: string; status: string }[]).map((a) => [
          a.id,
          a.status,
        ]),
      );
      expect(byId[otherId]).toBe("pending");
      expect(byId[liveId]).toBe("published");
    });
  });

  describe("editor-side channel adaptation", () => {
    async function setup() {
      const agent = await orgAgent();
      const { brandId, channelId } = await brandWithChannel(agent);
      const created = await agent
        .post("/api/content")
        .send({ brandId, body: "A saved source post.", channelIds: [channelId] })
        .expect(201);
      const itemId = created.body.id as string;
      const adaptationId = created.body.adaptations[0].id as string;
      await agent
        .put("/api/ai-credentials")
        .send({ provider: "google", apiKey: "sk-live-never-leak-this-0123456789" })
        .expect(200);
      return { agent, itemId, adaptationId, orgId: await orgOf(itemId) };
    }

    it("stages a durable suggestion, meters its channel, and accepts it as a new AI version", async () => {
      const { agent, itemId, adaptationId, orgId } = await setup();
      readaptOutcome = {
        ...readaptOutcome,
        usage: [
          {
            ...refineUsage(),
            attribution: {
              step: "readapt",
              channelId: (await agent.get(`/api/content/${itemId}`).expect(200)).body.adaptations[0]
                .channelId,
            },
          },
        ],
      };
      const path = `/api/content/${itemId}/adaptations/${adaptationId}/readapt`;
      const first = await agent
        .post(path)
        .send({ body: "Client text must be ignored" })
        .expect(201);
      expect(readaptCalls).toHaveLength(1);
      expect(readaptCalls[0]).toMatchObject({
        masterBody: "A saved source post.",
        previousBody: null,
      });
      expect(first.body.proposal).toBe("A concise channel post, written by the model.");
      const before = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(before.body.adaptations[0].body).toBeNull();
      expect(before.body.adaptationProposals).toContainEqual(first.body);
      expect((await ledgerRows(orgId)).at(-1)).toMatchObject({ step: "readapt", adaptationId });

      const accepted = await agent.post(`${path}/${first.body.id}/accept`).expect(200);
      expect(accepted.body.adaptations[0]).toMatchObject({
        body: first.body.proposal,
        origin: "ai",
      });
      expect(accepted.body.adaptationProposals).toEqual([]);
      const versions = await agent
        .get(`/api/content/${itemId}/versions?adaptationId=${adaptationId}`)
        .expect(200);
      expect(versions.body[0]).toMatchObject({ body: first.body.proposal, origin: "ai" });
      await agent.post(`${path}/${first.body.id}/accept`).expect(404);
    });

    it("reattaches the managed tags exactly once after a channel re-adaptation", async () => {
      const { agent, itemId, adaptationId } = await setup();
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({
          body: "Earlier channel text",
          hashtags: ["one", "two"],
          expectedHashtags: [],
          cta: "Ask a question",
          expectedCta: null,
        })
        .expect(200);
      readaptOutcome = {
        ok: true,
        text: "A revised channel post.\n\n#one #two",
        reason: "Shorter",
        usage: [],
      };
      const path = `/api/content/${itemId}/adaptations/${adaptationId}/readapt`;
      const staged = await agent.post(path).expect(201);
      const accepted = await agent.post(`${path}/${staged.body.id}/accept`).expect(200);
      expect(accepted.body.adaptations[0]).toMatchObject({
        body: "A revised channel post.\n\n#one #two",
        hashtags: ["one", "two"],
        cta: "Ask a question",
      });
      const history = await agent
        .get(`/api/content/${itemId}/versions?adaptationId=${adaptationId}`)
        .expect(200);
      expect(history.body[0]).toMatchObject({
        body: "A revised channel post.\n\n#one #two",
        hashtags: ["one", "two"],
        cta: "Ask a question",
        origin: "ai",
      });
    });

    it("keeps a different authored tag paragraph when re-adaptation retains it", async () => {
      const { agent, itemId, adaptationId } = await setup();
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "Earlier channel text", hashtags: ["one", "two"], expectedHashtags: [] })
        .expect(200);
      readaptOutcome = {
        ok: true,
        text: "A revised channel post.\n\n#organic",
        reason: "Keep the author's tag",
        usage: [],
      };
      const path = `/api/content/${itemId}/adaptations/${adaptationId}/readapt`;
      const staged = await agent.post(path).expect(201);
      const accepted = await agent.post(`${path}/${staged.body.id}/accept`).expect(200);
      expect(accepted.body.adaptations[0].body).toBe(
        "A revised channel post.\n\n#organic\n\n#one #two",
      );
    });

    it("refuses a re-adaptation that contains only the carried-over managed tags", async () => {
      const { agent, itemId, adaptationId } = await setup();
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "Earlier channel text", hashtags: ["one", "two"], expectedHashtags: [] })
        .expect(200);
      readaptOutcome = {
        ok: true,
        text: "#one #two",
        reason: "Only tags",
        usage: [],
      };
      const path = `/api/content/${itemId}/adaptations/${adaptationId}/readapt`;
      const staged = await agent.post(path).expect(201);
      await agent.post(`${path}/${staged.body.id}/accept`).expect(400);
      const unchanged = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(unchanged.body.adaptations[0].body).toBe("Earlier channel text\n\n#one #two");
      expect(unchanged.body.adaptationProposals[0].id).toBe(staged.body.id);
    });

    it("refuses a re-adaptation whose managed tags exceed the channel limit", async () => {
      const { agent, itemId, adaptationId } = await setup();
      await agent
        .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
        .send({ body: "Earlier channel text", hashtags: ["news"], expectedHashtags: [] })
        .expect(200);
      readaptOutcome = {
        ok: true,
        text: "x".repeat(adaptationLimit("telegram") ?? MAX_BODY_LENGTH),
        reason: "Long proposal",
        usage: [],
      };
      const path = `/api/content/${itemId}/adaptations/${adaptationId}/readapt`;
      const staged = await agent.post(path).expect(201);
      await agent.post(`${path}/${staged.body.id}/accept`).expect(400);
      const unchanged = await agent.get(`/api/content/${itemId}`).expect(200);
      expect(unchanged.body.adaptations[0].body).toBe("Earlier channel text\n\n#news");
    });

    it("keeps a paid suggestion on failed retries and refuses stale acceptance", async () => {
      const { agent, itemId, adaptationId } = await setup();
      const path = `/api/content/${itemId}/adaptations/${adaptationId}/readapt`;
      const first = await agent.post(path).expect(201);
      readaptOutcome = { ok: false, failure: "failed", usage: [] };
      await agent.post(path).expect(409);
      expect(
        (await agent.get(`/api/content/${itemId}`).expect(200)).body.adaptationProposals[0].id,
      ).toBe(first.body.id);
      await agent
        .patch(`/api/content/${itemId}`)
        .send({ body: "A changed source post." })
        .expect(200);
      const stale = await agent.post(`${path}/${first.body.id}/accept`).expect(409);
      expect(stale.body.code).toBe("readapt_source_changed");
      await agent.delete(`${path}/${first.body.id}`).expect(204);
      expect(
        (await agent.get(`/api/content/${itemId}`).expect(200)).body.adaptationProposals,
      ).toEqual([]);
    });

    it("stages a paid answer even when the source changes while the model is answering", async () => {
      const { agent, itemId, adaptationId } = await setup();
      readaptDuringCall = async () => {
        await agent
          .patch(`/api/content/${itemId}`)
          .send({ body: "Changed while the model was answering." })
          .expect(200);
      };
      const path = `/api/content/${itemId}/adaptations/${adaptationId}/readapt`;
      const staged = await agent.post(path).expect(201);
      expect(staged.body.masterBody).toBe("A saved source post.");
      expect(
        (await agent.get(`/api/content/${itemId}`).expect(200)).body.adaptationProposals[0].id,
      ).toBe(staged.body.id);
      const refused = await agent.post(`${path}/${staged.body.id}/accept`).expect(409);
      expect(refused.body.code).toBe("readapt_source_changed");
    });

    it("scopes proposals to the organization and refuses pinned channels before spending", async () => {
      const { agent, itemId, adaptationId } = await setup();
      const path = `/api/content/${itemId}/adaptations/${adaptationId}/readapt`;
      const staged = await agent.post(path).expect(201);
      const other = await orgAgent();
      await other.post(`${path}/${staged.body.id}/accept`).expect(404);
      await other.delete(`${path}/${staged.body.id}`).expect(404);
      const calls = readaptCalls.length;
      await agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
      await agent.post(path).expect(409);
      expect(readaptCalls).toHaveLength(calls);
      await agent.post(`${path}/${staged.body.id}/accept`).expect(409);
      await agent.delete(`${path}/${staged.body.id}`).expect(204);
    });
  });
});
