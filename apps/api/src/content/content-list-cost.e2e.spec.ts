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

  it("answers a 200-item queue in a bounded number of statements, without the bodies", async () => {
    const { agent, orgId } = await orgAgent();
    await seedQueue(agent, orgId);

    const [response, statements] = await countingStatements(() =>
      agent.get("/api/content").expect(200),
    );
    const rows = response.body as { id: string; adaptations: unknown[] }[];
    expect(rows).toHaveLength(ITEMS);
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
     */
    const itemsStatement = contentStatements.find((statement) =>
      /from "content_items"/i.test(statement.text),
    ) as Statement;
    expect(itemsStatement.text).toMatch(
      /order by "content_items"\."created_at" desc, "content_items"\."id" desc$/i,
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
   * THE INDEX CAN SERVE THE SORT — asked of the planner, not of the schema.
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
   * The index it is declared as now (`DESC NULLS FIRST`, which is what a bare
   * `DESC` is) seeks:
   *
   *     Limit  (cost=0.41..190.13 rows=50)
   *       ->  Index Scan using content_items_org_id_created_at_id_idx
   *
   * WITH A `LIMIT`, AND UNFORCED, because that is the honest question. The
   * statement `list` sends today has no bound: reading a whole organisation's
   * items with `body` among the columns, a sort of the heap is genuinely
   * cheaper than seeking the index for every row (561 against 774 on this
   * seed), so a no-`Sort` assertion on the unbounded statement could only be
   * had by switching the alternatives off — proving the planner was coerced,
   * not that the index is right. The bound is what 0009's cursor adds next, and
   * under it the difference is total: with the NULLS mismatch, `LIMIT 50`
   * still sorts the whole organisation's queue first.
   *
   * So: the statement the repository really sent, its real bound values, plus
   * the page T2 will take. Drop the index, or write the query's order with a
   * NULLS placement the index does not carry, and a `Sort` reappears here.
   */
  it("plans the queue's order as a seek of the index built for it", async () => {
    const { agent, orgId } = await orgAgent();
    await seedQueue(agent, orgId);

    const [, statements] = await countingStatements(() => agent.get("/api/content").expect(200));
    const itemsStatement = statements.find((statement) =>
      /from "content_items"/i.test(statement.text),
    ) as Statement;
    expect(itemsStatement).toBeDefined();

    // The planner's choice is a cost comparison, and a cost is computed from
    // statistics. Fresh rows the autovacuum daemon has not reached yet would
    // make this assertion a measurement of timing.
    await pool.query("ANALYZE content_items");
    const plan = await explain(itemsStatement, " limit 50");

    expect(plan).toContain("content_items_org_id_created_at_id_idx");
    // Not `toContain("Index Scan")`: what is being asserted is the ABSENCE of
    // the sort, which is the whole of what the index buys.
    expect(plan).not.toMatch(/\bSort\b/);
  });
});
