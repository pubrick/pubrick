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

  /** Every statement the api's pool issues while `run` is in flight. */
  async function countingStatements<T>(run: () => Promise<T>): Promise<[T, string[]]> {
    const seen: string[] = [];
    const original = pool.query.bind(pool);
    pool.query = (...args: unknown[]) => {
      const first = args[0];
      seen.push(
        typeof first === "string" ? first : String((first as { text?: string })?.text ?? first),
      );
      return original(...args);
    };
    try {
      return [await run(), seen];
    } finally {
      pool.query = original;
    }
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
    const contentStatements = statements.filter((text) =>
      /content_items|adaptations|content_versions/.test(text),
    );
    expect(contentStatements).toHaveLength(3);
    expect(contentStatements.filter((text) => /from "adaptations"/i.test(text))).toHaveLength(1);

    /**
     * THE SORT, AS TEXT — the one assertion in this repository's tests that
     * reads a statement instead of its answer, and it is here because the
     * index this commit adds is what makes the behavioural test unable to see
     * the clause.
     *
     * `content_items_org_id_created_at_id_idx` leads on `org_id` and continues
     * `created_at DESC, id DESC`, so an org-scoped read of this table plans as
     * an Index Only Scan over it and comes back SORTED whether or not anybody
     * asked (measured with `EXPLAIN` on the seed this file leaves behind:
     * `Index Only Scan using content_items_org_id_created_at_id_idx`). Delete
     * the `ORDER BY` and every row-order assertion in `content.e2e.spec.ts`
     * still passes — on this data, on this planner, today. That is precisely
     * the property the clause exists to stop relying on: the planner is free to
     * seq-scan the moment the statistics, the filter or the index change, and
     * "which items" becomes a correctness question the moment 0009's second
     * commit puts a `LIMIT` over it.
     *
     * So the order is pinned where it cannot coincide with the planner's:
     * in the statement the repository actually sends.
     */
    const itemsStatement = contentStatements.find((text) => /from "content_items"/i.test(text));
    expect(itemsStatement).toMatch(/order by .*"created_at" desc.*"id" desc/i);
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
});
