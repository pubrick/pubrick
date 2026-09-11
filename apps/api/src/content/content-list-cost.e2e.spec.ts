import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const APP_NAME = "content-list-cost-e2e";
const appUrl = url ? `${url}${url.includes("?") ? "&" : "?"}application_name=${APP_NAME}` : url;

/**
 * HOW MUCH ONE QUEUE PAGE COSTS — the two numbers that grow with the size of an
 * organisation's queue, pinned so a change that makes either grow again fails
 * here rather than on somebody's laptop a year from now.
 *
 * Design 0009 measured the shape this file replaces through the real route: at
 * 500 items the response was 503 statements and 774 722 bytes, ~110 ms warm,
 * because `list` ran one adaptations query PER ITEM and shipped every item's
 * `body` to draw a badge that never reads it. Both numbers are linear in the
 * item count and neither is bounded by anything — the queue holds every draft
 * an org has ever made — and the browser re-reads the whole list every five
 * seconds while anything is publishing.
 *
 * TWO ASSERTIONS, BECAUSE THEY FAIL FOR DIFFERENT REASONS.
 *
 * - The statement count catches a read that scales with the page: it is 3 for
 *   any N (items, their item-level `ai` version rows, their adaptations), and
 *   the bound is 4 so that one honest extra query is not a test edit while 203
 *   is a failure.
 * - The byte bound catches a column nobody reads coming back onto the list.
 *   `body` alone was 44 % of the measured response.
 *
 * The count is of statements THIS REQUEST issues against the api's one shared
 * pool, which is also better-auth's and every repository's — so the session
 * read and the membership check are in it too, and that is deliberate: what the
 * pool's ten clients see is the number that matters (a queued thousand degrades
 * every other request in the process), not the subset one class issued.
 */
describe.skipIf(!url)("the cost of one queue list", () => {
  let app: INestApplication;
  /**
   * The api's shared pool, as the only thing this file needs of it. `pg` is not
   * a dependency of `apps/api` (it arrives through `@pubrick/db`), so the type
   * is written structurally rather than imported.
   */
  let pool: { query: (...args: unknown[]) => unknown };

  /** Long enough to be the dominant term, as the measured bodies were. */
  const BODY = "Nous ouvrons à sept heures et le café est déjà prêt. ".repeat(13).trim();
  const ITEMS = 200;
  const CHANNELS_PER_ITEM = 2;

  beforeAll(async () => {
    process.env.DATABASE_URL = appUrl as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    // The api's OWN pool, after `DATABASE_URL` is set — the same module instance
    // the repositories and the auth adapter hold, which is what makes counting
    // its `query` calls a measurement of the request rather than of a fixture.
    pool = (await import("../db")).pool as unknown as typeof pool;
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgAgent(): Promise<{ agent: request.Agent; orgId: string }> {
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
    return { agent, orgId: created.body.id as string };
  }

  /**
   * A queue of `ITEMS` drafts, each with two pending adaptations and one
   * item-level `ai` version row — the shape design 0009 measured.
   *
   * Two hundred rows go in through drizzle rather than through two hundred
   * `POST /api/content` round trips: the create path is exercised by
   * `content.e2e.spec.ts` in every one of its tests, and what this file is
   * about is what the READ costs once the rows exist. One create is still made
   * through the route, so the columns these inserts fill are the ones the real
   * writer fills.
   */
  async function seedQueue(agent: request.Agent, orgId: string): Promise<void> {
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const channelIds: string[] = [];
    for (let index = 0; index < CHANNELS_PER_ITEM; index += 1) {
      const channel = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name: `Channel ${index}`,
          credentials: { botToken: "123:abc", chatId: `-100123456789${index}` },
        })
        .expect(201);
      channelIds.push(channel.body.id as string);
    }
    await agent
      .post("/api/content")
      .send({ brandId: brand.body.id, title: "Through the route", body: BODY, channelIds })
      .expect(201);

    const { createDb, schema } = await import("@pubrick/db");
    const seed = createDb(url as string);
    try {
      const items = await seed.db
        .insert(schema.contentItems)
        .values(
          Array.from({ length: ITEMS - 1 }, (_unused, index) => ({
            orgId,
            brandId: brand.body.id as string,
            title: `Draft ${index}`,
            body: BODY,
            origin: "ai" as const,
          })),
        )
        .returning({ id: schema.contentItems.id });
      await seed.db.insert(schema.adaptations).values(
        items.flatMap((item) =>
          channelIds.map((channelId) => ({
            orgId,
            contentItemId: item.id,
            channelId,
            origin: "ai" as const,
          })),
        ),
      );
      await seed.db.insert(schema.contentVersions).values(
        items.map((item) => ({
          orgId,
          contentItemId: item.id,
          adaptationId: null,
          body: BODY,
          origin: "ai" as const,
        })),
      );
    } finally {
      await seed.pool.end();
    }
  }

  /**
   * A THOUSAND BARE ITEMS FOR ONE ORG — no adaptations, no version rows, short
   * bodies. What the plan test needs is SIZE, not shape.
   *
   * The size is load-bearing and the number is not arbitrary. A planner picks
   * between seeking this index and bitmap-scanning `content_items_org_id_idx`
   * then sorting, and that choice is a cost comparison: on the 200-item seed
   * above the two are close enough that the answer moves with the table's
   * statistics — which drift as every other spec in this suite inserts into the
   * same shared table (measured: the same assertion passed three times and
   * failed the fourth). At a thousand, sorting the organisation to return fifty
   * rows is not close, and the test is measuring the index rather than the
   * autovacuum daemon. It is still UNFORCED — no `enable_*` is touched, because
   * a coerced planner proves only that it was coerced.
   */
  async function seedBareQueue(orgId: string, agent: request.Agent): Promise<void> {
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const { createDb, schema } = await import("@pubrick/db");
    const seed = createDb(url as string);
    try {
      await seed.db.insert(schema.contentItems).values(
        Array.from({ length: 1000 }, (_unused, index) => ({
          orgId,
          brandId: brand.body.id as string,
          title: `Draft ${index}`,
          body: "Deux mots.",
        })),
      );
    } finally {
      await seed.pool.end();
    }
  }

  /**
   * Every statement the api's pool issues while `run` is in flight, with the
   * values bound to it — the values because the plan of a statement is not a
   * property of its text alone, and the EXPLAIN below re-issues the real one.
   */
  type Statement = { text: string; values: unknown[] };
  async function countingStatements<T>(run: () => Promise<T>): Promise<[T, Statement[]]> {
    const seen: Statement[] = [];
    const original = pool.query.bind(pool);
    pool.query = (...args: unknown[]) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : String((first as { text?: string })?.text ?? first);
      const values = Array.isArray(args[1])
        ? (args[1] as unknown[])
        : ((first as { values?: unknown[] })?.values ?? []);
      seen.push({ text, values });
      return original(...args);
    };
    try {
      return [await run(), seen];
    } finally {
      pool.query = original;
    }
  }

  /** The rows of `EXPLAIN <statement>`, joined — the plan as the planner prints it. */
  async function explain(statement: Statement, suffix: string): Promise<string> {
    const explained = (await pool.query({
      text: `EXPLAIN ${statement.text}${suffix}`,
      values: statement.values,
    })) as { rows: Record<string, string>[] };
    return explained.rows.map((row) => row["QUERY PLAN"]).join("\n");
  }

  /**
   * `?limit=200` RATHER THAN THE DEFAULT 50, and that is the honest question
   * now that the list is bounded: what the pool and the wire see is the BIGGEST
   * page this api will ever answer, and `MAX_CONTENT_PAGE_SIZE` is what makes
   * that a finite number to measure. A default-sized page would make every
   * bound below four times slacker for free.
   */
  it("answers the biggest page the api allows in a bounded number of statements, without the bodies", async () => {
    const { agent, orgId } = await orgAgent();
    await seedQueue(agent, orgId);

    const [response, statements] = await countingStatements(() =>
      agent.get(`/api/content?limit=${ITEMS}`).expect(200),
    );
    const rows = response.body as { id: string; adaptations: unknown[] }[];
    expect(rows).toHaveLength(ITEMS);
    // The seed is exactly one page, so there is no next one — and the header is
    // absent rather than empty. A cursor on the last page is a `Load more` that
    // never goes away and one more read that always answers `[]`.
    expect(response.headers["x-next-cursor"]).toBeUndefined();
    expect(rows.every((row) => row.adaptations.length === CHANNELS_PER_ITEM)).toBe(true);

    // Was 203 for this seed (3 + one per item) before design 0009's first
    // commit; the whole point is that it no longer mentions `ITEMS` at all.
    const contentStatements = statements.filter((statement) =>
      /content_items|adaptations|content_versions/.test(statement.text),
    );
    expect(contentStatements).toHaveLength(3);
    expect(
      contentStatements.filter((statement) => /from "adaptations"/i.test(statement.text)),
    ).toHaveLength(1);

    /**
     * THE BIND PARAMETERS DO NOT GROW WITH THE PAGE EITHER.
     *
     * Three statements for any N is only half a bound: drizzle's `inArray`
     * emits `in ($2, $3, …)`, one placeholder per id, so the batched reads that
     * replaced the fan-out still carried a parameter per card. Postgres caps a
     * statement at 65 535 of them, which turns a long enough queue from slow
     * into a hard failure — and `list` has no `LIMIT` until 0009's cursor
     * lands, so nothing bounds the count but the size of the organisation.
     * Both page-sized reads send the ids as ONE array parameter instead.
     *
     * Measured on this 200-item seed: 2 values for the adaptations read
     * (the org, the ids) and 3 for the versions read (the org, the ids, the
     * `ai` origin). The bound is a little above both so that one honest extra
     * predicate is not a test edit, while a parameter per row is a failure.
     */
    for (const statement of contentStatements) {
      expect(statement.values.length, statement.text).toBeLessThanOrEqual(4);
    }

    /**
     * THE SORT, AS TEXT — the one assertion in this repository's tests that
     * reads a statement instead of its answer.
     *
     * It is here because a row order is not evidence of an `ORDER BY`: the
     * plan this statement gets is data-dependent, and on the seed this file
     * leaves behind it is a `Bitmap Heap Scan` plus a `Sort` (measured), so
     * the order the rows arrive in is an accident of the plan and would go on
     * looking deliberate with the clause deleted. The pin is on the statement
     * the repository actually sends, where no planner can stand in for it.
     *
     * ANCHORED AT THE TAIL, and that is the load-bearing part. Unanchored,
     * `order by .*created_at desc.*id desc` also matches
     * `ORDER BY updated_at DESC, created_at DESC, id DESC` — a live defect
     * shape, since `updated_at` moves on every save and the queue would
     * reshuffle whenever anybody edited a draft. The `$` says these two keys
     * are the WHOLE order, not its tail.
     *
     * It holds only while drizzle emits the statement on one line: `.` does
     * not cross a newline, so a formatter change here is a failing test rather
     * than a silent one. That is the bet, stated.
     *
     * THE `limit` IS PART OF THE PIN, in the same anchored breath. The two
     * belong together: an order with no bound is a promise about drawing and a
     * bound with no order is an arbitrary subset of the organisation's drafts
     * (design 0009 §4, "T3 first"). Anchoring past it also keeps the `$` doing
     * its original job — saying these two keys are the WHOLE order — now that
     * something follows them.
     */
    const itemsStatement = contentStatements.find((statement) =>
      /from "content_items"/i.test(statement.text),
    ) as Statement;
    expect(itemsStatement.text).toMatch(
      /order by "content_items"\."created_at" desc, "content_items"\."id" desc limit \$\d+$/i,
    );
    // The whole request, session read and membership check included: four,
    // measured, of which one is not this repository's. It was 203 for this
    // seed. The bound rather than an equality because the one statement this
    // route does not own belongs to better-auth.
    expect(statements.length).toBeLessThanOrEqual(4);

    // 324 108 bytes before, 171 508 after, measured on this seed: the bodies
    // were 47 % of it. The bound is round and above the measurement, so that a
    // column added to a card costs a decision rather than a test edit, while
    // putting `body` back fails outright.
    expect(Buffer.byteLength(response.text)).toBeLessThan(200_000);
    expect(response.text).not.toContain(BODY.slice(0, 40));
  });

  /**
   * A FULL PAGE OF IDS IN ONE PARAMETER, AND THE RIGHT ROWS COME BACK.
   *
   * The bound above says the parameter count does not grow; this says the array
   * that replaced the placeholders is actually serialised, cast and matched
   * correctly at the largest id set this api can be asked to build — an
   * `= any($1::uuid[])` that breaks on quoting, or a cast that matches nothing,
   * is invisible on a page small enough to eyeball.
   *
   * IT USED TO SEND A THOUSAND, and the reason it no longer can is the point of
   * this commit rather than a weakening: `MAX_CONTENT_PAGE_SIZE` refuses any
   * `limit` above 200, so Postgres's 65 535-parameter cliff — the failure the
   * array form was introduced to walk back from — is now out of reach by
   * construction instead of by however many drafts an organisation happens to
   * own. What is left to prove is the serialisation, at the biggest page there
   * is. The org still HOLDS a thousand items, so the page is a page and not the
   * whole table, and the cursor says so.
   *
   * Bodies of two words and one adaptation on one item, because what is under
   * test is the id set, not the response size: both page-sized reads receive
   * 200 ids, and the one item that owns a channel must come back with it while
   * the other 199 come back with an empty strip. That item is created LAST, so
   * the newest-first order puts it on the page under test.
   */
  it("matches a full page of ids through one array parameter", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Only",
        credentials: { botToken: "123:abc", chatId: "-1001111111111" },
      })
      .expect(201);

    const { createDb, schema } = await import("@pubrick/db");
    const seed = createDb(url as string);
    try {
      await seed.db.insert(schema.contentItems).values(
        Array.from({ length: 999 }, (_unused, index) => ({
          orgId,
          brandId: brand.body.id as string,
          title: `Draft ${index}`,
          body: "Deux mots.",
        })),
      );
    } finally {
      await seed.pool.end();
    }

    const created = await agent
      .post("/api/content")
      .send({
        brandId: brand.body.id,
        title: "Owns the channel",
        body: "Deux mots.",
        channelIds: [channel.body.id],
      })
      .expect(201);

    const [response, statements] = await countingStatements(() =>
      agent.get("/api/content?limit=200").expect(200),
    );
    const rows = response.body as { id: string; adaptations: unknown[] }[];
    expect(rows).toHaveLength(200);
    expect(response.headers["x-next-cursor"]).toBeDefined();
    for (const statement of statements) {
      expect(statement.values.length, statement.text).toBeLessThanOrEqual(4);
    }
    const withChannel = rows.filter((row) => row.adaptations.length > 0);
    expect(withChannel.map((row) => row.id)).toEqual([created.body.id]);
  });

  /**
   * THE INDEX CAN SERVE THE SORT — asked of the planner, not of the schema, and
   * now of the statement a SECOND PAGE really sends.
   *
   * `content_items_org_id_created_at_id_idx` (migration 0020) exists to be the
   * queue's order. Whether it can be is not a matter of which columns it names:
   * a btree is usable for an `ORDER BY` only when the NULLS placement agrees as
   * well as the direction, and `DESC` in a query means `DESC NULLS FIRST` while
   * drizzle's `.desc()` in a schema emits `DESC NULLS LAST`. Declared the
   * second way, this index was unusable for this statement — measured on this
   * machine, with `enable_sort` off so nothing else could win:
   *
   *     Sort  (cost=10000001024.93..10000001026.22)
   *       Sort Key: created_at DESC, id DESC
   *       ->  Bitmap Heap Scan using content_items_org_id_idx
   *
   * TWO THINGS ARE ASKED HERE, AND ONLY THE SECOND ONE COULD BE ASKED BEFORE
   * THE CURSOR LANDED. The first is the one this test was written for: under a
   * `LIMIT`, an index whose nulls placement disagrees leaves a `Sort` that
   * orders the WHOLE organisation's queue before taking fifty rows, which is
   * the opposite of what a bounded page is for. The second is new, and it is
   * about the keyset predicate rather than the order: `(created_at, id) < (a,
   * b)` is written as a ROW COMPARISON precisely because Postgres can match one
   * against a multicolumn btree. Spelled the equivalent way — `created_at < a
   * OR (created_at = a AND id < b)` — it is a filter, and the plan stops being
   * a seek. Nothing but a plan can tell those two spellings apart; they return
   * the same rows.
   *
   * UNFORCED, and it is the statement the repository REALLY SENT, with its real
   * bound values, taken from a page-two request rather than reconstructed here:
   * a hand-written EXPLAIN would be a test of the test's idea of the query.
   * Drop the index, write the order with a NULLS placement it does not carry,
   * or expand the row comparison into a disjunction, and a `Sort` or a `Filter`
   * appears here.
   */
  it("plans a keyset page as a seek of the index built for it", async () => {
    const { agent, orgId } = await orgAgent();
    await seedBareQueue(orgId, agent);

    const first = await agent.get("/api/content?limit=50").expect(200);
    const cursor = first.headers["x-next-cursor"] as string;
    expect(cursor).toBeDefined();

    const [, statements] = await countingStatements(() =>
      agent.get(`/api/content?limit=50&cursor=${cursor}`).expect(200),
    );
    const itemsStatement = statements.find((statement) =>
      /from "content_items"/i.test(statement.text),
    ) as Statement;
    expect(itemsStatement).toBeDefined();
    // The cursor's two values are bound to it, which is what makes the EXPLAIN
    // below a plan of the page rather than of the unbounded read.
    expect(itemsStatement.text).toMatch(/< \(\$\d+::timestamptz, \$\d+::uuid\)/i);

    // The planner's choice is a cost comparison, and a cost is computed from
    // statistics. Fresh rows the autovacuum daemon has not reached yet would
    // make this assertion a measurement of timing.
    await pool.query("ANALYZE content_items");
    const plan = await explain(itemsStatement, "");

    expect(plan).toContain("content_items_org_id_created_at_id_idx");
    // Not `toContain("Index Scan")`: what is being asserted is the ABSENCE of
    // the sort, which is the whole of what the index buys.
    expect(plan).not.toMatch(/\bSort\b/);
    // ...and the absence of a re-check: a keyset predicate the index cannot
    // carry comes back as a `Filter` over rows the scan had to visit anyway,
    // which is the disjunction spelling passing for the row comparison.
    expect(plan).not.toMatch(/\bFilter\b/);
  });
});
